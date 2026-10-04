/**
 * 薄路径的写锁（会审 #4）：沿用现有 claims，只是令牌由服务端按「宿主 + 会话」保管，agent 不用传。
 * 第一次写（save / angle / cite / prepare_final）自动认领；别的会话来写收到持有者与闲置分钟；
 * 闲置满 10 分钟带 takeover 才能接管（claimContent 判闲置），接管换新令牌，旧会话迟到的写入一律被拒。
 * 令牌只存在本进程内存：服务重启后旧令牌失效，原会话要等闲置 10 分钟接管（与 claims 的 fencing 一致）。
 */
import { CLAIM_IDLE_TAKEOVER_MS, claimContent, claimIdleMs, ensureClaim, type ClaimView } from "../../storage/claims.js";
import { getContent, type ContentClaim } from "../../storage/local-store.js";

const tokens = new Map<string, string>();
const keyOf = (dataDir: string | undefined, contentId: string, host: string, session: string) => `${dataDir ?? ""}|${contentId}|${host}|${session}`;

export interface DraftCaller { host: string; session: string; dataDir?: string }

export type DraftGate =
  | { ok: true }
  | { ok: false; code: "claim_held"; error: string; holder?: ClaimView; idle_minutes?: number; next_action?: Record<string, unknown> };

function remember(caller: DraftCaller, contentId: string, claim: ContentClaim): void {
  if (claim.token && !claim.token.startsWith("sha256:")) tokens.set(keyOf(caller.dataDir, contentId, caller.host, caller.session), claim.token);
}

async function heldRefusal(contentId: string, error: string, holder: ClaimView | undefined, dataDir?: string): Promise<DraftGate> {
  const content = await getContent(contentId, dataDir);
  const idle = content?.claim ? Math.floor(claimIdleMs(content.claim) / 60_000) : undefined;
  const canTakeOver = idle !== undefined && idle * 60_000 >= CLAIM_IDLE_TAKEOVER_MS;
  return {
    ok: false, code: "claim_held",
    error: `这篇正被另一个会话写着（${holder?.host ?? "未知"}，已闲置 ${idle ?? "?"} 分钟）。${canTakeOver ? "它已闲置满 10 分钟：问创始人这篇归不归你，归你就带 takeover:true 重试。" : "闲置满 10 分钟前不能接管；告诉创始人这篇在别的会话里。"}`,
    ...(holder ? { holder } : {}),
    ...(idle !== undefined ? { idle_minutes: idle } : {}),
    ...(canTakeOver ? { next_action: { note: "创始人同意后带 takeover:true 重调同一个动作" } } : {}),
  };
}

/** 写前过门：过了就续租（令牌由服务端记着），拒了回持有者与闲置分钟 */
export async function gateDraftWrite(contentId: string, caller: DraftCaller, takeover = false): Promise<DraftGate> {
  const key = keyOf(caller.dataDir, contentId, caller.host, caller.session);
  const r = await ensureClaim(contentId, { host: caller.host, employee: "writer", token: tokens.get(key) }, caller.dataDir);
  if (r.ok) { remember(caller, contentId, r.claim); return { ok: true }; }
  if (r.code !== "claim_held") return { ok: false, code: "claim_held", error: r.error };
  if (takeover) {
    const taken = await claimContent(contentId, "writer", caller.host, caller.dataDir, { takeover: true });
    if (taken.ok) { remember(caller, contentId, taken.claim); return { ok: true }; }
  }
  return heldRefusal(contentId, r.error, r.holder, caller.dataDir);
}

/** 只给测试 */
export function resetDraftTokens(): void { tokens.clear(); }
