/**
 * 总编辑本机 agent → AutoCrew 的 MCP 入口（spec §地基 1 / 2 / 4 / 5 / 13）。
 *
 * 会话令牌决定一切：资料库取绑定时那个（切库不影响正在跑的 agent），归属在调用**进入时**定死，
 * 发布类动作在执行前拦成 approval_required，结果按白名单转卡片（claim_token 不出执行上下文）。
 */
import { randomBytes } from "node:crypto";
import { approvalBindingFor, approvalRequiredResult, classifyPublishAction, type GateTarget } from "./publish-gate.js";
import { cardFromToolResult } from "./redact.js";
import type { ChiefEditor, TokenBinding } from "./service.js";

type Json = Record<string, unknown>;

/** 只读动作：不算「写动作」（停止时列出的是写动作） */
const READ_ACTIONS = new Set(["get", "list", "status", "inbox", "siblings", "allowed_transitions", "versions", "get_version", "pack_status", "templates", "inspect", "search", "read_page", "check"]);

function toolResponse(id: unknown, body: Json): Json {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: body.ok === false } };
}

/** MCP 响应 → 工具结果对象（structuredContent 优先，退回解析文本） */
export function resultObject(response: Json | null): Json {
  const result = response?.result as Json | undefined;
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent as Json;
  const text = ((result?.content as Array<{ text?: string }> | undefined) ?? [])[0]?.text ?? "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as Json;
  } catch { /* 非 JSON 文本 */ }
  const error = (response?.error as { message?: string } | undefined)?.message;
  return result?.isError || error ? { ok: false, error: error ?? text } : { ok: true, message: text };
}

async function requireApproval(svc: ChiefEditor, b: TokenBinding, turnId: string, target: GateTarget, args: Json, reason?: string): Promise<Json> {
  const content = target.contentId ? await svc.deps.getContent(target.contentId, b.dataDir) : null;
  const ask = svc.asks.requestApproval({
    turnId,
    conversationId: b.conversationId,
    title: `批准「${target.label}」？`,
    detail: `${content?.title ? `《${content.title}》` : target.targetId}${content?.platform ? ` · ${content.platform}` : ""}${content?.body ? ` · ${Array.from(content.body).slice(0, 80).join("")}` : ""}`,
    binding: approvalBindingFor(target, args, b.dataDir, content),
  });
  return approvalRequiredResult(ask.id, target, reason);
}

/**
 * 发布类动作的执行前门。返回 `{ proceed: args }` 放行（approval_id 已剥掉），否则返回要回给 agent 的结果。
 * 批准后稿件又被改过 → 指纹不符，审批失效，重新要一张审批卡（§边界 8）。
 */
async function gate(svc: ChiefEditor, b: TokenBinding, turnId: string | null, tool: string, args: Json): Promise<{ proceed: Json; gated?: boolean } | { reply: Json }> {
  const target = classifyPublishAction(tool, args);
  if (!target) return { proceed: args };
  if ("refuse" in target) return { reply: { ok: false, code: "refused", error: target.refuse } };
  if (!turnId) return { reply: { ok: false, code: "no_live_turn", error: "这一轮已经结束，发布类动作不能在后台发起；请创始人重新发话" } };
  const { approval_id: rawId, ...rest } = args;
  const approvalId = typeof rawId === "string" ? rawId.trim() : "";
  if (!approvalId) return { reply: await requireApproval(svc, b, turnId, target, rest) };
  const approved = svc.asks.approvedToken(approvalId);
  // 审批只在批出它的那一轮有效：停止 / 收尾后没用掉的 id 带不进下一轮
  if (!approved || approved.conversationId !== b.conversationId || approved.turnId !== turnId) {
    return { reply: await requireApproval(svc, b, turnId, target, rest, "这个 approval_id 无效、未获批准或已经用过") };
  }
  const content = target.contentId ? await svc.deps.getContent(target.contentId, b.dataDir) : null;
  const consumed = svc.deps.approvals.consume(approved.token, approvalBindingFor(target, rest, b.dataDir, content));
  svc.asks.consumed(approvalId);
  if (!consumed.ok) return { reply: await requireApproval(svc, b, turnId, target, rest, "批准之后稿件或参数又变了，原审批已失效") };
  return { proceed: rest, gated: true };
}

/** 整个工具都是只读的 */
const READ_TOOLS = new Set(["autocrew_status", "autocrew_dashboard"]);

function writeLabel(tool: string, action: string, result: Json): string | undefined {
  if (result.ok === false || READ_ACTIONS.has(action) || READ_TOOLS.has(tool)) return undefined;
  return `${tool}${action ? ` ${action}` : ""}`;
}

/** 处理一条来自会话令牌的 MCP 请求 */
export async function handleAgentMcp(svc: ChiefEditor, b: TokenBinding, request: Json): Promise<Json | null> {
  if (request.method !== "tools/call") return svc.deps.execMcp(request, b.dataDir, b.turnId);
  const params = (request.params ?? {}) as Json;
  const tool = String(params.name ?? "");
  const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Json) : {};
  const action = typeof args.action === "string" ? args.action : "";
  // 归属在进入时定死：此刻所属的轮还在跑才算本轮，完成时不再回头找「当前轮」
  const entryTurn = svc.liveTurnFor(b);
  const callId = `call-${randomBytes(6).toString("hex")}`;
  const gated = await gate(svc, b, entryTurn, tool, args);
  if ("reply" in gated) {
    await svc.recordCard(entryTurn, b, cardFromToolResult(tool, action, gated.reply, callId, args));
    return toolResponse(request.id, gated.reply);
  }
  // 门里有异步读：执行前再核一次——令牌已撤销、或发布类动作所属的轮已停，就不执行
  const stale = !svc.tokenLive(b.token) || (gated.gated && svc.liveTurnFor(b) !== entryTurn);
  if (stale) {
    const reply = { ok: false, code: "no_live_turn", error: "这一轮已经停止或结束，没有执行；请创始人重新发话" };
    await svc.recordCard(entryTurn, b, cardFromToolResult(tool, action, reply, callId, args));
    return toolResponse(request.id, reply);
  }
  const response = await svc.deps.execMcp({ ...request, params: { ...params, arguments: gated.proceed } }, b.dataDir, b.turnId);
  const result = resultObject(response);
  await svc.recordCard(entryTurn, b, cardFromToolResult(tool, action, result, callId, args), writeLabel(tool, action, result));
  return response;
}
