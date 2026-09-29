/**
 * 看板「重试」回到原写手（v1.2 §做什么 4，边界 X7–X9）。
 *
 * 诊断：本机 agent 写的稿，稿件上的认领记着 host=chief-editor、session=那一轮的 turnId；
 * run 记录（runs.json）按 turnId 记着对话 / 后端。所以：认领主体是总编辑本机 agent → 把「继续写《…》」
 * 发回原对话、交同一个本机后端接着写；原写手是内置引擎才走内置引擎（返回 null 交回原处理器）。
 */
import { getConversation } from "../../storage/conversation-store.js";
import { getContent } from "../../storage/local-store.js";
import { ADAPTERS, isLocalBackend, proxyUnreachable, type LocalBackendId } from "./backends.js";
import { getChiefEditor, type ChiefEditor } from "./service.js";
import { runLocalTurn } from "./turn.js";

export const CHIEF_EDITOR_HOST = "chief-editor";

type Json = Record<string, unknown>;

/** 找原写手那段对话：认领里的轮次 → run 记录 → 对话还在不在 */
async function originOf(svc: ChiefEditor, session: string | undefined, dataDir: string): Promise<{ conversationId?: string; backend: LocalBackendId; deleted: boolean }> {
  const run = session ? svc.runs.get(session) : undefined;
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
  if (svc.authFailed.has(backend)) return `${adapter.label}未登录或登录已过期：${adapter.loginFix}。不会改用内置引擎。`;
  const routing = adapter.routingEnv?.(svc.deps.claudeSettingsPath) ?? { env: {} };
  if ("error" in routing) return routing.error;
  return proxyUnreachable(routing.env);
}

/**
 * 本机 agent 写的稿 → 发回原对话接着写，立即返回（这一轮在后台跑，右栏按「旁观」重挂）；
 * 不是本机 agent 写的 → null，交回内置引擎的重试。
 */
export async function routeRetryToAgent(contentId: string, dataDir: string): Promise<Json | null> {
  const content = await getContent(contentId, dataDir);
  const writtenBy = (content as { writtenBy?: { kind?: string; host?: string } } | null)?.writtenBy;
  const claim = content?.claim as { host?: string; session?: string } | undefined;
  const byAgent = claim?.host === CHIEF_EDITOR_HOST || (writtenBy?.kind === "host" && writtenBy.host === CHIEF_EDITOR_HOST);
  if (!content || !byAgent) return null;
  const svc = getChiefEditor();
  if (!svc) return { ok: false, error: "这篇是本机 agent 写的，只能在本地守护进程里接着写" };
  const origin = await originOf(svc, claim?.session, dataDir);
  const blocked = await preflight(svc, origin.backend);
  if (blocked) return { ok: false, error: blocked };
  const note = origin.deleted ? "（原对话已删除，新开了一段接着写）" : !origin.conversationId ? "（找不到原对话，新开了一段接着写）" : "";
  // 标题上的「［生成中断］」这类状态前缀不是稿名
  const message = `继续写《${content.title.replace(/^［[^］]*］\s*/, "")}》${note}`;
  const turnId = `retry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const turn = runLocalTurn(svc, {
    message, backend: origin.backend, turnId, clientId: "board-retry", dataDir, contentId,
    ...(origin.conversationId ? { conversationId: origin.conversationId } : {}),
    promptContext: `【重试】这篇稿（${contentId}）上一轮被中断了。先用 autocrew_content get 看它现在的状态，从中断处接着写完，不要从头另起一篇。\n\n`,
  });
  void turn.catch((err) => console.warn(`[chief-editor] 重试这一轮失败：${err instanceof Error ? err.message : String(err)}`));
  return { ok: true, pending: true, routed: "local", contentId, ...(origin.conversationId ? { conversationId: origin.conversationId } : {}), message };
}
