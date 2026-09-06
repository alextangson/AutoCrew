/**
 * 每日选题摘要的纯函数层（每日选题摘要 spec §2.1/§2.2/§2.4）——
 * 选谁、写成什么样、回一个数字算什么，全在这里，一次 I/O 都不做。
 *
 * 三条纪律：
 * 1. **不重排**（§2.1）：雷达入库时已按相关度过门，这里沿用入库顺序（createdAt 升序），
 *    再排一次等于用一个更弱的信号覆盖一个更强的。
 * 2. **发得出去比发得全重要**（§2.2）：标题 60、理由 80、整条 3500 字封顶
 *    （Telegram 上限 4096）。超长时从尾部丢条目——但**丢掉的绝不能留在清单里**，
 *    否则用户回那个数字会得到「超范围」。所以排版是一次函数：文本与「真正发出去的
 *    那几条」同源产出（`layoutDigest`），调用方按后者记 lastDigest。
 * 3. **纯数字才算回复**（§2.4）：`/^\d{1,2}$/`（trim 后）。没有 lastDigest 时
 *    任何数字都不是回复——它只是一条随手记，照常进灵感入账。
 */

/** 一条摘要条目。`n` 是发出去的序号，也是用户回的那个数字——它与 topicId 的绑定就是 lastDigest */
export interface DigestItem {
  n: number;
  topicId: string;
  title: string;
  /** 入库理由（「命中「Agent 落地」」）；渲染时截 80 */
  reason?: string;
  /** 已剥掉 `radar:` 前缀的源名 */
  source?: string;
  link?: string;
  /** 入库时刻，用于「3h 前」 */
  createdAt?: string;
}

/** 摘要选题的入参形状——只认这几个字段，避免把整个 Topic 类型拖进纯函数层 */
export interface DigestCandidate {
  id: string;
  title: string;
  source?: string;
  reason?: string;
  link?: string;
  createdAt: string;
  deletedAt?: string | null;
  /** 已点选角度 = 已被选用，不再当「今天的新灵感」推 */
  selectedAngle?: unknown;
}

/** 落盘在 digest-state.json 里的「上一份清单」（§2.3） */
export interface LastDigest {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  sentAt: string;
  items: Array<{ n: number; topicId: string; title: string }>;
  /** 已经起过调研的序号——同一个数字再回一次是「查进度」，不是再起一轮（§2.4） */
  picked?: number[];
}

export const DIGEST_LIMIT = 5;
export const TITLE_MAX = 60;
export const REASON_MAX = 80;
/** Telegram 上限 4096，留出足够余量给未来的尾注 */
export const DIGEST_MAX_CHARS = 3500;
/** 第一次发（没有 lastDigest）的回看窗口 */
export const FIRST_WINDOW_MS = 24 * 3600_000;

const RADAR_PREFIX = "radar:";

/** 按码点截断（不劈开 emoji 代理对），超长才加省略号，总长恒 ≤ max */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function ageLabel(createdAt: string | undefined, now: number): string | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  const diff = Math.max(0, now - t);
  if (diff < 3600_000) return "刚刚";
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h 前`;
  return `${Math.floor(diff / 86_400_000)}d 前`;
}

/**
 * 候选筛选（§2.1）：`radar:` 源、未进回收站、未被选用、`since` 之后入库。
 * `since` 缺省 = now - 24h（第一次发）。排序沿用入库顺序，取前 limit 条。
 */
export function pickDigestTopics(
  topics: DigestCandidate[],
  opts: { since?: string | number; now: number; limit?: number },
): DigestItem[] {
  const limit = Math.max(1, opts.limit ?? DIGEST_LIMIT);
  const sinceMs = resolveSince(opts.since, opts.now);
  return topics
    .filter((t) => (t.source ?? "").startsWith(RADAR_PREFIX))
    .filter((t) => !t.deletedAt && !t.selectedAngle)
    .filter((t) => {
      const at = Date.parse(t.createdAt);
      return Number.isFinite(at) && at > sinceMs && at <= opts.now;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit)
    .map((t, i) => ({
      n: i + 1,
      topicId: t.id,
      title: t.title,
      ...(t.reason ? { reason: t.reason } : {}),
      ...(t.source ? { source: t.source.slice(RADAR_PREFIX.length) } : {}),
      ...(t.link ? { link: t.link } : {}),
      createdAt: t.createdAt,
    }));
}

function resolveSince(since: string | number | undefined, now: number): number {
  if (typeof since === "number" && Number.isFinite(since)) return since;
  if (typeof since === "string") {
    const parsed = Date.parse(since);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now - FIRST_WINDOW_MS;
}

export interface RenderOptions {
  /** 本地日期 YYYY-MM-DD（调度器算好的那个，渲染层不做时区数学） */
  date: string;
  /** 本轮扫了几个源；不知道就别传——不许编一个数字（§2.1 空摘要同理） */
  sourcesScanned?: number;
  now?: number;
}

/** 「2026-09-07」→「9 月 7 日」；不成形状就原样回（不猜） */
export function formatDigestDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[2])} 月 ${Number(m[3])} 日` : date;
}

