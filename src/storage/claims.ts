/**
 * 认领与租约（P3 spec §6.1；P6 spec §3.8 写门）——多宿主协作里唯一的硬门。
 *
 * 一句话：**认领是软门，令牌是凭据**。没人认领时谁写都行（单人单机不设卡），写完顺手把
 * 认领记上、把令牌回给写的人；已经有人认领时，写操作必须带匹配的 `claim_token`——
 * **同宿主也不例外**（P6 §3.8：两个 Claude 会话共用一个宿主名，宿主名分不开它们，只有令牌分得开），
 * 否则当场被拒并告诉他持有者是谁、还剩几分钟。
 *
 * 租约 30 分钟，任何带匹配令牌的写操作自动续租。过期即可被接管——**接管换新令牌**，
 * 旧令牌的迟到写入随即被拒，这就是 fencing（codex 评审 #2：没有 fencing 的认领挡不住迟到写入）。
 * 同宿主的另一个会话要抢活只能明说 `takeover:true`；交接（`transferClaim`）把认领连同新令牌
 * 转给下一岗。接管、转交都在 `handoffs[]` 留一条账，不静默换人。
 *
 * `local-user` 是创始人自己（工作台、老配置）：他越得过令牌门（deliverable：工作台不许因为
 * 宿主认领而写不动自己的稿），但每次越过别人的认领都在 `handoffs[]` 记 `override:true`；
 * 他也**不抢**别人手上还活着的认领——抢了工作台就再也看不见「Codex 封面中」这条真相。
 */
import {
  getContent,
  updateContent,
  withHandoff,
  LOCAL_HOST,
  type ClaimEmployee,
  type Content,
  type ContentClaim,
  type ContentHandoff,
} from "./local-store.js";
import { callerSession } from "../runtime/run-log.js";
import os from "node:os";
import { resolveContentProject } from "./content-project.js";

/** 租约 30 分钟（§6.1 创始人裁决 4）。视频线的 runner 租约是 10 分钟，两条线各按各的节奏 */
export const CLAIM_LEASE_MS = 30 * 60_000;

/**
 * 同宿主接管的闲置门槛（P6-e 行为 eval claim-held-asks 0/3）：`takeover:true` 是模型自填的 flag，
 * 3/3 trial 都没问用户就接管了。所以接管不再看 flag 本身，而看持有会话是否真的闲置：
 * 最近一次带令牌写入距今不足 10 分钟，一律 claim_held。
 */
export const CLAIM_IDLE_TAKEOVER_MS = 10 * 60_000;

/**
 * 交接签发的剪辑认领（P6 §12.4-D）：持有者靠 `report` 心跳续租，48 小时没心跳才过期（进 stale）。
 * 不走 10 分钟闲置接管；接管必须创始人在弹窗里确认，旧令牌随即作废。
 */
export const EDITING_LEASE_MS = 48 * 60 * 60_000;

/** 持有会话闲置了多久（没有 lastWriteAt 的老认领按认领时刻算） */
export function claimIdleMs(claim: ContentClaim, now: number = Date.now()): number {
  const last = Date.parse(claim.lastWriteAt ?? claim.at);
  return Number.isNaN(last) ? Number.POSITIVE_INFINITY : Math.max(0, now - last);
}

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

