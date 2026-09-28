/**
 * 总编辑本机 agent 的一轮（spec §地基 6 / 7 / 8，§边界 1–7、12）。
 *
 * 顺序：同步加锁（全局 1 个 agent、同对话 1 轮）→ 先落盘（对话 / 后端 / 资料库 / 轮次）→
 * 签会话令牌 → 起进程（detached，记 pid+命令）→ session/load 续不上就新开 → prompt，
 * 有审批就挂着等（整轮持锁）→ 批准后给 agent 发一句继续 → 收尾撤令牌、杀进程组、落对话。
 * 停止 = ACP cancel，宽限 5 秒后杀整组；结果不明的写操作绝不自动重放。
 */
import { createConversation, getConversation, appendTurn, updateConversationAgent } from "../../storage/conversation-store.js";
import { registerTurn, settleTurn } from "../turn-registry.js";
import { STATUS_TEXT, type AskView } from "./asks.js";
import { ADAPTERS, pickPermissionOption, type BackendAdapter, type LocalBackendId } from "./backends.js";
import type { AgentHandlers, AgentProcess } from "./acp-process.js";
import { ensurePersona } from "./persona.js";
import { redactAndTruncate, redactedTail } from "./redact.js";
import type { ActiveTurn, ChiefEditor } from "./service.js";

export interface LocalTurnInput {
  message: string;
  backend: LocalBackendId;
  turnId: string;
  clientId: string;
  dataDir: string;
  conversationId?: string;
  contentId?: string;
  onDelta?: (e: { ev: "delta" | "reset" | "done"; text?: string }) => void;
  onProgress?: (e: Record<string, unknown>) => void;
}

