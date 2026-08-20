/**
 * 总编辑对话用哪个模型（右栏切换器的本地记忆）。
 *
 * 与 dock-prefs 同一套纪律：localStorage 是用户能手改、也会残留陈旧值的地方，
 * 读出来一律拿**服务端给的真实选项清单**校一遍——清单里没有（备用端点被删掉后
 * 残留的 fallback_*，或手改进去的乱值）就回落缺省档并覆写存储。
 * 选择器只显示真的能用的档位，绝不出现"选着一个不存在的模型"这种状态。
 */
import type { PrefStore } from "./dock-prefs";

export const CHAT_MODEL_KEY = "chat-model";
/** 缺省档 = 主端点快档 = 切换器上线前的行为 */
export const DEFAULT_CHAT_MODEL = "fast";

/** chat:model_options 的一条（服务端 ChatModelOption 的镜像；不含任何凭证字段） */
export interface ChatModelOption {
  id: string;
  model: string;
  tier: string;
}

function defaultStore(): PrefStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // 隐私模式下访问会抛——没有记忆也不能让对话栏起不来
  }
}

/** 选项文案：真实模型名 + 档位字，如「claude-sonnet-5 · 快」 */
export function modelOptionLabel(option: ChatModelOption): string {
  return `${option.model} · ${option.tier}`;
}

/** 解析 chat:model_options 的响应；形状不对一律当"没有可选项"（隐藏切换器） */
export function parseModelOptions(result: unknown): ChatModelOption[] {
  const options = (result as { data?: { options?: unknown } } | null)?.data?.options;
  if (!Array.isArray(options)) return [];
  return options.filter(
    (o): o is ChatModelOption =>
      Boolean(o) && typeof o === "object" &&
      typeof (o as ChatModelOption).id === "string" &&
      typeof (o as ChatModelOption).model === "string" &&
      typeof (o as ChatModelOption).tier === "string",
  );
}

/** 存过的档位仍在清单里才认；否则回落缺省并把陈旧值覆写掉 */
export function readModelChoice(options: ChatModelOption[], store: PrefStore | null = defaultStore()): string {
  let raw: string | null = null;
  try {
    raw = store?.getItem(CHAT_MODEL_KEY) ?? null;
  } catch {
    return DEFAULT_CHAT_MODEL;
  }
  if (raw && options.some((o) => o.id === raw)) return raw;
  if (raw && raw !== DEFAULT_CHAT_MODEL) writeModelChoice(DEFAULT_CHAT_MODEL, store);
  return DEFAULT_CHAT_MODEL;
}

export function writeModelChoice(id: string, store: PrefStore | null = defaultStore()): void {
  try {
    store?.setItem(CHAT_MODEL_KEY, id);
  } catch {
    /* 存不下最多是下次回缺省档，不影响本轮选择 */
  }
}
