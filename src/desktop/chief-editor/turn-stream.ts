/**
 * 一轮里 agent 发来的流：正文（脱敏后推 SSE）、工具调用（进「工作记录」）、压缩（一行「整理了一下上下文」）、
 * 上下文用量（usage_update，写日志）、权限请求（按对话的权限模式决定弹不弹卡）。
 */
import { pickPermissionOption } from "./backends.js";
import type { AgentHandlers } from "./acp-process.js";
import { redactAndTruncate, StreamRedactor } from "./redact.js";
import type { ActiveTurn, ChiefEditor, WorkItem } from "./service.js";
import { toolDisplayName } from "./tool-names.js";

export const WRITE_KINDS = new Set(["edit", "delete", "move", "execute"]);

/** session/load 会把历史对话当 update 重放一遍：重放期间的更新一律不算本轮输出 */
export interface StreamGate {
  replaying: boolean;
  flush?: () => void;
  /** 当前这段正文从 text 的哪一格开始：工具调用把正文切段，最后一段才是最终回复（v1.2） */
  segStart?: number;
}

/** 最终回复 = 最后一次工具调用之后的那段正文；之前的过渡文字已收进「已处理」块 */
export function finalSegment(text: string[], gate: StreamGate): string {
  return text.slice(gate.segStart ?? 0).join("");
}

export interface StreamSinks {
  onDelta?: (e: { ev: "delta" | "reset" | "done"; text?: string }) => void;
  onProgress?: (e: Record<string, unknown>) => void;
}

/** 工具调用的可读标签：shell 带上命令本身（「Terminal」一个词说明不了做了什么） */
export function toolLabel(u: { title?: string; rawInput?: unknown }): string {
  const cmd = (u.rawInput as { command?: unknown } | undefined)?.command;
  const title = u.title ?? "工具调用";
  return typeof cmd === "string" && !title.includes(cmd) ? `${title}：${cmd}` : title;
}

/** 工作记录的一条：先落在本轮上，再推 SSE（前端灰色小字，出错红字不折叠，U12） */
function upsertWork(svc: ChiefEditor, turn: ActiveTurn, item: WorkItem): void {
  const i = turn.worklog.findIndex((w) => w.id === item.id);
  if (i >= 0) turn.worklog[i] = { ...turn.worklog[i], ...item };
  else turn.worklog.push({ ...item, name: item.name || "工具调用" });
  svc.deps.emit({ type: "work", turnId: turn.turnId, conversationId: turn.conversationId, item: turn.worklog[i >= 0 ? i : turn.worklog.length - 1] });
}

function errorText(u: { content?: unknown; rawOutput?: unknown }): string {
  const raw = JSON.stringify(u.rawOutput ?? u.content ?? "");
  return redactAndTruncate(raw.replace(/^"|"$/g, ""), 160);
}

