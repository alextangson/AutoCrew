/**
 * 总编辑后端切换器的纯逻辑（总编辑接本机 agent spec §目标 / §地基 12 / 14，边界 13 / 14）。
 *
 * - 对话的后端以服务端记录为准；localStorage 只作**新对话**的默认值；
 * - 对话中途换后端 = 新开一段对话，旧的保留；
 * - 不可用的项（没装 / 即将支持 / 内置没配置）不能选，但要显示原因。
 */

export type BackendId = "claude" | "codex" | "builtin";
export type BackendState = "ready" | "not_installed" | "not_logged_in" | "coming_soon" | "not_configured";

export interface BackendStatus {
  id: BackendId;
  label: string;
  billing?: string;
  state: BackendState;
  detail?: string;
  /** 适配器上报的模型 / 思考强度清单（没上报就没有，U2） */
  models?: Array<{ value: string; label: string }>;
  efforts?: Array<{ value: string; label: string }>;
}

export interface RunningAgent {
  conversationId: string;
  backend: string;
  otherLibrary: boolean;
}

const KEY = "autocrew.chat.backend";
const NOTICE_KEY = "autocrew.chat.localAgentNoticeSeen";
const IDS: readonly string[] = ["claude", "codex", "builtin"];

export const STATE_TEXT: Record<BackendState, string> = {
  ready: "可用",
  not_installed: "没装",
  not_logged_in: "未登录",
  coming_soon: "即将支持",
  not_configured: "未配置",
};

export function isBackendId(v: unknown): v is BackendId {
  return typeof v === "string" && IDS.includes(v);
}

export function parseBackends(raw: unknown): { backends: BackendStatus[]; running: RunningAgent | null } {
  const data = (raw as { data?: { backends?: unknown; running?: unknown } } | null)?.data;
  const backends = Array.isArray(data?.backends)
    ? (data!.backends as BackendStatus[]).filter((b) => b && isBackendId(b.id) && typeof b.label === "string")
    : [];
  const running = data?.running && typeof data.running === "object" ? (data.running as RunningAgent) : null;
  return { backends, running };
}

/** 能选：可用；未登录也允许选（发出去会拿到带修法的报错，而不是悄悄换后端） */
export function selectable(b: BackendStatus): boolean {
  return b.state === "ready" || b.state === "not_logged_in";
}

interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }
function store(): Store | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** 新对话的默认后端：记住的那个还能选就用它，否则第一个可选的本机后端，再否则内置 */
export function defaultBackend(list: BackendStatus[], s: Store | null = store()): BackendId {
  const saved = s?.getItem(KEY);
  const hit = list.find((b) => b.id === saved && selectable(b));
  if (hit) return hit.id;
  return list.find((b) => b.id !== "builtin" && selectable(b))?.id ?? "builtin";
}

export function rememberBackend(id: BackendId, s: Store | null = store()): void {
  try { s?.setItem(KEY, id); } catch { /* 隐私模式：不记也能用 */ }
}

/** 对话中途换后端：已有对话且后端不同 → 新开；新对话或同后端 → 原地 */
export function decideBackendPick(current: { conversationId?: string; backend: BackendId }, picked: BackendId): "new_conversation" | "stay" {
  if (picked === current.backend) return "stay";
  return current.conversationId ? "new_conversation" : "stay";
}

export function backendHint(b: BackendStatus): string {
  return [STATE_TEXT[b.state], b.billing].filter(Boolean).join(" · ");
}

export function noticeSeen(s: Store | null = store()): boolean {
  return s?.getItem(NOTICE_KEY) === "1";
}

export function markNoticeSeen(s: Store | null = store()): void {
  try { s?.setItem(NOTICE_KEY, "1"); } catch { /* 同上 */ }
}

/** 信任模型（spec §信任模型）：首次使用与设置页都显示这段 */
export const TRUST_NOTICE =
  "本机 agent 和你自己在电脑上开 Claude Code 一样：能读写文件、跑 shell。AutoCrew 的门禁拦不住它，" +
  "我们只防误操作——跑 shell / 写文件先弹卡问你，发布、删稿先等你批准；防不住网页或资料里的恶意指令诱导它。";
