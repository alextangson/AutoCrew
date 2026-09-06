/**
 * 认领与租约（P3 spec §6.1）——多宿主协作里唯一的硬门。
 *
 * 一句话：**认领是软门，令牌是硬门**。没人认领时谁写都行（单人单机不设卡），写完顺手把
 * 认领记上，这样工作台看得见「谁在干」；已经有人认领时，别的宿主必须带匹配的 `claim_token`，
 * 否则当场被拒并告诉他持有者是谁、还剩几分钟。
 *
 * 租约 30 分钟，任何带匹配令牌（或同宿主）的写操作自动续租。过期即可被接管——**接管换新令牌**，
 * 旧令牌的迟到写入随即被拒，这就是 fencing（codex 评审 #2：没有 fencing 的认领挡不住迟到写入）。
 * 接管会在 `handoffs[]` 留一条账，不静默换人。
 *
 * `local-user` 是创始人自己（工作台、老配置）：他越得过令牌门（deliverable：工作台不许因为
 * 宿主认领而写不动自己的稿），但**不抢**别人手上还活着的认领——抢了工作台就再也看不见
 * 「Codex 封面中」这条真相。
 */
import {
  getContent,
  updateContent,
  withHandoff,
  LOCAL_HOST,
  type ClaimEmployee,
  type Content,
  type ContentClaim,
} from "./local-store.js";

/** 租约 30 分钟（§6.1 创始人裁决 4）。视频线的 runner 租约是 10 分钟，两条线各按各的节奏 */
export const CLAIM_LEASE_MS = 30 * 60_000;

/** 视图里的认领：**没有 token**。工具回执与看板一律用这个形状 */
export type ClaimView = Omit<ContentClaim, "token">;

const EMPLOYEE_LABEL: Record<ClaimEmployee, string> = {
  writer: "写手",
  cover: "封面师",
  editor: "剪辑师",
};

export function isClaimEmployee(value: unknown): value is ClaimEmployee {
  return value === "writer" || value === "cover" || value === "editor";
}