export function makeHandlers(svc: ChiefEditor, turn: ActiveTurn, sinks: StreamSinks, text: string[], gate: StreamGate): AgentHandlers {
  const calls = new Map<string, { title: string; kind?: string }>();
  // agent 可能在正文里复述认领令牌：推 SSE 前脱敏（跨分块也挡得住），落盘另做一次全文脱敏
  const redactor = new StreamRedactor();
  const emit = (t: string) => { if (t) sinks.onDelta?.({ ev: "delta", text: t }); };
  gate.flush = () => emit(redactor.finish());
  let thought: WorkItem | null = null;
  return {
    onUpdate(u) {
      if (gate.replaying) return;
      if (u.sessionUpdate === "agent_thought_chunk" && u.content?.text) {
        // 思考收进「已处理」块（v1.2）：连续的思考片段并成一条，脱敏后截断
        thought = thought ?? { id: `thought-${turn.worklog.length}-${Date.now()}`, name: "", status: "done", kind: "thought" };
        thought.name = redactAndTruncate(`${thought.name}${u.content.text}`, 400);
        upsertWork(svc, turn, { ...thought });
        return;
      }
      thought = null;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && u.content.text) {
        text.push(u.content.text);
        emit(redactor.push(u.content.text));
      } else if (u.sessionUpdate === "tool_call" && u.toolCallId) {
        // 工具调用之前那段话是过渡文字：收进「已处理」块，最终回复只留最后一段（v1.2）
        const between = text.slice(gate.segStart ?? 0).join("").trim();
        if (between) upsertWork(svc, turn, { id: `note-${u.toolCallId}`, name: redactAndTruncate(between, 400), status: "done", kind: "note" });
        gate.segStart = text.length;
        if (between) emit(redactor.push("\n\n"));
        onToolCall(svc, turn, sinks, calls, u);
      } else if (u.sessionUpdate === "tool_call_update" && u.toolCallId) {
        onToolUpdate(svc, turn, calls, u);
      } else if (u.sessionUpdate === "compaction_update" && u.compactionId) {
        upsertWork(svc, turn, { id: `compact-${u.compactionId}`, name: "整理了一下上下文", status: u.status === "failed" ? "failed" : u.status === "completed" ? "done" : "running", kind: "compact" });
      } else if (u.sessionUpdate === "usage_update" && typeof u.used === "number") {
        turn.usage = { used: u.used, ...(typeof u.size === "number" ? { size: u.size } : {}) };
      }
    },
    async requestPermission(req) {
      // 本对话都允许 / 全部放行：shell、文件直接放行（记进工作记录）；业务审批不走这里，照样弹卡
      if (turn.bypass || turn.allowConversation) {
        upsertWork(svc, turn, { id: `perm-${req.toolCallId ?? Date.now()}`, name: `自动放行：${redactAndTruncate(req.title.replace(/\s*\{[\s\S]*$/, ""), 60)}`, status: "done" });
        return pickPermissionOption(req.options, "allow");
      }
      const ask = svc.asks.requestPermission({ turnId: turn.turnId, conversationId: turn.conversationId, title: "允许本机 agent 执行？", detail: req.title });
      const decision = await ask.decision;
      // 没获准（拒绝 / 超时 / 停止作废）的调用根本没跑，不算「仍在执行」
      if (decision === "deny" && req.toolCallId) turn.inFlight.delete(req.toolCallId);
      return pickPermissionOption(req.options, decision);
    },
  };
}

type Update = Parameters<AgentHandlers["onUpdate"]>[0];

function onToolCall(svc: ChiefEditor, turn: ActiveTurn, sinks: StreamSinks, calls: Map<string, { title: string; kind?: string }>, u: Update): void {
  const id = u.toolCallId!;
  const title = toolLabel(u);
  calls.set(id, { title, ...(u.kind ? { kind: u.kind } : {}) });
  if (u.kind && WRITE_KINDS.has(u.kind)) turn.inFlight.set(id, title);
  const name = toolDisplayName(u.title, u.rawInput, u.kind);
  sinks.onProgress?.({ phase: "start", label: redactAndTruncate(name, 60) });
  upsertWork(svc, turn, { id, name: redactAndTruncate(name, 80), status: "running" });
}

function onToolUpdate(svc: ChiefEditor, turn: ActiveTurn, calls: Map<string, { title: string; kind?: string }>, u: Update): void {
  const id = u.toolCallId!;
  const call = calls.get(id);
  // 命令参数常在后续 update 里才到：补进标签
  if (call && u.rawInput) {
    call.title = toolLabel({ title: u.title ?? call.title.split("：")[0], rawInput: u.rawInput });
    upsertWork(svc, turn, { id, name: redactAndTruncate(toolDisplayName(u.title ?? call.title.split("：")[0], u.rawInput, call.kind), 80), status: "running" });
  }
  if (call && turn.inFlight.has(id)) turn.inFlight.set(id, call.title);
  if (u.status !== "completed" && u.status !== "failed") return;
  turn.inFlight.delete(id);
  const err = u.status === "failed" ? errorText(u as never) : "";
  // 业务审批拦下不是出错：记成「等你批准」，不画红字
  if (err.includes("approval_required")) upsertWork(svc, turn, { id, status: "done", note: "等你批准" } as WorkItem);
  else upsertWork(svc, turn, { id, status: u.status === "failed" ? "failed" : "done", ...(err ? { error: err } : {}), ...(u.status === "completed" && markRecovered(turn, id) ? { recovered: true } : {}) } as WorkItem);
  if (u.status === "completed" && call?.kind && WRITE_KINDS.has(call.kind)) turn.writes.push(redactAndTruncate(call.title, 60));
}

/** 同一动作先失败、后成功：失败那条标 resolved（外面不再报「未解决」），返回本条是否算「重试成功」（X6） */
function markRecovered(turn: ActiveTurn, id: string): boolean {
  const name = turn.worklog.find((w) => w.id === id)?.name;
  const failed = name ? turn.worklog.filter((w) => w.status === "failed" && !w.resolved && w.name === name && w.id !== id) : [];
  for (const f of failed) f.resolved = true;
  return failed.length > 0;
}