function leaseUntil(fromMs: number, heartbeat = false): string {
  return new Date(fromMs + (heartbeat ? EDITING_LEASE_MS : CLAIM_LEASE_MS)).toISOString();
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

/** 拒绝话术：同宿主的另一个会话要知道「带令牌或 takeover」，别的宿主照旧看持有者 */
function refusalMessage(claim: ContentClaim, host: string, now: number = Date.now()): string {
  if (claim.host !== host) return holderMessage(claim, now);
  return (
    `这篇由同宿主的另一个会话认领着（${EMPLOYEE_LABEL[claim.employee] ?? claim.employee}，` +
    `还剩 ${claimMinutesLeft(claim, now)} 分钟，${Math.floor(claimIdleMs(claim, now) / 60_000)} 分钟没写入），带上它的 claim_token；` +
    `takeover:true 只在它闲置满 ${CLAIM_IDLE_TAKEOVER_MS / 60_000} 分钟后才生效，否则问用户这条稿归哪个会话`
  );
}

export type ClaimGate =
  | { ok: true; override?: boolean }
  | { ok: false; error: string; code: "claim_held"; holder: ClaimView };

/**
 * 令牌门（P6 §3.8）。放行：没人认领 / 你带着匹配的令牌。同宿主**不**放行——宿主名下可能是另一个会话。
 * `local-user` 额外放行（创始人本人坐在工作台前，不该被自己雇的宿主锁在门外），
 * 越过别人的活认领时标 `override`，由调用方记账；认领本来就在工作台名下则不算越门。
 */
export function assertClaimToken(content: Pick<Content, "claim">, host: string, token?: string): ClaimGate {
  const claim = activeClaim(content);
  if (!claim) return { ok: true };
  if (token && token === claim.token) return { ok: true };
  if (host === LOCAL_HOST) return claim.host === LOCAL_HOST ? { ok: true } : { ok: true, override: true };
  return { ok: false, code: "claim_held", error: refusalMessage(claim, host), holder: claimView(claim)! };
}

interface ClaimWrite {
  employee: ClaimEmployee;
  host: string;
  /** true = 续租，沿用活认领的令牌；false = 发新令牌（首次认领、接管、转交） */
  renew: boolean;
  /** 非常规换人的账；缺省只在「租约过期、换了宿主」时自动记一条 */
  handoff?: Omit<ContentHandoff, "at">;
  /** 交接签发的剪辑认领（心跳续租 48 小时）；续租时沿用原认领的这一项 */
  heartbeat?: boolean;
}

/**
 * 会话归因（P6 §3.8，只做诊断）：这次 MCP 调用带来的会话 nonce 记到认领与交接账上。
 * 不在 MCP 调用里（工作台、后台任务）就什么都不加——没有会话不等于「unknown 会话」。
 */
function withSession<T extends object>(entry: T): T & { session?: string } {
  const session = callerSession();
  return session ? { ...entry, session } : entry;
}

/** 租约过期后被别的宿主拿走：账上记一条，稿卡才说得出「租约过期，Codex 接管」 */
function expiredTakeover(content: Content, current: ContentClaim | null, host: string): Omit<ContentHandoff, "at"> | null {
  const previous = content.claim?.host;
  if (current || !previous || previous === host) return null;
  return { from: previous, to: host, by: host, note: "接管（租约过期）" };
}

/** 写认领：续租沿用同一枚令牌，其余一律换新令牌；换人在 `handoffs[]` 记一条 */
async function writeClaim(
  content: Content,
  write: ClaimWrite,
  dataDir: string | undefined,
  now: number,
): Promise<ContentClaim> {
  const current = activeClaim(content, now);
  const kept = write.renew ? current : null;
  const heartbeat = write.heartbeat ?? Boolean(kept?.heartbeat);
  const at = new Date(now).toISOString();
  const project = resolveContentProject(content.id, dataDir);
  const claim: ContentClaim = withSession({
    ...(project ? { machine: os.hostname(), bindingRevision: project.binding_revision } : {}),
    employee: write.employee,
    host: write.host,
    token: kept ? kept.token : newClaimToken(),
    at: kept ? kept.at : at,
    leaseUntil: leaseUntil(now, heartbeat),
    lastWriteAt: at,
    ...(heartbeat ? { heartbeat: true } : {}),
  });
  const handoff = write.handoff ?? expiredTakeover(content, current, write.host);
  const handoffs = handoff ? withHandoff(content, withSession({ ...handoff, at })) : undefined;
  await updateContent(content.id, { claim, ...(handoffs ? { handoffs } : {}) }, dataDir);
  return claim;
}

export type ClaimResult =
  | { ok: true; claim: ContentClaim; override?: boolean }
  | { ok: false; error: string; code?: "claim_held"; holder?: ClaimView };

function held(claim: ContentClaim, host: string, now: number): ClaimResult {
  return { ok: false, code: "claim_held", error: refusalMessage(claim, host, now), holder: claimView(claim)! };
}

export interface ClaimOptions {
  /** 手上那枚令牌：对得上 = 续租，令牌不变 */
  token?: string;
  /** 同宿主另一个会话明说要接手：发新令牌并记一条交接，旧令牌随即作废 */
  takeover?: boolean;
  /** 剪辑认领的接管：创始人已在本机弹窗里点了确认（只由 desk 工具在真弹窗之后传） */
  founderConfirmed?: boolean;
}

/**
 * `autocrew_desk claim`（§6.1 / P6 §3.8）：别的宿主还握着未过期的租约就拒绝并返回持有者；
 * 同宿主带着匹配令牌 = 续约、返回同一枚令牌；同宿主不带令牌 = `claim_held`，
 * 除非 `takeover:true`。**明确的认领不给 `local-user` 开后门**——两边同时认领时第二个
 * 必须看见拒绝，这正是这条命令要证明的事。
 */
export async function claimContent(
  contentId: string,
  employee: ClaimEmployee,
  host: string,
  dataDir?: string,
  opts: ClaimOptions = {},
): Promise<ClaimResult> {
  return serializeClaim(contentId, () => claimContentLocked(contentId, employee, host, dataDir, opts));
}
const claimQueues = new Map<string, Promise<unknown>>();
function serializeClaim<T>(id: string, task: () => Promise<T>): Promise<T> {
  const next = (claimQueues.get(id) ?? Promise.resolve()).then(task, task);
  claimQueues.set(id, next);
  const done = () => { if (claimQueues.get(id) === next) claimQueues.delete(id); };
  next.then(done, done);
  return next;
}
async function claimContentLocked(contentId: string, employee: ClaimEmployee, host: string, dataDir: string | undefined, opts: ClaimOptions): Promise<ClaimResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `稿件不存在：${contentId}` };
  const now = Date.now();
  const current = activeClaim(content, now);
  if (!current) return { ok: true, claim: await writeClaim(content, { employee, host, renew: false }, dataDir, now) };
  if (current.host !== host) return held(current, host, now);
  if (opts.token && opts.token === current.token) {
    return { ok: true, claim: await writeClaim(content, { employee, host, renew: true }, dataDir, now) };
  }
  if (!opts.takeover) return held(current, host, now);
  if (current.heartbeat) {
    // 剪辑认领不看闲置：只有创始人在弹窗里点了确认才换人，旧令牌当场作废
    if (!opts.founderConfirmed) return held(current, host, now);
    const handoff = { from: current.host, to: host, by: host, note: "接管剪辑认领（创始人弹窗确认）" };
    return { ok: true, claim: await writeClaim(content, { employee, host, renew: false, handoff, heartbeat: true }, dataDir, now) };
  }
  // 接管看的是持有会话是否真闲置，不是 flag：10 分钟内还在写就照样拒
  if (claimIdleMs(current, now) < CLAIM_IDLE_TAKEOVER_MS) return held(current, host, now);
  const handoff = { from: current.host, to: host, by: host, note: "接管（同宿主另一会话）" };
  return { ok: true, claim: await writeClaim(content, { employee, host, renew: false, handoff }, dataDir, now) };
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

