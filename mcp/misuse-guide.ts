/**
 * 说明变短之后，流程守则由工具返回兜住（spec v1.3 M2）：被拒的调用若没自带 next_action，
 * 在 MCP 层补一个指向正确动作的 next_action；实在认不出就指向该工具的完整用法资源。
 * 只补不改：工具自己给了 next_action 的原样返回。
 */
import { TOOL_GUIDE_PREFIX } from "./tool-docs.js";

type Json = Record<string, unknown>;
interface Rule { tool: string; action?: string; match?: RegExp; next: Json }

const RULES: Rule[] = [
  { tool: "autocrew_writer", action: "submit", match: /pack_id|写作包|pack/, next: { tool: "autocrew_writer", params: { action: "pack" }, why: "先领写作包（pack），用它返回的 content_id / pack_id 再 submit" } },
  { tool: "autocrew_review_desk", action: "submit", match: /写作包|writer pack/, next: { tool: "autocrew_writer", params: { action: "pack" }, why: "这篇还没走完写稿：先 writer pack → submit，submit 会直接带回审稿包" } },
  { tool: "autocrew_review_desk", action: "submit", next: { tool: "autocrew_review_desk", params: { action: "pack" }, why: "先 review_desk pack 领审稿材料，用它的 review_pack_id / attempt 再 submit" } },
  { tool: "autocrew_workflow", action: "select_angle", match: /简报|brief/, next: { tool: "autocrew_workflow", params: { action: "prepare" }, why: "还没有调研简报：先 prepare 并完成调研，拿到候选和 brief_revision 再选角度" } },
  { tool: "autocrew_scout", match: /task_id|task_required/, next: { tool: "autocrew_scout", params: { action: "prepare" }, why: "先 prepare 领调研任务，之后每次都带 topic_id + task_id" } },
  { tool: "autocrew_editorial", match: /用户明确|确认/, next: { tool: "autocrew_editorial", why: "先向创作者确认，确认后带 user_confirmed:true 重调" } },
  { tool: "autocrew_video", action: "register", next: { tool: "autocrew_video", params: { action: "status" }, why: "先看 status：登记要用交接包里的 manifest_hash 等字段" } },
  { tool: "autocrew_publish", match: /pre_publish/, next: { tool: "autocrew_pre_publish", params: { action: "check" }, why: "先跑发布前检查，全过再发布" } },
];

export function withMisuseGuide(tool: string, args: Json, result: Json): Json {
  if (result.ok !== false || result.next_action !== undefined) return result;
  const action = typeof args.action === "string" ? args.action : "";
  const text = `${String(result.error ?? "")} ${String(result.code ?? "")}`;
  const rule = RULES.find((r) => r.tool === tool && (!r.action || r.action === action) && (!r.match || r.match.test(text)));
  const next = rule?.next ?? { resource: `${TOOL_GUIDE_PREFIX}${tool}`, why: "看这个工具的完整用法后再调" };
  const params = { ...((next.params as Json | undefined) ?? {}), ...(typeof args.content_id === "string" ? { content_id: args.content_id } : {}), ...(typeof args.topic_id === "string" ? { topic_id: args.topic_id } : {}) };
  return { ...result, next_action: next.tool ? { ...next, params } : next };
}
