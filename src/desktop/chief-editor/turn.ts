/**
 * 总编辑本机 agent 的一轮（spec §地基 6 / 7 / 8，§边界 1–7、12）。
 *
 * 顺序：同步加锁（全局 1 个 agent、同对话 1 轮）→ 先落盘（对话 / 后端 / 资料库 / 轮次）→
 * 签会话令牌 → 起进程（detached，记 pid+命令）→ session/load 续不上就新开 → prompt，
 * 有审批就挂着等（整轮持锁）→ 批准后给 agent 发一句继续 → 收尾撤令牌、杀进程组、落对话。
 * 停止 = ACP cancel，宽限 5 秒后杀整组；结果不明的写操作绝不自动重放。
 */
import { createConversation, getConversation, updateConversationAgent } from "../../storage/conversation-store.js";
import { registerTurn, settleTurn } from "../turn-registry.js";
import { enqueueConversationWrite } from "../chat-persist.js";
import { STATUS_TEXT, type AskView } from "./asks.js";
import { ADAPTERS, proxyUnreachable, type BackendAdapter, type LocalBackendId } from "./backends.js";
import type { AgentProcess } from "./acp-process.js";
import { SettingError, type AgentSettings } from "./agent-settings.js";
import { makeHandlers, type StreamGate } from "./turn-stream.js";
import { openSession } from "./turn-session.js";
import { ensurePersona } from "./persona.js";
import { redactAndTruncate, redactedTail, redactText } from "./redact.js";
import { appendConversation, getChiefEditor, type ActiveTurn, type ChiefEditor } from "./service.js";

export interface LocalTurnInput {
  message: string;
  backend: LocalBackendId;
  turnId: string;
  clientId: string;
  dataDir: string;
  conversationId?: string;
  contentId?: string;
  /** 视图上下文前缀：只拼进发给 agent 的 prompt，对话历史存原话 */
  promptContext?: string;
  /** 新对话的设置（网页选的模型 / 强度 / 权限模式）；已有对话以 meta 为准 */
  newSettings?: AgentSettings;
  /** 新对话开头就选了「本对话都允许」（只进内存） */
  newConversationAllow?: boolean;
  onDelta?: (e: { ev: "delta" | "reset" | "done"; text?: string }) => void;
  onProgress?: (e: Record<string, unknown>) => void;
}

type Result = Record<string, unknown>;

/** 同步加锁：check-and-set 之间没有 await，两个标签页同时发只有一个进得来（§边界 3 / 4） */
function acquire(svc: ChiefEditor, input: LocalTurnInput): { ok: true; turn: ActiveTurn; signal: AbortSignal } | { ok: false; error: string } {
  if (svc.active) {
    return { ok: false, error: svc.active.conversationId && svc.active.conversationId === input.conversationId
      ? "这段对话正在跑，等它结束或先点停止"
      : "已有一个本机 agent 在跑（另一段对话），不排队——等它结束或先去那段对话点停止" };
  }
  const reg = registerTurn(input.turnId, input.clientId, input.conversationId ? { conversationId: input.conversationId } : undefined);
  if (!reg.ok) return reg;
  const turn: ActiveTurn = {
    turnId: input.turnId, clientId: input.clientId, conversationId: input.conversationId ?? "",
    dataDir: input.dataDir, backend: input.backend, status: "running", cards: [], writes: [], inFlight: new Map(), aborted: false,
    worklog: [], bypass: false, allowConversation: false,
  };
  svc.active = turn;
  return { ok: true, turn, signal: reg.signal };
}

