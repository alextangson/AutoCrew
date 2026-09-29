/**
 * 每段对话自己的 agent 设置（v1.1 §做什么，边界 U1–U5）：模型 / 思考强度 / 权限模式。
 *
 * - 模型、强度只从适配器上报的 configOptions 里选；没上报就只有「默认」（U2），选的值下一轮
 *   不在清单里或设置被拒就报错点名，不偷换（U3）。
 * - 权限模式：每次问（ask）/ 本对话都允许（conversation，只在内存，换对话或守护进程重启即回到每次问，U5）/
 *   全部放行（bypass，落在对话 meta 上）。任何一档下业务审批（发布、删稿、删选题…）照样弹卡。
 * - 设置在轮次开始时读一次：轮次中途改，下一轮才生效（U1）。
 */
import type { AgentProcess, ConfigOptionInfo } from "./acp-process.js";

export type PermissionMode = "ask" | "conversation" | "bypass";

/** 落盘的那部分（conversation 档只在内存） */
export interface AgentSettings {
  model?: string;
  effort?: string;
  permissionMode?: "ask" | "bypass";
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 网页传来的设置：只收白名单字段；"default"/空 = 不设 */
export function parseSettings(raw: unknown): AgentSettings & { conversationAllow?: boolean } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: AgentSettings & { conversationAllow?: boolean } = {};
  const model = str(o.model);
  const effort = str(o.effort);
  if (model && model !== "default") out.model = model;
  if (effort && effort !== "default") out.effort = effort;
  const mode = str(o.permission_mode);
  if (mode === "bypass") out.permissionMode = "bypass";
  if (mode === "ask" || mode === "conversation") out.permissionMode = "ask";
  if (mode === "conversation") out.conversationAllow = true;
  return out;
}

const LABEL: Record<string, string> = { model: "模型", effort: "思考强度" };

/**
 * 把对话设置应用到刚打开的会话，返回最终的配置清单。清单里没有 / 适配器拒绝 → 抛错点名（U3），绝不静默换成别的。
 * 没设的项保持适配器默认。
 */
export async function applySettings(proc: AgentProcess, sessionId: string, initial: ConfigOptionInfo[], s: AgentSettings): Promise<ConfigOptionInfo[]> {
  // 先设模型再设强度：换模型后适配器会重算强度清单，后面的校验与上报都用它回的新清单（评审 v1.1 P2-6）
  let options = initial;
  for (const id of ["model", "effort"] as const) {
    const want = s[id];
    if (!want) continue;
    const opt = options.find((o) => o.id === id);
    const allowed = opt?.values.map((v) => v.value) ?? [];
    if (!allowed.includes(want)) {
      throw new SettingError(`选的${LABEL[id]}「${want}」现在不可用（适配器可选：${allowed.join("、") || "无"}）。没有换成别的，请在输入框下方重新选一个再发。`);
    }
    try {
      options = (await proc.setConfigOption(sessionId, id, want)) ?? options;
    } catch (err) {
      throw new SettingError(`${LABEL[id]}「${want}」设置失败：${err instanceof Error ? err.message : String(err)}。没有换成别的，请重新选一个再发。`);
    }
  }
  return options;
}

export class SettingError extends Error {}

/** 切换器要显示的清单：只留模型与强度，且只在适配器真的上报了时才有 */
export function reportedChoices(options: ConfigOptionInfo[]): { models: ConfigOptionInfo["values"]; efforts: ConfigOptionInfo["values"] } {
  return {
    models: options.find((o) => o.id === "model")?.values ?? [],
    efforts: options.find((o) => o.id === "effort")?.values ?? [],
  };
}