export interface TransferInput {
  /** 交出方手上的令牌（`local-user` 或没人认领时可省） */
  token?: string;
  /** 调用方宿主（记账用的 by） */
  host: string;
  toEmployee: ClaimEmployee;
  toHost: string;
  note?: string;
  /** 交接签发的剪辑认领：心跳续租 48 小时，不走闲置接管 */
  heartbeat?: boolean;
}

/**
 * 交接即转移（P6 §3.8）：把认领从写手/claude-code 转给剪辑师/codex 这类下一岗。
 * 调用方得先过令牌门（匹配令牌 / `local-user` / 没人认领）；转过去的认领**发新令牌**，
 * 旧令牌当场作废，迟到写入被拒。返回的 claim 带令牌——给谁看由调用方决定。
 */
export async function transferClaim(contentId: string, input: TransferInput, dataDir?: string): Promise<ClaimResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `稿件不存在：${contentId}` };
  const gate = assertClaimToken(content, input.host, input.token);
  if (!gate.ok) return { ok: false, error: gate.error, code: gate.code, holder: gate.holder };
  const now = Date.now();
  const current = activeClaim(content, now);
  const fromHost = current?.host ?? input.host;
  const route = `${fromHost} → ${input.toHost}`;
  const handoff: Omit<ContentHandoff, "at"> = {
    from: current?.employee ?? input.host,
    to: input.toEmployee,
    by: input.host,
    note: input.note ? `${input.note}（${route}）` : `认领转交（${route}）`,
    ...(gate.override ? { override: true } : {}),
  };
  const write = { employee: input.toEmployee, host: input.toHost, renew: false, handoff, ...(input.heartbeat ? { heartbeat: true } : {}) };
  return { ok: true, claim: await writeClaim(content, write, dataDir, now) };
}

