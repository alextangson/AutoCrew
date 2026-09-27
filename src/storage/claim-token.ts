/**
 * 认领令牌只存哈希（P6 §12.4-D「交接文件里也不写令牌」；3a 评审发现 meta.json 在共享项目文件夹里带明文）。
 *
 * 记录里的 `claim.token` 是 `sha256:<hex>`；明文只在签发/续租那一刻回给调用方。
 * 旧记录里的明文照样认（持有者不断），读到就换成哈希，下一次写盘即落成哈希。
 */
import { createHash } from "node:crypto";

const PREFIX = "sha256:";

export function hashClaimToken(token: string): string {
  return token.startsWith(PREFIX) ? token : PREFIX + createHash("sha256").update(token).digest("hex");
}

export function isHashedToken(stored: string | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

/** 记录里的令牌（哈希或旧明文）对得上调用方手里的明文吗 */
export function tokenMatches(stored: string | undefined, presented: string | undefined): boolean {
  if (!stored || !presented || presented.startsWith(PREFIX)) return false;
  return isHashedToken(stored) ? stored === hashClaimToken(presented) : stored === presented;
}

/** 落盘/读入前的统一处理：顶层 claim 的明文令牌换成哈希；其余原样 */
export function withHashedClaim<T>(record: T): T {
  const claim = (record as { claim?: { token?: unknown } } | null)?.claim;
  if (!claim || typeof claim.token !== "string" || isHashedToken(claim.token)) return record;
  return { ...record, claim: { ...claim, token: hashClaimToken(claim.token) } };
}
