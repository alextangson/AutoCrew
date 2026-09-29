/**
 * 对话级 agent 设置的纯逻辑（v1.1 U1–U5、U13）：模型 / 思考强度 / 权限模式。
 */
import type { BackendId } from "./backend-choice";

export type PermissionMode = "ask" | "conversation" | "bypass";

export interface ConvSettings {
  model: string;
  effort: string;
  permissionMode: PermissionMode;
}

export const DEFAULT_SETTINGS: ConvSettings = { model: "default", effort: "default", permissionMode: "ask" };

export interface Choice { value: string; label: string }

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  ask: "每次问",
  conversation: "本对话都允许",
  bypass: "全部放行",
};

/** 切到「全部放行」前的确认文案（U4）：说清发布/删除仍会弹审批 */
export const BYPASS_CONFIRM =
  "这段对话里本机 agent 跑命令、改文件都不再问你。发布、删稿、删选题这些业务动作仍然每次弹审批卡。确定切到「全部放行」？";

/** conversations:get 的 meta.agentSettings + agent:pending 的 conversationAllow → 当前设置 */
export function settingsFromServer(meta: unknown, conversationAllow: boolean): ConvSettings {
  const s = (meta && typeof meta === "object" ? meta : {}) as { model?: unknown; effort?: unknown; permissionMode?: unknown };
  const mode: PermissionMode = s.permissionMode === "bypass" ? "bypass" : conversationAllow ? "conversation" : "ask";
  return {
    model: typeof s.model === "string" && s.model ? s.model : "default",
    effort: typeof s.effort === "string" && s.effort ? s.effort : "default",
    permissionMode: mode,
  };
}

/** 发给服务端的形状（agent:settings / chat:turn 的 agent_settings） */
export function settingsPayload(s: ConvSettings): Record<string, string> {
  return { model: s.model, effort: s.effort, permission_mode: s.permissionMode };
}

/**
 * 一个选择器该怎么显示（U2 / U13）：
 * - 内置引擎：强度与权限模式整个隐藏（模型沿用内置引擎自己的切换器）；
 * - 本机后端：适配器没上报清单 → 只显示「默认」且不可点，不编造选项。
 */
export function controlState(backend: BackendId, choices: Choice[]): { hidden: boolean; disabled: boolean; items: Choice[] } {
  if (backend === "builtin") return { hidden: true, disabled: true, items: [] };
  if (choices.length === 0) return { hidden: false, disabled: true, items: [{ value: "default", label: "默认" }] };
  const hasDefault = choices.some((c) => c.value === "default");
  return { hidden: false, disabled: false, items: hasDefault ? choices : [{ value: "default", label: "默认" }, ...choices] };
}

export function choiceLabel(items: Choice[], value: string): string {
  return items.find((c) => c.value === value)?.label ?? (value === "default" ? "默认" : value);
}