type Result = Record<string, unknown>;
const SESSION_TIMEOUT_MS = 90_000;
const WRITE_KINDS = new Set(["edit", "delete", "move", "execute"]);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}超过 ${Math.round(ms / 1000)} 秒没有响应`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

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
    dataDir: input.dataDir, backend: input.backend, status: "running", cards: [], writes: [], aborted: false,
  };
  svc.active = turn;
  return { ok: true, turn, signal: reg.signal };
}

async function prepareConversation(input: LocalTurnInput): Promise<{ id: string; acpSessionId?: string } | { error: string }> {
  if (!input.conversationId) {
    const meta = await createConversation(input.message, input.dataDir, input.contentId, { backend: input.backend });
    return { id: meta.id };
  }
  const conv = await getConversation(input.conversationId, input.dataDir);
  if (!conv) return { error: "会话不存在或已损坏，请新建对话" };
  return { id: conv.meta.id, ...(conv.meta.acpSessionId ? { acpSessionId: conv.meta.acpSessionId } : {}) };
}

function makeHandlers(svc: ChiefEditor, turn: ActiveTurn, input: LocalTurnInput, text: string[]): AgentHandlers {
  const calls = new Map<string, { title: string; kind?: string }>();
  return {
    onUpdate(u) {
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && u.content.text) {
        text.push(u.content.text);
        input.onDelta?.({ ev: "delta", text: u.content.text });
      } else if (u.sessionUpdate === "tool_call" && u.toolCallId) {
        calls.set(u.toolCallId, { title: u.title ?? "工具调用", ...(u.kind ? { kind: u.kind } : {}) });
        input.onProgress?.({ phase: "start", label: redactAndTruncate(u.title ?? "工具调用", 60) });
      } else if (u.sessionUpdate === "tool_call_update" && u.toolCallId && u.status === "completed") {
        const call = calls.get(u.toolCallId);
        if (call?.kind && WRITE_KINDS.has(call.kind)) turn.writes.push(redactAndTruncate(call.title, 60));
      }
    },
    async requestPermission(req) {
      const ask = svc.asks.requestPermission({ turnId: turn.turnId, conversationId: turn.conversationId, title: "允许本机 agent 执行？", detail: req.title });
      return pickPermissionOption(req.options, await ask.decision);
    },
  };
}

/** 起进程、续会话（续不上就新开并说一句）。ACP session id 拿到即落盘 */
async function openSession(svc: ChiefEditor, turn: ActiveTurn, adapter: BackendAdapter, proc: AgentProcess, prior?: string): Promise<{ sessionId: string; notice?: string }> {
  const mcp = { url: svc.deps.mcpUrl, token: turn.token! };
  const init = await withTimeout(proc.initialize(), SESSION_TIMEOUT_MS, "适配器初始化");
  let notice: string | undefined;
  if (prior && init.loadSession) {
    try {
      await withTimeout(proc.loadSession(prior, svc.deps.home, mcp, adapter.sessionMeta()), SESSION_TIMEOUT_MS, "续会话");
      return { sessionId: prior };
    } catch {
      notice = "上次的会话续不上，已新开（之前的上下文 agent 看不到了）";
    }
  } else if (prior) {
    notice = "这个后端不支持续会话，已新开";
  }
  const sessionId = await withTimeout(proc.newSession(svc.deps.home, mcp, adapter.sessionMeta()), SESSION_TIMEOUT_MS, "新建会话");
  await updateConversationAgent(turn.conversationId, { acpSessionId: sessionId }, turn.dataDir);
  svc.runs.patch(turn.turnId, { acpSessionId: sessionId });
  return { sessionId, ...(notice ? { notice } : {}) };
}

/** 进程先退出就当崩溃（§边界 12），不让 prompt 挂死 */
async function promptOrCrash(proc: AgentProcess, sessionId: string, text: string): Promise<{ stopReason: string }> {
  const crashed = proc.exited.then(({ code, signal }) => {
    throw new Error(`适配器进程退出了（code=${code ?? "-"}${signal ? `，signal=${signal}` : ""}）`);
  });
  return Promise.race([proc.prompt(sessionId, text), crashed]);
}

function followupText(asks: AskView[]): string {
  return asks.map((a) => a.status === "approved"
    ? `已批准 approval_id=${a.id}，请用完全相同的参数加上 approval_id 重调刚才那个工具继续。`
    : `approval_id=${a.id} 没有获批（${STATUS_TEXT[a.status]}）：不要执行这个动作，简短告诉创始人你停在哪。`).join("\n");
}

/** prompt → 有待批审批就挂着等（状态 awaiting_approval，整轮持锁）→ 发一句继续 → 循环 */
async function promptLoop(svc: ChiefEditor, turn: ActiveTurn, proc: AgentProcess, sessionId: string, message: string): Promise<string> {
  let r = await promptOrCrash(proc, sessionId, message);
  for (;;) {
    const pending = svc.asks.pendingApprovals(turn.turnId);
    if (pending.length === 0 || turn.aborted) return r.stopReason;
    svc.setStatus(turn, "awaiting_approval");
    const settled = await svc.asks.settledApprovals(turn.turnId, pending.map((a) => a.id));
    if (turn.aborted) return "cancelled";
    svc.setStatus(turn, "running");
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

function failureText(adapter: BackendAdapter, svc: ChiefEditor, err: unknown, proc?: AgentProcess): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (adapter.isAuthError(msg)) {
    svc.authFailed.add(adapter.id);
    return `${adapter.label}未登录或登录已过期：${adapter.loginFix}。不会自动改用内置引擎。`;
  }
  const tail = proc ? redactedTail(proc.stderrTail()) : "";
  return `${adapter.label}出错：${redactAndTruncate(msg, 200)}${tail ? `\n最后几行输出：\n${tail}` : ""}`;
}

interface Outcome { ok: boolean; reply: string; stopReason?: string; notice?: string }

/** 停止时列出停之前已完成的写动作（§边界 2） */
export function stopSummary(writes: string[]): string {
  return `已停。${writes.length ? `停之前已完成的写动作：${writes.join("；")}` : "停之前没有完成任何写动作"}。`;
}

function replyText(turn: ActiveTurn, out: Outcome): string {
  const parts = [out.notice, out.reply || "（agent 没有返回文字，结果见卡片）", turn.aborted ? stopSummary(turn.writes) : ""];
  return parts.filter(Boolean).join("\n\n");
}

async function persistOutcome(svc: ChiefEditor, turn: ActiveTurn, input: LocalTurnInput, out: Outcome): Promise<void> {
  const content = out.ok ? replyText(turn, out) : `⚠️ ${out.reply}`;
  await appendTurn(turn.conversationId, { content: input.message }, { content, cards: turn.cards, turnId: turn.turnId }, turn.dataDir)
    .catch((err) => console.warn(`[chief-editor] 本轮落盘失败：${err instanceof Error ? err.message : String(err)}`));
}

async function execute(svc: ChiefEditor, turn: ActiveTurn, input: LocalTurnInput, adapter: BackendAdapter, signal: AbortSignal): Promise<Outcome> {
  const launch = adapter.launch();
  if (!launch) return { ok: false, reply: `${adapter.label}没装上：在 AutoCrew 目录运行 npm install。不会自动改用内置引擎。` };
  const conv = await prepareConversation(input);
  if ("error" in conv) return { ok: false, reply: conv.error };
  turn.conversationId = conv.id;
  svc.runs.put({ turnId: turn.turnId, clientId: turn.clientId, conversationId: conv.id, dataDir: turn.dataDir, backend: turn.backend, message: input.message, status: "running", startedAt: new Date().toISOString() });
  ensurePersona(svc.deps.home, turn.backend);
  turn.token = svc.issueToken({ backend: turn.backend, dataDir: turn.dataDir, conversationId: conv.id, turnId: turn.turnId });
  const text: string[] = [];
  const proc = svc.deps.spawnAgent(launch, svc.deps.home, makeHandlers(svc, turn, input, text));
  turn.process = proc;
  svc.runs.patch(turn.turnId, { ...(proc.pid ? { pid: proc.pid } : {}), command: proc.command });
  signal.addEventListener("abort", () => stopAgent(svc, turn), { once: true });
  try {
    const session = await openSession(svc, turn, adapter, proc, conv.acpSessionId);
    turn.sessionId = session.sessionId;
    if (signal.aborted) stopAgent(svc, turn);
    const stopReason = turn.aborted ? "cancelled" : await promptLoop(svc, turn, proc, session.sessionId, input.message);
    svc.authFailed.delete(adapter.id);
    return { ok: true, reply: text.join("").trim(), stopReason, ...(session.notice ? { notice: session.notice } : {}) };
  } catch (err) {
    if (turn.aborted) return { ok: true, reply: text.join("").trim(), stopReason: "cancelled" };
    return { ok: false, reply: failureText(adapter, svc, err, proc) };
  }
}

async function finish(svc: ChiefEditor, turn: ActiveTurn, input: LocalTurnInput, out: Outcome): Promise<void> {
  svc.revokeToken(turn.token);
  svc.asks.cancelTurn(turn.turnId);
  turn.process?.kill();
  if (turn.conversationId) {
    svc.runs.patch(turn.turnId, { status: out.ok ? "done" : "failed", endedAt: new Date().toISOString(), cards: turn.cards, writes: turn.writes });
    await persistOutcome(svc, turn, input, out);
  }
  svc.deps.emit({ type: "turn", turnId: turn.turnId, conversationId: turn.conversationId, status: out.ok ? "done" : "failed" });
  input.onDelta?.({ ev: "done" });
  svc.active = null;
  await settleTurn(turn.turnId, { ...(turn.conversationId ? { conversationId: turn.conversationId } : {}), dataDir: turn.dataDir });
}

export async function runLocalTurn(svc: ChiefEditor, input: LocalTurnInput): Promise<Result> {
  const adapter = ADAPTERS[input.backend];
  if (!adapter) return { ok: false, error: `${input.backend} 即将支持，现在请选本机 Claude 或内置引擎` };
  const lock = acquire(svc, input);
  if (!lock.ok) return { ok: false, error: lock.error };
  const { turn } = lock;
  let out: Outcome = { ok: false, reply: "未知错误" };
  try {
    out = await execute(svc, turn, input, adapter, lock.signal);
  } catch (err) {
    out = { ok: false, reply: failureText(adapter, svc, err) };
  } finally {
    await finish(svc, turn, input, out);
  }
  if (!out.ok) return { ok: false, error: out.reply, ...(turn.conversationId ? { data: { conversationId: turn.conversationId } } : {}) };
  const stopReason = turn.aborted ? "aborted" : out.stopReason;
  return { ok: true, data: { reply: replyText(turn, out), cards: turn.cards, conversationId: turn.conversationId, backend: turn.backend, writes: turn.writes, ...(stopReason ? { stopReason } : {}) } };
}
