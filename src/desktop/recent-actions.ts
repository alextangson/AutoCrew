/**
 * 最近工作区动作的有界环（对话控制面设计 §Phase 2「工作区动作 → 模型上下文」）。
 *
 * 用户在工作区点了流转/定稿封面/确认发布/确认分句，下一轮对话里总编辑得知道——
 * 否则它会问「你要不要先送审」而用户三秒前刚送过审。
 *
 * 三条纪律：
 * 1. **有界环**：最多 20 条，整文件覆盖写，永不追加增长（不是 events.jsonl 那种流水）。
 * 2. **观测层不破坏执行层**：写失败只 console 记一笔，绝不 throw——流转成功了就是成功了。
 * 3. **只进模型不进历史**：读出来的摘要由 runChatTurn 拼进本轮 userMessage，
 *    不落 conversation-store（会话内动作叙事流另立提案，本期有意排除）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

const FILE = "recent-actions.json";
const RING_MAX = 20;
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_LIMIT = 5;

export interface RecentAction {
  /** 动作类型；人话渲染见 ACTION_LABELS */
  kind: string;
  contentId?: string;
  title?: string;
  /** 补充一小段上下文（如流转目标列），≤30 字 */
  detail?: string;
  /** ISO 时间戳 */
  at: string;
}

const ACTION_LABELS: Record<string, string> = {
  transition: "在看板挪了一篇稿",
  cover_approved: "定稿了封面",
  published: "确认已发布",
  video_cut: "确认了成片分句",
  video_reviewed: "审片通过",
};

function ringPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), FILE);
}

async function readRing(dataDir?: string): Promise<RecentAction[]> {
  try {
    const raw = await fs.readFile(ringPath(dataDir), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is RecentAction =>
        a !== null && typeof a === "object" && typeof (a as RecentAction).kind === "string" && typeof (a as RecentAction).at === "string",
    );
  } catch {
    // 文件不存在/坏了都当空环——观测层没有「读失败」这种结果
    return [];
  }
}

/** 追加一条动作。失败只记录不抛——调用方是流转/发布这类执行路径，不许被观测层拖崩。 */
export async function appendAction(
  dataDir: string | undefined,
  action: { kind: string; contentId?: string; title?: string; detail?: string; at?: string },
): Promise<void> {
  try {
    const entry: RecentAction = {
      kind: action.kind,
      ...(action.contentId ? { contentId: action.contentId } : {}),
      ...(action.title ? { title: String(action.title).slice(0, 60) } : {}),
      ...(action.detail ? { detail: String(action.detail).slice(0, 30) } : {}),
      at: action.at ?? new Date().toISOString(),
    };
    const next = [...(await readRing(dataDir)), entry].slice(-RING_MAX);
    const dir = getDataDir(dataDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, FILE), JSON.stringify(next), "utf-8");
  } catch (err) {
    console.warn(`[recent-actions] 记录动作失败（不影响动作本身）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 读窗口内最近若干条（新的在后）。缺省 30 分钟 / 5 条。 */
export async function readRecentActions(
  dataDir?: string,
  opts?: { windowMs?: number; limit?: number; now?: number },
): Promise<RecentAction[]> {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const now = opts?.now ?? Date.now();
  const all = await readRing(dataDir);
  return all
    .filter((a) => {
      const t = Date.parse(a.at);
      return Number.isFinite(t) && now - t <= windowMs && now - t >= -60_000; // 未来戳容忍 1 分钟时钟漂移
    })
    .slice(-limit);
}

/**
 * 拼成给模型看的一段（只进本轮 userMessage）。无动作回空串——没有动作就不注入。
 * 总长上限 ~300 字符（≈300 token，设计 §P2-5 的预算）。
 */
export function recentActionsBlock(actions: RecentAction[], maxChars = 300): string {
  if (actions.length === 0) return "";
  const lines: string[] = [];
  for (const a of actions) {
    const what = ACTION_LABELS[a.kind] ?? a.kind;
    const who = a.title ? `《${a.title}》` : a.contentId ? `(${a.contentId})` : "";
    lines.push(`- ${what}${who}${a.detail ? ` · ${a.detail}` : ""}`);
  }
  const head = "【最近工作区动作】用户刚在工作区做的（只作背景，别复述、别重复代劳）：\n";
  let body = lines.join("\n");
  if (head.length + body.length > maxChars) body = body.slice(0, Math.max(0, maxChars - head.length - 1)) + "…";
  return head + body;
}