/**
 * 失败的交接把认领恢复成调用前那一份（P6 §13.4-D）：原持有者、原令牌原样放回，
 * 不是再「转交」一次——转交会发新令牌，调用方手里那枚就作废了（09-26 实测的 claim_held）。
 * 只在认领仍是这次交接写下的那一枚（`heldToken`）时才恢复；别人已经改过就不碰，返回 false。
 * 调用前没有认领 → 清掉这次写下的认领。交接台账记一条，不静默。
 */
export async function restoreClaim(
  contentId: string,
  prior: ContentClaim | undefined,
  heldToken: string,
  note: string,
  dataDir?: string,
): Promise<boolean> {
  const content = await getContent(contentId, dataDir);
  if (!content?.claim || content.claim.token !== heldToken) return false;
  if (prior && prior.token === heldToken && prior.host === content.claim.host && prior.employee === content.claim.employee) return true;
  const handoff = withSession({
    from: content.claim.employee,
    to: prior?.employee ?? content.claim.employee,
    by: content.claim.host,
    note: `${note}（认领恢复为交接前${prior ? `：${prior.host}` : "：无人认领"}）`,
    at: new Date().toISOString(),
  });
  await updateContent(contentId, { claim: prior, handoffs: withHandoff(content, handoff) }, dataDir);
  return true;
}

export interface ClaimGuardInput {
  host: string;
  /** 缺省 = 沿用现有认领的岗位，再缺省 `writer`（`autocrew_content` 这类跨岗位的写口用它） */
  employee?: ClaimEmployee;
  token?: string;
}

/**
 * 写操作的统一入口（§6.1 / P6 §3.8）：先过令牌门，过了就自动认领/续租。
 *
 * 「过了就写认领」是软门那一半：没人认领时直接执行**并把认领记上**，
 * 工作台据此出「Claude 写」「Codex 封面中」的徽章；不记就等于谁也不知道谁在干。
 * 越门而过的 `local-user` 不抢别人还活着的认领——抢了就把真相盖掉了；但越门本身记一条账。
 */
export async function ensureClaim(
  contentId: string,
  input: ClaimGuardInput,
  dataDir?: string,
): Promise<ClaimResult> {
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `稿件不存在：${contentId}` };
  const gate = assertClaimToken(content, input.host, input.token);
  if (!gate.ok) return { ok: false, error: gate.error, code: gate.code, holder: gate.holder };

  const now = Date.now();
  const current = activeClaim(content, now);
  if (current && gate.override) {
    const handoffs = withHandoff(content, withSession({
      from: current.host,
      to: input.host,
      by: input.host,
      at: new Date(now).toISOString(),
      note: "工作台越过认领",
      override: true,
    }));
    await updateContent(content.id, { handoffs }, dataDir);
    return { ok: true, claim: current, override: true };
  }
  const employee = input.employee ?? current?.employee ?? content.claim?.employee ?? "writer";
  // 续租沿用原持有者：带着别人令牌来的宿主接手的是那份认领，别把账记到自己头上
  const host = current ? current.host : input.host;
  return { ok: true, claim: await writeClaim(content, { employee, host, renew: Boolean(current) }, dataDir, now) };
}

/** 写操作回执里的令牌：认领落在调用宿主名下才回给他（新认领 / 带令牌续租）；越门的工作台拿不到别人的令牌 */
export function claimGrant(result: ClaimResult, host: string): { claim_token?: string } {
  if (!result.ok || result.override || result.claim.host !== host) return {};
  return { claim_token: result.claim.token };
}

/** 用 type 不用 interface：各工具的结果类型是 `Record<string, unknown>`，interface 没有隐式索引签名 */
export type ClaimDenial = {
  ok: false;
  error: string;
  code?: "claim_held";
  holder?: ClaimView;
};

/** 写口共用的门：过了就把令牌（若归你）交回，拒了就是原样可回给宿主的拒绝结果 */
export type WriteGate = { denied: ClaimDenial } | { grant: { claim_token?: string } };

export async function gateClaimWrite(contentId: string, input: ClaimGuardInput, dataDir?: string): Promise<WriteGate> {
  const claimed = await ensureClaim(contentId, input, dataDir);
  if (claimed.ok) return { grant: claimGrant(claimed, input.host) };
  return {
    denied: {
      ok: false,
      error: claimed.error,
      ...(claimed.code ? { code: claimed.code } : {}),
      ...(claimed.holder ? { holder: claimed.holder } : {}),
    },
  };
}