/** 新对话建起来就把网页选的设置记上；已有对话读它自己的设置（轮次开始时读一次，U1） */
async function prepareConversation(input: LocalTurnInput): Promise<{ id: string; acpSessionId?: string; settings: AgentSettings } | { error: string }> {
  if (!input.conversationId) {
    const meta = await createConversation(input.message, input.dataDir, input.contentId, { backend: input.backend });
    const settings = input.newSettings ?? {};
    if (Object.keys(settings).length) await enqueueConversationWrite(meta.id, () => updateConversationAgent(meta.id, { agentSettings: settings }, input.dataDir));
    if (input.newConversationAllow) getChiefEditor()?.setConversationAllow(meta.id, true);
    return { id: meta.id, settings };
  }
  const conv = await getConversation(input.conversationId, input.dataDir);
  if (!conv) return { error: "会话不存在或已损坏，请新建对话" };
  return { id: conv.meta.id, settings: conv.meta.agentSettings ?? {}, ...(conv.meta.acpSessionId ? { acpSessionId: conv.meta.acpSessionId } : {}) };
}

/** 进程先退出就当崩溃（§边界 12），不让 prompt 挂死 */
/** 进程退出即抛：prompt 与「等审批」都要和它赛跑，适配器死了不能挂着锁等 10 分钟（§边界 12） */
function orCrash<T>(proc: AgentProcess, work: Promise<T>): Promise<T> {
  const crashed = proc.exited.then(({ code, signal }): never => {
    throw new Error(`适配器进程退出了（code=${code ?? "-"}${signal ? `，signal=${signal}` : ""}）`);
  });
  return Promise.race([work, crashed]);
}

function promptOrCrash(proc: AgentProcess, sessionId: string, text: string): Promise<{ stopReason: string }> {
  return orCrash(proc, proc.prompt(sessionId, text));
}

function followupText(asks: AskView[]): string {
  return asks.map((a) => a.status === "approved"
    ? `已批准 approval_id=${a.id}，请用完全相同的参数加上 approval_id 重调刚才那个工具继续。`
    : `approval_id=${a.id} 没有获批（${STATUS_TEXT[a.status]}）：不要执行这个动作，简短告诉创始人你停在哪。`).join("\n");
}

/** prompt → 本轮有没告诉过 agent 的审批就挂着等它们落定（状态 awaiting_approval，整轮持锁）→ 发一句继续 → 循环 */
async function promptLoop(svc: ChiefEditor, turn: ActiveTurn, proc: AgentProcess, sessionId: string, message: string, flush?: () => void): Promise<string> {
  let r = await promptOrCrash(proc, sessionId, message);
  for (;;) {
    flush?.(); // 等审批前把已说完的话全部推出去
    const open = svc.asks.unreportedApprovals(turn.turnId);
    if (open.length === 0 || turn.aborted) return r.stopReason;
    if (open.some((a) => a.status === "pending")) svc.setStatus(turn, "awaiting_approval");
    const settled = await orCrash(proc, svc.asks.settledApprovals(turn.turnId, open.map((a) => a.id)));
    if (turn.aborted) return "cancelled";
    svc.asks.markReported(settled.map((a) => a.id));
    if (turn.status !== "running") svc.setStatus(turn, "running");
    r = await promptOrCrash(proc, sessionId, followupText(settled));
  }
}

function stopAgent(svc: ChiefEditor, turn: ActiveTurn): void {
  if (turn.aborted) return;
  turn.aborted = true;
  svc.asks.cancelTurn(turn.turnId);
  const proc = turn.process;
  if (!proc) return;
  if (turn.sessionId) void proc.cancel(turn.sessionId).catch(() => {});
  const t = setTimeout(() => proc.kill(), svc.deps.killGraceMs ?? 5000);
  t.unref?.();
}

/** 每轮记一次上下文用量（v1.1：核实减负后首轮不再压缩） */
function logUsage(turn: ActiveTurn): void {
  if (!turn.usage) return;
  const { used, size } = turn.usage;
  console.log(`[chief-editor] 上下文 ${used}${size ? ` / ${size}（${Math.round((used / size) * 100)}%）` : ""} · 对话 ${turn.conversationId} · 轮次 ${turn.turnId}`);
}

