/**
 * 看板「重试」回到原写手（v1.2 §做什么 4，边界 X7–X9）。
 *
 * 诊断：本机 agent 写的稿，稿件上的认领记着 host=chief-editor、session=那一轮的 turnId；
 * run 记录（runs.json）按 turnId 记着对话 / 后端。所以：认领主体是总编辑本机 agent → 把「继续写《…》」
 * 发回原对话、交同一个本机后端接着写；原写手是内置引擎才走内置引擎（返回 null 交回原处理器）。
 */
import { getConversation } from "../../storage/conversation-store.js";
import { getContent, LOCAL_HOST } from "../../storage/local-store.js";
import { transferClaim } from "../../storage/claims.js";
import { ADAPTERS, isLocalBackend, proxyUnreachable, type LocalBackendId } from "./backends.js";
import { getChiefEditor, type ChiefEditor } from "./service.js";
import { runLocalTurn } from "./turn.js";

export const CHIEF_EDITOR_HOST = "chief-editor";

type Json = Record<string, unknown>;

/** 找原写手那段对话：认领里的轮次 → run 记录 → 对话还在不在 */
async function originOf(svc: ChiefEditor, session: string | undefined, dataDir: string, contentId?: string): Promise<{ conversationId?: string; backend: LocalBackendId; deleted: boolean }> {
  // 认领交接过后 session 不再是原来那一轮：退回按稿件找最近一次冲它去的轮
  const run = (session ? svc.runs.get(session) : undefined) ?? (contentId ? svc.runs.list().filter((r) => r.contentId === contentId).at(-1) : undefined);
  const backend = run && isLocalBackend(run.backend) ? run.backend : "claude";
  if (!run) return { backend, deleted: false };
  const alive = await getConversation(run.conversationId, dataDir);
  return alive ? { conversationId: run.conversationId, backend, deleted: false } : { backend, deleted: true };
}

/** 发起前就能判的失败：已有 agent 在跑（X9）、后端没装 / 未登录 / 代理没开（X8）。不改走内置引擎 */
async function preflight(svc: ChiefEditor, backend: LocalBackendId): Promise<string | null> {
  if (svc.active) return "已有一个本机 agent 在跑，不排队——等它结束或先去那段对话点停止，再点重试";
  const adapter = ADAPTERS[backend];
  if (!adapter) return `${backend} 即将支持，这篇没法由它接着写`;
  if (!adapter.launch()) return `${adapter.label}没装上：在 AutoCrew 目录运行 npm install。不会改用内置引擎。`;
  const problem = adapter.launchProblem?.();
  if (problem) return problem;
  // 「上次报未登录」只是提示不是禁令：创始人可能已经重新登录了，让这一轮真去试（评审 v1.2 P2-9）
  const routing = adapter.routingEnv?.(svc.deps.claudeSettingsPath) ?? { env: {} };
  if ("error" in routing) return routing.error;
  return proxyUnreachable(routing.env);
}

/**
 * 认领交接（评审 v1.2 P2-5）：原来那一轮已经停了（不在跑、不在等审批），它手里的认领令牌再也用不上；
 * 系统以本机主体把认领转给这次重试，新令牌只交给接手的 agent（进 prompt，不进卡片 / 日志 / SSE）。
 * 原来那一轮还在跑就不动——那不是「中断的稿」。
 */
async function handoffClaim(svc: ChiefEditor, contentId: string, session: string | undefined, dataDir: string): Promise<{ token?: string } | { error: string }> {
  const run = session ? svc.runs.get(session) : undefined;
  if (svc.active?.turnId === session || run?.status === "running" || run?.status === "awaiting_approval") {
    return { error: "写这篇的那一轮还在跑，等它结束或先停止再重试" };
  }
  const moved = await transferClaim(contentId, { host: LOCAL_HOST, toHost: CHIEF_EDITOR_HOST, toEmployee: "writer", note: "重试：原轮次已停，交给接手的本机 agent" }, dataDir);
  if (!moved.ok) return { error: moved.error };
  return { token: moved.claim.token };
}

/**
 * 本机 agent 写的稿 → 发回原对话接着写（这一轮在后台跑，右栏由发起的标签页持有，可停止）；
 * 不是本机 agent 写的 → null，交回内置引擎的重试。
 * 返回的 ok 是**真的接上了锁**才算：检查完到起轮之间别的轮抢先拿了锁，就如实报错（评审 v1.2 P2-3）。
 */
export async function routeRetryToAgent(contentId: string, dataDir: string, clientId = "board-retry"): Promise<Json | null> {
  const content = await getContent(contentId, dataDir);
  const writtenBy = (content as { writtenBy?: { kind?: string; host?: string } } | null)?.writtenBy;
  const claim = content?.claim as { host?: string; session?: string } | undefined;
  const byAgent = claim?.host === CHIEF_EDITOR_HOST || (writtenBy?.kind === "host" && writtenBy.host === CHIEF_EDITOR_HOST);
  if (!content || !byAgent) return null;
  const svc = getChiefEditor();
  if (!svc) return { ok: false, error: "这篇是本机 agent 写的，只能在本地守护进程里接着写" };
  const origin = await originOf(svc, claim?.session, dataDir, contentId);
  const blocked = await preflight(svc, origin.backend);
  if (blocked) return { ok: false, error: blocked };
  const handed = claim?.host === CHIEF_EDITOR_HOST ? await handoffClaim(svc, contentId, claim.session, dataDir) : {};
  if ("error" in handed) return { ok: false, error: handed.error };
  const note = origin.deleted ? "（原对话已删除，新开了一段接着写）" : !origin.conversationId ? "（找不到原对话，新开了一段接着写）" : "";
  // 标题上的「［生成中断］」这类状态前缀不是稿名
  const message = `继续写《${content.title.replace(/^［[^］]*］\s*/, "")}》${note}`;
  const turnId = `retry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const claimLine = handed.token ? `这篇的认领已交给你，之后对它的每次写都带上 claim_token=${handed.token}。` : "";
  const turn = runLocalTurn(svc, {
    message, backend: origin.backend, turnId, clientId, dataDir, contentId,
    ...(origin.conversationId ? { conversationId: origin.conversationId } : {}),
    promptContext: `【重试】这篇稿（${contentId}）上一轮被中断了。先用 autocrew_content get 看它现在的状态，从中断处接着写完，不要从头另起一篇。${claimLine}\n\n`,
  });
  // runLocalTurn 同步拿锁：此刻不是本轮在跑，就是被抢先了——等它的拒绝原因回来如实转给调用方
  if (svc.active?.turnId !== turnId) {
    const r = await turn;
    return { ok: false, error: String(r.error ?? "这一轮没起来") };
  }
  void turn.then((r) => { if (r.ok === false) console.warn(`[chief-editor] 重试这一轮失败：${String(r.error)}`); }, (err) => console.warn(`[chief-editor] 重试这一轮失败：${err instanceof Error ? err.message : String(err)}`));
  return { ok: true, pending: true, routed: "local", contentId, turnId, ...(origin.conversationId ? { conversationId: origin.conversationId } : {}), message };
}
