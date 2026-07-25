/**
 * Inbox Store — 收件箱台账（spec §3.1）：`<dataDir>/inbox/inbox.jsonl`，
 * append-only、按 id latest-wins。
 *
 * 三条硬约束：
 * 1. **永久台账**：digested/rejected 记录不物理删除——可追溯 + 「一键重新入库」都靠它，
 *    所以本模块不提供任何删除 API。
 * 2. **append 必须 fsync**：TG offset 推进纪律（§2.1）以「item 落盘成功」为前提，
 *    停在页缓存里的一行不算落盘，崩溃就等于丢消息。
 * 3. **dataDir 由调用方传入**：worker 固定落 targetWorkspaceId 指定的工作区，
 *    不跟随「当前工作区」，所以这里不解析默认目录。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeTextForHash } from "./url-canonical.js";

/** 状态语义拆三种，不共用 failed（§3.1）：rejected 确定性拒绝、blocked 等外部条件、failed 可重试故障 */
export type InboxStatus = "pending" | "fetching" | "digested" | "failed" | "blocked" | "rejected";
/** `both` 判定的断点续做 checkpoint（§3.1）——重试从断点续，不重复落卡 */
export type InboxStage = "card_done" | "topic_done";
export type InboxSource = "telegram" | "extension";
export type InboxVerdict = "inspiration" | "exemplar" | "both" | "unusable";
/** 回执独立于消化结果：发失败只标记，不回滚消化（§2.1） */
export type ReceiptStatus = "pending" | "sent" | "failed";

export interface InboxItem {
  id: string;
  url?: string;
  text?: string;
  /** 幂等键：解重定向后按域规范化（url-canonical）；纯文字笔记无此字段 */
  canonicalUrl?: string;
  /** 创始人备注，单独字段——绝不与抓取内容拼接（§3.6 注入防护） */
  note?: string;
  source: InboxSource;
  /** 回执回给谁：后台任务完成时靠 item 自身字段定位，不依赖内存态（§2.1） */
  chatId?: number;
  updateId?: number;
  receivedAt: string;
  status: InboxStatus;
  stage?: InboxStage;
  verdict?: InboxVerdict;
  /** 落点 id（topic-xxx / pat-xxx），供收件箱视图跳转 */
  targetIds?: string[];
  errorCode?: string;
  failReason?: string;
  retryable?: boolean;
  attempts: number;
  /** fetching 的 lease 起点；崩溃后靠它回收（§3.1） */
  claimedAt?: string;
  receiptStatus?: ReceiptStatus;
}

/** 新建 item：id/receivedAt/status/attempts 有默认值，其余按来源填 */
export type NewInboxItem = Omit<InboxItem, "id" | "receivedAt" | "status" | "attempts"> &
  Partial<Pick<InboxItem, "id" | "receivedAt" | "status" | "attempts">>;

/** 补丁：身份三件套（id/receivedAt/source）不可改写 */
export type InboxPatch = Partial<Omit<InboxItem, "id" | "receivedAt" | "source">>;

const INBOX_DIR = "inbox";
const INBOX_FILE = "inbox.jsonl";

/** 纯文字笔记查重窗口（§2.1）：同一条随手记 7 天内视为重复 */
export const TEXT_NOTE_DEDUPE_DAYS = 7;

/**
 * 合法迁移表。digested/rejected 回 pending 是「一键重新入库 / 人工翻案」的唯一入口；
 * fetching → pending 是 lease 回收。同态自转（如只改 receiptStatus）由 canTransition 放行。
 */
export const INBOX_TRANSITIONS: Record<InboxStatus, InboxStatus[]> = {
  pending: ["fetching", "blocked", "rejected"],
  fetching: ["digested", "failed", "blocked", "rejected", "pending"],
  digested: ["pending"],
  failed: ["fetching", "pending"],
  blocked: ["fetching", "pending"],
  rejected: ["pending"],
};

export function canTransition(from: InboxStatus, to: InboxStatus): boolean {
  return from === to || INBOX_TRANSITIONS[from].includes(to);
}

function inboxPath(dataDir: string): string {
  return path.join(dataDir, INBOX_DIR, INBOX_FILE);
}