function failureText(adapter: BackendAdapter, svc: ChiefEditor, err: unknown, proc?: AgentProcess): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof SettingError) return msg;
  if (adapter.isAuthError(msg)) {
    svc.authFailed.add(adapter.id);
    return `${adapter.label}未登录或登录已过期：${adapter.loginFix}。不会自动改用内置引擎。`;
  }
  const tail = proc ? redactedTail(proc.stderrTail()) : "";
  return `${adapter.label}出错：${redactAndTruncate(msg, 200)}${tail ? `\n最后几行输出：\n${tail}` : ""}`;
}

interface Outcome { ok: boolean; reply: string; stopReason?: string; notice?: string }

/** 停止时列出停之前已完成的写动作（§边界 2） */
export function stopSummary(writes: string[], inFlight: string[] = []): string {
  const done = writes.length ? `停之前已完成的写动作：${writes.join("；")}` : "停之前没有完成任何写动作";
  const partial = inFlight.length ? `停止时仍在执行、可能已部分生效：${inFlight.map((t) => redactAndTruncate(t, 60)).join("；")}。` : "";
  return `已停。${done}。${partial}`;
}

/** 本轮卡片：工作记录（有就放最前，一张）+ 工具结果卡 */
export function turnCards(turn: ActiveTurn): Record<string, unknown>[] {
  return turn.worklog.length ? [{ type: "agent_worklog", data: { items: turn.worklog } }, ...turn.cards] : turn.cards;
}

function replyText(turn: ActiveTurn, out: Outcome): string {
  const parts = [out.notice, out.reply || "（agent 没有返回文字，结果见卡片）", turn.aborted ? stopSummary(turn.writes, [...turn.inFlight.values()]) : ""];
  return parts.filter(Boolean).join("\n\n");
}

async function execute(svc: ChiefEditor, turn: ActiveTurn, input: LocalTurnInput, adapter: BackendAdapter, signal: AbortSignal): Promise<Outcome> {
  const base = adapter.launch();
  if (!base) return { ok: false, reply: `${adapter.label}没装上：在 AutoCrew 目录运行 npm install。不会自动改用内置引擎。` };
  const routing = adapter.routingEnv?.(svc.deps.claudeSettingsPath) ?? { env: {} };
  if ("error" in routing) return { ok: false, reply: routing.error };
  const proxyDown = await proxyUnreachable(routing.env);
  if (proxyDown) return { ok: false, reply: proxyDown };
  const launch = { ...base, env: { ...base.env, ...routing.env } };
  const conv = await prepareConversation(input);
  if ("error" in conv) return { ok: false, reply: conv.error };
  turn.conversationId = conv.id;
  turn.bypass = conv.settings.permissionMode === "bypass";
  turn.allowConversation = svc.conversationAllowed(conv.id);
  svc.runs.put({ turnId: turn.turnId, clientId: turn.clientId, conversationId: conv.id, dataDir: turn.dataDir, backend: turn.backend, message: input.message, status: "running", startedAt: new Date().toISOString() });
  ensurePersona(svc.deps.home, turn.backend);
  turn.token = svc.issueToken({ backend: turn.backend, dataDir: turn.dataDir, conversationId: conv.id, turnId: turn.turnId });
  const text: string[] = [];
  const gate: StreamGate = { replaying: false };
  const proc = svc.deps.spawnAgent(launch, svc.deps.home, makeHandlers(svc, turn, input, text, gate));
  turn.process = proc;
  svc.runs.patch(turn.turnId, { ...(proc.pid ? { pid: proc.pid } : {}), command: proc.command });
  signal.addEventListener("abort", () => stopAgent(svc, turn), { once: true });
  try {
    const session = await openSession(svc, turn, adapter, proc, gate, { settings: conv.settings, ...(conv.acpSessionId ? { prior: conv.acpSessionId } : {}) });
    turn.sessionId = session.sessionId;
    if (signal.aborted) stopAgent(svc, turn);
    const stopReason = turn.aborted ? "cancelled" : await promptLoop(svc, turn, proc, session.sessionId, `${input.promptContext ?? ""}${input.message}`, gate.flush);
    svc.authFailed.delete(adapter.id);
    gate.flush?.();
    logUsage(turn);
    return { ok: true, reply: redactText(text.join("")).trim(), stopReason, ...(session.notice ? { notice: session.notice } : {}) };
  } catch (err) {
    gate.flush?.();
    if (turn.aborted) return { ok: true, reply: redactText(text.join("")).trim(), stopReason: "cancelled" };
    return { ok: false, reply: failureText(adapter, svc, err, proc) };
  }
}

