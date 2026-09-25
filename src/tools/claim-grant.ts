/**
 * 写门回执的令牌要跟着 next_action 一起走：宿主照着 next_action 调下一步时，
 * 不该再从上一条回执里手抄 claim_token（漏抄就是一次 claim_held）。
 */
export function withTokenInNextAction<T extends Record<string, unknown>>(result: T): T {
  const token = result.claim_token;
  const next = result.next_action;
  if (typeof token !== "string" || !token || !next || typeof next !== "object") return result;
  const params = (next as Record<string, unknown>).params;
  if (!params || typeof params !== "object") return result;
  return { ...result, next_action: { ...(next as Record<string, unknown>), params: { ...(params as Record<string, unknown>), claim_token: token } } };
}