async function readJournal(dataDir: string): Promise<InboxItem[]> {
  let raw: string;
  try {
    raw = await fs.readFile(inboxPath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const items: InboxItem[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as InboxItem;
      // 单行损坏（崩在写一半）不应清空整个读视图，也不该让半条记录冒充 item
      if (parsed && typeof parsed.id === "string") items.push(parsed);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return items;
}

/** 唯一写入口：append + fsync。目录每次 ensure，成本可忽略、省掉冷启动分支 */
async function appendRecord(item: InboxItem, dataDir: string): Promise<void> {
  await fs.mkdir(path.join(dataDir, INBOX_DIR), { recursive: true });
  const fh = await fs.open(inboxPath(dataDir), "a");
  try {
    await fh.writeFile(JSON.stringify(item) + "\n", "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function appendItem(input: NewInboxItem, dataDir: string): Promise<InboxItem> {
  const item: InboxItem = {
    ...input,
    id: input.id ?? `inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    status: input.status ?? "pending",
    attempts: input.attempts ?? 0,
  };
  await appendRecord(item, dataDir);
  return item;
}

/**
 * 读-改-append。传 `undefined` 的字段会被清掉（JSON 不序列化 undefined），
 * lease 释放就靠 `{ claimedAt: undefined }`。
 *
 * 状态非法迁移直接抛——写入方（worker）永远不该产出非法迁移，静默吞下去等于
 * 让台账开始说谎；UI 侧请先用 canTransition 判断再调。
 */
export async function updateItem(
  id: string,
  patch: InboxPatch,
  dataDir: string,
): Promise<InboxItem | null> {
  const current = await getItem(id, dataDir);
  if (!current) return null;
  if (patch.status && !canTransition(current.status, patch.status)) {
    throw new Error(
      `收件箱状态迁移非法：${current.status} → ${patch.status}（item ${id}），` +
        `允许：${INBOX_TRANSITIONS[current.status].join("、") || "无"}`,
    );
  }
  const next: InboxItem = {
    ...current,
    ...patch,
    id: current.id,
    receivedAt: current.receivedAt,
    source: current.source,
  };
  await appendRecord(next, dataDir);
  return next;
}

/**
 * latest-wins 读视图，**按 receivedAt 升序**（老的在前）。
 * 队列语义要 FIFO：启动补扫、doctor 的「最老 pending 时长」、查重取最早那条都吃这个序；
 * 收件箱视图要「新的在前」自己 reverse。
 */
export async function listItems(dataDir: string): Promise<InboxItem[]> {
  const journal = await readJournal(dataDir);
  const byId = new Map<string, InboxItem>();
  for (const item of journal) byId.set(item.id, item);
  return [...byId.values()].sort(
    (a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id),
  );
}

export async function getItem(id: string, dataDir: string): Promise<InboxItem | null> {
  const journal = await readJournal(dataDir);
  for (let i = journal.length - 1; i >= 0; i--) {
    if (journal[i].id === id) return journal[i];
  }
  return null;
}

/** 查重命中返回**最早**收录的那条——回执要指向原件，不是后来的重复件 */
export async function findByCanonicalUrl(
  canonicalUrl: string,
  dataDir: string,
): Promise<InboxItem | null> {
  if (!canonicalUrl) return null;
  const items = await listItems(dataDir);
  return items.find((it) => it.canonicalUrl === canonicalUrl) ?? null;
}

/**
 * 纯文字笔记查重：hash 由 normalizeTextForHash 现算，不在 item 上冗余存字段
 * （归一化规则一旦改，冗余字段会变成对不上的历史包袱）。
 * receivedAt 解析不出来的记录视为落在窗口外——宁可重复一次，不可错判为重复。
 */
export async function findByTextHash(
  textHash: string,
  dataDir: string,
  windowDays: number = TEXT_NOTE_DEDUPE_DAYS,
): Promise<InboxItem | null> {
  if (!textHash) return null;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const items = await listItems(dataDir);
  return (
    items.find(
      (it) =>
        typeof it.text === "string" &&
        Date.parse(it.receivedAt) >= cutoff &&
        normalizeTextForHash(it.text) === textHash,
    ) ?? null
  );
}
