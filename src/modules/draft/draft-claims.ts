/**
 * 薄路径的写锁（会审 #4）：沿用现有 claims。令牌由服务端按「宿主 + 会话」保管，agent 不用传；
 * 传输层没带会话（`unknown`）时不缓存、不共享——令牌随回执交给调用方，下次写带 claim_token 才算同一个写入方。
 * 这是模型写口：`local-user`（没带 `_host` 的本机调用）也按模型对待，不走工作台的越门放行。
 * 闲置满 10 分钟、带 takeover 才能接管（同宿主或跨宿主都一样），接管换新令牌，旧会话迟到的写入一律被拒。
 * 令牌只存在本进程内存：服务重启后旧令牌失效，原会话要等闲置 10 分钟接管。
 */
import { claimIdleMs, CLAIM_IDLE_TAKEOVER_MS, ensureClaim, takeOverIdleClaim, type ClaimView } from "../../storage/claims.js";
import { tokenMatches } from "../../storage/claim-token.js";
import { getContent, LOCAL_HOST, type ContentClaim } from "../../storage/local-store.js";

export const UNKNOWN_SESSION = "unknown";
/** 没带 `_host` 的本机调用在认领账上记成它：与工作台的 `local-user` 分开，拿不到越门放行 */
export const LOCAL_AGENT_HOST = "local-agent";

const tokens = new Map<string, string>();
const keyOf = (c: DraftCaller, contentId: string) => `${c.dataDir ?? ""}|${contentId}|${c.host}|${c.session}`;
const claimHost = (host: string) => (host === LOCAL_HOST ? LOCAL_AGENT_HOST : host);

export interface DraftCaller { host: string; session: string; dataDir?: string; claimToken?: string }

export type DraftGate =
  | { ok: true; token?: string; issued?: string }
  | { ok: false; code: "claim_held"; error: string; holder?: ClaimView; idle_minutes?: number; next_action?: Record<string, unknown> };

function presented(c: DraftCaller, contentId: string): string | undefined {
  return c.claimToken ?? (c.session === UNKNOWN_SESSION ? undefined : tokens.get(keyOf(c, contentId)));
}

/** 记下这枚令牌：有会话就服务端保管；没会话就只交还给调用方（issued） */
function granted(c: DraftCaller, contentId: string, claim: ContentClaim, fallback?: string): DraftGate {
  const plain = claim.token && !claim.token.startsWith("sha256:") ? claim.token : fallback;
  if (plain && c.session !== UNKNOWN_SESSION) tokens.set(keyOf(c, contentId), plain);
  return { ok: true, token: plain, ...(plain && c.session === UNKNOWN_SESSION ? { issued: plain } : {}) };
}

async function heldRefusal(contentId: string, holder: ClaimView | undefined, dataDir?: string): Promise<DraftGate> {
  const content = await getContent(contentId, dataDir);
  const idle = content?.claim ? Math.floor(claimIdleMs(content.claim) / 60_000) : undefined;
  const canTakeOver = idle !== undefined && idle * 60_000 >= CLAIM_IDLE_TAKEOVER_MS && !content?.claim?.heartbeat;
  return {
    ok: false, code: "claim_held",
    error: `这篇正被另一个会话写着（${holder?.host ?? "未知"}，已闲置 ${idle ?? "?"} 分钟）。${canTakeOver ? "它已闲置满 10 分钟：问创始人这篇归不归你，归你就带 takeover:true 重试。" : "闲置满 10 分钟前不能接管；告诉创始人这篇在别的会话里。"}${content?.claim?.host === claimHost(LOCAL_HOST) ? "没带会话的调用要带上次回执里的 claim_token。" : ""}`,
    ...(holder ? { holder } : {}),
    ...(idle !== undefined ? { idle_minutes: idle } : {}),
    ...(canTakeOver ? { next_action: { note: "创始人同意后带 takeover:true 重调同一个动作" } } : {}),
  };
}

/** 写前过门：过了就续租（令牌由服务端记着或交还调用方），拒了回持有者与闲置分钟。调用方须在 withDraftWrite 锁里调 */
export async function gateDraftWrite(contentId: string, caller: DraftCaller, takeover = false): Promise<DraftGate> {
  const host = claimHost(caller.host);
  const token = presented(caller, contentId);
  const r = await ensureClaim(contentId, { host, employee: "writer", token }, caller.dataDir);
  if (r.ok) return granted(caller, contentId, r.claim, token);
  if (r.code !== "claim_held") return { ok: false, code: "claim_held", error: r.error };
  if (takeover) {
    const taken = await takeOverIdleClaim(contentId, "writer", host, caller.dataDir);
    if (taken.ok) return granted(caller, contentId, taken.claim);
  }
  return heldRefusal(contentId, r.holder, caller.dataDir);
}

/** 写入那一刻再核一次：盘上的认领还是这枚令牌（期间被接管 = 迟到写入，拒） */
export async function fenceDraftWrite(contentId: string, token: string | undefined, dataDir?: string): Promise<boolean> {
  const content = await getContent(contentId, dataDir);
  return Boolean(token && content?.claim && tokenMatches(content.claim.token, token));
}

/** 只给测试 */
export function resetDraftTokens(): void { tokens.clear(); }