/** 本轮落进对话（走按会话串行队列）。失败就抛：完成状态只能在落盘成功之后才提交 */
async function persistOutcome(turn: ActiveTurn, input: LocalTurnInput, out: Outcome): Promise<void> {
  const content = out.ok ? replyText(turn, out) : `⚠️ ${out.reply}`;
  const meta = await appendConversation(turn.conversationId, { content: input.message }, { content, cards: turnCards(turn), turnId: turn.turnId }, turn.dataDir);
  if (!meta) throw new Error("对话在本轮进行中被删除了");
}

/**
 * 先落对话、再把 run 标 done/failed：落盘失败 run 保持未完成，守护进程下次启动按中断补写（带卡片与写动作）。
 * 解锁（active=null、settleTurn）放 finally，任何持久化异常都不能把全局锁永远卡住。
 */
async function finish(svc: ChiefEditor, turn: ActiveTurn, input: LocalTurnInput, out: Outcome): Promise<string | null> {
  let persistError: string | null = null;
  try {
    svc.revokeToken(turn.token);
    svc.asks.endTurn(turn.turnId);
    turn.process?.kill();
    if (turn.conversationId) {
      await persistOutcome(turn, input, out);
      svc.runs.patch(turn.turnId, { status: out.ok ? "done" : "failed", endedAt: new Date().toISOString(), cards: turn.cards, writes: turn.writes });
    }
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    console.warn(`[chief-editor] 本轮收尾落盘失败：${persistError}`);
  } finally {
    svc.active = null;
    try {
      svc.deps.emit({ type: "turn", turnId: turn.turnId, conversationId: turn.conversationId, status: out.ok ? "done" : "failed" });
      input.onDelta?.({ ev: "done" });
    } catch { /* 推送失败不影响解锁 */ }
    await settleTurn(turn.turnId, { ...(turn.conversationId ? { conversationId: turn.conversationId } : {}), dataDir: turn.dataDir });
  }
  return persistError;
}

export async function runLocalTurn(svc: ChiefEditor, input: LocalTurnInput): Promise<Result> {
  const adapter = ADAPTERS[input.backend];
  if (!adapter) return { ok: false, error: `${input.backend} 即将支持，现在请选本机 Claude 或内置引擎` };
  const lock = acquire(svc, input);
  if (!lock.ok) return { ok: false, error: lock.error };
  const { turn } = lock;
  let out: Outcome = { ok: false, reply: "未知错误" };
  let persistError: string | null = null;
  try {
    out = await execute(svc, turn, input, adapter, lock.signal);
  } catch (err) {
    out = { ok: false, reply: failureText(adapter, svc, err) };
  } finally {
    persistError = await finish(svc, turn, input, out);
  }
  if (persistError) out = { ok: false, reply: `这一轮的结果没能写进对话：${redactAndTruncate(persistError, 120)}。记录已保留，守护进程下次启动会按中断补写。` };
  if (!out.ok) return { ok: false, error: out.reply, ...(turn.conversationId ? { data: { conversationId: turn.conversationId } } : {}) };
  const stopReason = turn.aborted ? "aborted" : out.stopReason;
  return { ok: true, data: { reply: replyText(turn, out), cards: turnCards(turn), conversationId: turn.conversationId, backend: turn.backend, writes: turn.writes, ...(stopReason ? { stopReason } : {}) } };
}
