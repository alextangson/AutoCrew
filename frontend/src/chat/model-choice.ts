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

/**
 * chat:model_options 的一条（服务端 ChatModelOption 的镜像；不含任何凭证字段）。
 * 两种形状：引擎默认档 `{id, model, tier}`；用户自定义端点 `{id:"p:<pid>:<model>", model, group:端点名}`。
 */
export interface ChatModelOption {
  id: string;
  model: string;
  /** 档位字（快/强/备用快/备用强）——只有默认档有 */
  tier?: string;
  /** 端点显示名（optgroup 标题）——只有自定义端点有 */
  group?: string;
}

function defaultStore(): PrefStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // 隐私模式下访问会抛——没有记忆也不能让对话栏起不来
  }
}

/**
 * 一条选项归哪一组。默认四档拆成「主通道」与「备用端点」——它们走的是两套凭证，
 * 混在一起叫"默认档"看不出这件事；自定义端点按端点名各成一组。
 */
export function modelGroupName(option: ChatModelOption): string {
  if (option.group) return option.group;
  return option.id.startsWith("fallback_") ? "备用端点" : "主通道";
}

/**
 * 触发器上的一行字：`模型名 · 组名`。
 * 组名（主通道/备用端点/端点名）比档位字更该占这个位置——
 * 用户真正需要一眼确认的是「这一轮花的是哪家的钱」。
 * 找不到（清单还没到/选择已失效）就回退成 id，绝不显示空白按钮。
 */
export function modelTriggerLabel(options: ChatModelOption[], choice: string): string {
  const option = options.find((o) => o.id === choice);
  if (!option) return choice;
  return `${option.model} · ${modelGroupName(option)}`;
}

/**
 * 解析 chat:model_options 的响应；形状不对一律当"没有可选项"（隐藏切换器）。
 * 一条要么带 tier（默认档）要么带 group（自定义端点），两者都没有就不是能用的选项。
 */
export function parseModelOptions(result: unknown): ChatModelOption[] {
  const options = (result as { data?: { options?: unknown } } | null)?.data?.options;
  if (!Array.isArray(options)) return [];
  return options
    .filter(
      (o): o is ChatModelOption =>
        Boolean(o) && typeof o === "object" &&
        typeof (o as ChatModelOption).id === "string" &&
        typeof (o as ChatModelOption).model === "string" &&
        (typeof (o as ChatModelOption).tier === "string" || typeof (o as ChatModelOption).group === "string"),
    )
    .map((o) => ({
      id: o.id,
      model: o.model,
      ...(typeof o.tier === "string" ? { tier: o.tier } : {}),
      ...(typeof o.group === "string" ? { group: o.group } : {}),
    }));
}

export interface ModelOptionGroup {
  name: string;
  options: ChatModelOption[];
}

/**
 * 面板分组：按 modelGroupName 归组，组间与组内都保持服务端给的顺序
 * （服务端是 快/强 → 备用快/备用强 → 各端点，本来就是从常用到冷门）。
 */
export function groupModelOptions(options: ChatModelOption[]): ModelOptionGroup[] {
  const groups: ModelOptionGroup[] = [];
  for (const option of options) {
    const name = modelGroupName(option);
    const existing = groups.find((g) => g.name === name);
    if (existing) existing.options.push(option);
    else groups.push({ name, options: [option] });
  }
  return groups;
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