function header(date: string): string {
  return `AutoCrew 今日选题 · ${formatDigestDate(date)}`;
}

function itemBlock(item: DigestItem, now: number): string {
  const lines = [`${item.n}. ${truncate(item.title, TITLE_MAX)}`];
  const meta = [
    item.reason ? truncate(item.reason, REASON_MAX) : null,
    item.source ?? null,
    ageLabel(item.createdAt, now),
  ].filter((s): s is string => Boolean(s));
  if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);
  if (item.link) lines.push(`   ${item.link}`);
  return lines.join("\n");
}

function compose(items: DigestItem[], opts: RenderOptions, now: number): string {
  const footer = `回复数字起深调研（1–${items.length}）；回 0 = 今天都不做。`;
  return [header(opts.date), "", ...items.map((it) => itemBlock(it, now)), "", footer].join("\n");
}

/**
 * 排版一次，同时产出「文本」与「真正进了文本的那几条」。
 * 超 3500 字就从尾部丢——序号不重编（丢的是尾巴），所以留下的 n 与用户看到的一致。
 */
export function layoutDigest(
  items: DigestItem[],
  opts: RenderOptions,
): { text: string; items: DigestItem[] } {
  const now = opts.now ?? Date.now();
  if (items.length === 0) return { text: renderEmptyDigest(opts), items: [] };
  let kept = items;
  for (;;) {
    const text = compose(kept, opts, now);
    if (text.length <= DIGEST_MAX_CHARS || kept.length === 1) {
      // 只剩一条还超长：链接过长之类的极端输入，硬切在上限上（发得出去比发得全重要）
      return { text: text.slice(0, DIGEST_MAX_CHARS), items: kept };
    }
    kept = kept.slice(0, kept.length - 1);
  }
}

/** 纯文本摘要（§2.2）。总长恒 ≤ DIGEST_MAX_CHARS */
export function renderDigest(items: DigestItem[], opts: RenderOptions): string {
  return layoutDigest(items, opts).text;
}

/** 真正被写进文本的那几条——调用方按它记 lastDigest（与 renderDigest 同源，不会跑偏） */
export function digestItemsSent(items: DigestItem[], opts: RenderOptions): DigestItem[] {
  return layoutDigest(items, opts).items;
}

/** 空摘要（§2.1）：沉默会让人分不清「没选题」和「没发出去」 */
export function renderEmptyDigest(opts: RenderOptions): string {
  const scanned = typeof opts.sourcesScanned === "number" ? `（扫了 ${opts.sourcesScanned} 个源）` : "";
  return `${header(opts.date)}\n\n今天雷达没有新的命中定位的选题${scanned}。`;
}

// ── 回复映射（§2.4）────────────────────────────────────────────────────────

export type DigestReply =
  | { kind: "none" }
  | { kind: "skip" }
  | { kind: "pick"; n: number; item: { n: number; topicId: string; title: string }; repeat: boolean }
  | { kind: "out_of_range"; n: number; count: number };

const DIGIT_RE = /^\d{1,2}$/;

/**
 * 一条入站文本 → 摘要动作。`none` = 这不是对摘要的回复，调用方照常走灵感入账。
 * 空格照 trim（「3 」仍算数字，§3「最坏输入」）。
 */
export function interpretDigestReply(text: string, lastDigest?: LastDigest | null): DigestReply {
  const clean = text.trim();
  if (!DIGIT_RE.test(clean)) return { kind: "none" };
  if (!lastDigest || lastDigest.items.length === 0) return { kind: "none" };
  const n = Number(clean);
  if (n === 0) return { kind: "skip" };
  const item = lastDigest.items.find((it) => it.n === n);
  if (!item) return { kind: "out_of_range", n, count: lastDigest.items.length };
  return { kind: "pick", n, item, repeat: (lastDigest.picked ?? []).includes(n) };
}

export const DIGEST_SKIP_REPLY = "好，今天不动";

export function outOfRangeReply(count: number): string {
  return `清单里只有 1–${count}`;
}

export function startedReply(title: string): string {
  return `已起深调研：《${title}》。立意卡出来后到工作台看，或再回同一个数字看进度`;
}

const JOB_STATUS_TEXT: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成——立意卡在工作台的选题卡上",
  partial: "部分完成——简报已出，有视角没跑通",
  failed: "失败",
};

/** 同一个数字再回一次 = 查进度（§2.4）。没有 job 记录时照实说，不假装在跑 */
export function jobStatusReply(title: string, status?: string, failReason?: string): string {
  if (!status) return `《${title}》还没有调研记录——再回一次这个数字我重新起一轮`;
  const label = JOB_STATUS_TEXT[status] ?? status;
  const tail = status === "failed" && failReason ? `：${failReason}` : "";
  return `《${title}》的深调研：${label}${tail}`;
}

/** 回的是旧清单时的前缀（§2.4）——不说日期，用户会以为自己在点今天的第 3 条 */
export function staleDigestPrefix(digestDate: string, today: string): string {
  return digestDate === today ? "" : `（这是 ${formatDigestDate(digestDate)}的清单）`;
}