function newClaimToken(): string {
  return `clm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function leaseUntil(fromMs: number): string {
  return new Date(fromMs + CLAIM_LEASE_MS).toISOString();
}

/** 还活着的认领；过期 = 等于没人认领（判定只有这一处，别处不许自己算） */
export function activeClaim(content: Pick<Content, "claim">, now: number = Date.now()): ContentClaim | null {
  const claim = content.claim;
  if (!claim?.token) return null;
  const until = Date.parse(claim.leaseUntil);
  if (Number.isNaN(until) || until <= now) return null;
  return claim;
}

export function claimMinutesLeft(claim: ContentClaim, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(claim.leaseUntil) - now) / 60_000));
}

/** 去掉令牌的认领。`claim` 出现在任何回执/视图里都必须先过这一道 */
export function claimView(claim?: ContentClaim): ClaimView | undefined {
  if (!claim) return undefined;
  const { token: _token, ...rest } = claim;
  return rest;
}

/** 整篇稿的脱敏拷贝：list/get 视图用（令牌只回给认领者本人） */
export function redactClaim<T extends { claim?: ContentClaim }>(content: T): T {
  if (!content.claim) return content;
  return { ...content, claim: claimView(content.claim) as unknown as ContentClaim };
}

export function holderMessage(claim: ContentClaim, now: number = Date.now()): string {
  return (
    `这篇正由 ${claim.host} 处理（${EMPLOYEE_LABEL[claim.employee] ?? claim.employee}，` +
    `还剩 ${claimMinutesLeft(claim, now)} 分钟）——等他 release，或租约到期后用 ` +
    `autocrew_desk claim 接管；你手上有他给的 claim_token 就带上再试`
  );
}

export type ClaimGate = { ok: true } | { ok: false; error: string; holder: ClaimView };

/**
 * 令牌门（§6.1）。放行的三种情形：没人认领 / 认领人就是你（同宿主）/ 你带着匹配的令牌。
 * `local-user` 额外放行——那是创始人本人坐在工作台前，不该被自己雇的宿主锁在门外。
 */
export function assertClaimToken(content: Pick<Content, "claim">, host: string, token?: string): ClaimGate {
  const claim = activeClaim(content);
  if (!claim) return { ok: true };
  if (claim.host === host) return { ok: true };
  if (token && token === claim.token) return { ok: true };
  if (host === LOCAL_HOST) return { ok: true };
  return { ok: false, error: holderMessage(claim), holder: claimView(claim)! };
}

/** 写认领：续约沿用同一枚令牌，接管换新令牌并在 `handoffs[]` 记一条 */
async function writeClaim(
  content: Content,
  employee: ClaimEmployee,
  host: string,
  dataDir: string | undefined,
  now: number,
): Promise<ContentClaim> {
  const current = activeClaim(content, now);
  const mine = current && (current.host === host);
  const claim: ContentClaim = {
    employee,
    host,
    token: mine ? current!.token : newClaimToken(),
    at: mine ? current!.at : new Date(now).toISOString(),
    leaseUntil: leaseUntil(now),
  };
  // 接管（旧租约已过期且换了宿主）不许静默：账上记一条，稿卡才说得出「租约过期，Codex 接管」
  const takenOver = !current && content.claim?.host && content.claim.host !== host;
  const handoffs = takenOver
    ? withHandoff(content, {
        from: content.claim!.host,
        to: host,
        by: host,
        at: new Date(now).toISOString(),
        note: "接管（租约过期）",
      })
    : undefined;
  await updateContent(content.id, { claim, ...(handoffs ? { handoffs } : {}) }, dataDir);
  return claim;
}

export type ClaimResult =
  | { ok: true; claim: ContentClaim }
  | { ok: false; error: string; holder?: ClaimView };

/**
 * `autocrew_desk claim`（§6.1）：别的宿主还握着未过期的租约就拒绝并返回持有者；
 * 同宿主重复 claim = 续约、返回同一枚令牌。**明确的认领不给 `local-user` 开后门**——
 * 两边同时认领时第二个必须看见拒绝，这正是这条命令要证明的事。
 */
export async function claimContent(
  contentId: string,
  employee: ClaimEmployee,
  host: string,
  dataDir?: string,
): Promise<ClaimResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `稿件不存在：${contentId}` };
  const now = Date.now();
  const current = activeClaim(content, now);
  if (current && current.host !== host) {
    return { ok: false, error: holderMessage(current, now), holder: claimView(current)! };
  }
  return { ok: true, claim: await writeClaim(content, employee, host, dataDir, now) };
}

/** `autocrew_desk release`：令牌对得上才清（对不上就是别人的活，不许替他放手） */
export async function releaseClaim(
  contentId: string,
  token: string,
  dataDir?: string,
): Promise<{ ok: true; released: boolean } | { ok: false; error: string; holder?: ClaimView }> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `稿件不存在：${contentId}` };
  if (!content.claim) return { ok: true, released: false };
  if (content.claim.token !== token) {
    return {
      ok: false,
      error: `claim_token 对不上：这篇现在记在 ${content.claim.host} 名下，只有他手上那枚令牌能释放`,
      holder: claimView(content.claim)!,
    };
  }
  await updateContent(contentId, { claim: undefined }, dataDir);
  return { ok: true, released: true };
}

export interface ClaimGuardInput {
  host: string;
  /** 缺省 = 沿用现有认领的岗位，再缺省 `writer`（`autocrew_content` 这类跨岗位的写口用它） */
  employee?: ClaimEmployee;
  token?: string;
}

/**
 * 写操作的统一入口（§6.1）：先过令牌门，过了就自动认领/续租。
 *
 * 「过了就写认领」是软门那一半：没人认领时直接执行**并把认领记上**，
 * 工作台据此出「Claude 写」「Codex 封面中」的徽章；不记就等于谁也不知道谁在干。
 * 越门而过的 `local-user` 不抢别人还活着的认领——抢了就把真相盖掉了。
 */
export async function ensureClaim(
  contentId: string,
  input: ClaimGuardInput,
  dataDir?: string,
): Promise<ClaimResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `稿件不存在：${contentId}` };
  const gate = assertClaimToken(content, input.host, input.token);
  if (!gate.ok) return { ok: false, error: gate.error, holder: gate.holder };

  const now = Date.now();
  const current = activeClaim(content, now);
  const ours = current && (current.host === input.host || (input.token && input.token === current.token));
  if (current && !ours) {
    // `local-user` 越门而过：认领仍归原主，工作台照旧显示持有者
    return { ok: true, claim: current };
  }
  const employee = input.employee ?? current?.employee ?? content.claim?.employee ?? "writer";
  // 带着别人令牌来的宿主接手的是同一枚令牌那份认领：沿用它的 host，别把账记到自己头上
  const host = current && current.host !== input.host && input.token === current.token ? current.host : input.host;
  return { ok: true, claim: await writeClaim(content, employee, host, dataDir, now) };
}
