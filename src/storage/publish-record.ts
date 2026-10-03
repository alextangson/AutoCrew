/**
 * 发布记录（看板规格 §D）：把 Codex 发布时写的 06-publish/publish-plan.json 读成看板要的每平台状态，
 * 再叠上创始人自己点的「我发了」。文件是外部写的——这里是系统边界，逐字段校验；
 * 缺失 / 格式坏 / 不认识的状态都要成为可见状态，不隐藏、不当作未发布（§23）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isMissing, resolveContentProject } from "./content-project.js";
import type { ManualPublication } from "./local-store.js";

export type PublicationState =
  | "scheduled" // 已定时，时间还没到
  | "overdue" // 定时时间已过，还没回流确认公开（§20「应已公开」）
  | "public" // 已公开
  | "reviewing" // 已提交，审核中（没有定时）
  | "rejected" // 审核不通过 / 被下架（§21）
  | "not_submitted" // 计划里有，还没提交
  | "manual" // 创始人自己在平台上发的（§22）
  | "unknown"; // 不认识的状态：原值照写（§23）

export interface PlatformPublication {
  platform: string;
  state: PublicationState;
  /** 算不算「已经投出去了」：决定进不进已发布列 */
  submitted: boolean;
  /** unknown 时的原值；其它时候也带上，便于核对 */
  raw: string | null;
  /** 平台审核：reviewing / approved / rejected 之外的原值照写 */
  review: string | null;
  /** 发布时间（定时的取定时时间，公开的取实际时间，手动的取标记时间；审核中 / 被驳回的有定时取定时，没定时退回提交时间，仅供显示） */
  time: string | null;
  reason: string | null;
  url: string | null;
  campaigns: string[];
  manual: ManualPublication | null;
  /** 该平台上用的标题 / 平台作品 id：数据关联（§33）的额外匹配键 */
  title?: string | null;
  postId?: string | null;
  /** 发布前把关的 check_id（发布审查闸门：技能在计划里每个平台带上） */
  checkId?: string | null;
  /** 实际提交时间，只认计划里的 submitted_at（创始人 09-30 从严）；授权时间、定时公开时间都不算。发布前把关与重开后的轮次都按它判 */
  submittedAt?: string | null;
  /** 计划里写的定时公开时间（publication.scheduled_at 或条目 scheduled_at） */
  scheduledAt?: string | null;
  /** 把关判定用的证据时间：审核中 / 被驳回的按提交 → 核实 → 定时取最早能证明投出的那个，其余同 time */
  evidenceAt?: string | null;
}

export type PublishRecord =
  | { kind: "none" }
  /** 计划读不到；platforms 里只有创始人手动标的那几条 */
  | { kind: "unreadable"; reason: string; platforms: PlatformPublication[] }
  | { kind: "ok"; platforms: PlatformPublication[] };

const PUBLIC = new Set(["published", "public", "live", "posted"]);
const SUBMITTED = new Set(["submitted", "reviewing", "pending_review", "under_review"]);
const NOT_SUBMITTED = new Set(["not_submitted", "draft", "local_draft", "uploading", "uploaded", "pending", "not_started"]);
const REJECTED = new Set(["rejected", "removed", "taken_down", "blocked", "review_failed"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const validTime = (v: unknown): string | null => { const s = str(v); return s && Number.isFinite(Date.parse(s)) ? s : null; };

function campaignsOf(entry: Obj): string[] {
  if (!Array.isArray(entry.campaigns)) return [];
  return entry.campaigns.filter((c): c is Obj => isObj(c) && c.selected === true).map((c) => str(c.name)).filter((n): n is string => Boolean(n));
}

function stateOf(status: string | null, review: string | null, time: string | null, now: number): PublicationState {
  if (status === null) return "not_submitted";
  if (REJECTED.has(status) || review === "rejected") return "rejected";
  if (PUBLIC.has(status)) return "public";
  if (status === "scheduled") return time && Date.parse(time) <= now ? "overdue" : "scheduled";
  if (SUBMITTED.has(status)) return "reviewing";
  if (NOT_SUBMITTED.has(status)) return "not_submitted";
  return "unknown";
}

/** 一个平台条目；形状不对返回 null（整份记录判为读不到） */
export function parsePlatformEntry(entry: unknown, now: number): PlatformPublication | null {
  if (!isObj(entry)) return null;
  const platform = str(entry.platform);
  if (!platform) return null;
  const pub = isObj(entry.publication) ? entry.publication : null;
  if (entry.publication !== undefined && entry.publication !== null && !pub) return null;
  const status = pub ? str(pub.status) : null;
  const reviewRaw = pub ? str(pub.review_status) : null;
  const scheduledAt = validTime(pub?.scheduled_at) ?? validTime(entry.scheduled_at);
  const state = stateOf(status, reviewRaw, scheduledAt, now);
  const time = state === "public" ? validTime(pub?.published_at) ?? validTime(pub?.verified_at)
    : state === "scheduled" || state === "overdue" ? scheduledAt
    // 审核中但已知定时：公开时间就是定时时间，提交时间只进 submittedAt（2026-10-03 抖音审核中被按提交时间算成 9 月发布）
    : state === "reviewing" || state === "rejected" ? scheduledAt ?? validTime(pub?.submitted_at) ?? validTime(pub?.verified_at)
    : null;
  return {
    platform, state, raw: status,
    submitted: state !== "not_submitted" && state !== "unknown",
    review: reviewRaw,
    time,
    reason: state === "rejected" ? str(pub?.reject_reason) ?? str(pub?.reason) ?? str(pub?.evidence) : null,
    url: str(pub?.url) ?? str(pub?.post_url),
    campaigns: campaignsOf(entry), manual: null,
    title: str(entry.title), postId: str(pub?.post_id) ?? str(entry.post_id), checkId: str(entry.check_id) ?? str(pub?.check_id),
    submittedAt: validTime(pub?.submitted_at),
    scheduledAt,
    evidenceAt: state === "reviewing" || state === "rejected" ? validTime(pub?.submitted_at) ?? validTime(pub?.verified_at) ?? scheduledAt : time,
  };
}

/** 文件内容 → 记录。null = 文件不存在 */
export function parsePublishPlan(raw: string | null, now: number = Date.now()): PublishRecord {
  if (raw === null) return { kind: "none" };
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { kind: "unreadable", reason: "发布记录不是合法 JSON", platforms: [] }; }
  if (!isObj(json) || !Array.isArray(json.platforms)) return { kind: "unreadable", reason: "发布记录里没有平台清单", platforms: [] };
  const platforms: PlatformPublication[] = [];
  for (const entry of json.platforms) {
    const parsed = parsePlatformEntry(entry, now);
    if (!parsed) return { kind: "unreadable", reason: "发布记录里有一条平台记录格式不对", platforms: [] };
    platforms.push(parsed);
  }
  return { kind: "ok", platforms };
}

/** 叠上「我发了」：手动标记盖过计划里的状态；计划里没有的平台照样列出 */
export function withManual(record: PublishRecord, manual: ManualPublication[] | undefined): PublishRecord {
  if (!manual?.length) return record;
  const base = record.kind === "none" ? [] : record.platforms;
  const out = base.map((p) => {
    const mark = manual.find((m) => m.platform === p.platform);
    return mark ? { ...p, state: "manual" as const, submitted: true, time: mark.at, url: mark.url ?? p.url, manual: mark } : p;
  });
  for (const mark of manual) {
    if (out.some((p) => p.platform === mark.platform)) continue;
    out.push({ platform: mark.platform, state: "manual", submitted: true, raw: null, review: null, time: mark.at, reason: null, url: mark.url ?? null, campaigns: [], manual: mark });
  }
  // 计划读不到时仍如实说读不到，但手动标记也要显示出来
  return record.kind === "unreadable" ? { ...record, platforms: out } : { kind: "ok", platforms: out };
}

export function anySubmitted(record: PublishRecord): boolean {
  return record.kind !== "none" && record.platforms.some((p) => p.submitted);
}

/** 这条稿的发布时间：取各平台里最晚的那个（未来的定时排最上面，§19） */
export function recordTime(record: PublishRecord): string | null {
  if (record.kind === "none") return null;
  const times = record.platforms.filter((p) => p.submitted && p.time).map((p) => p.time!);
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

/** 最早投出去的时间：稿件 publishedAt 用它（首次公开/提交的时刻，只盖一次） */
export function firstPublishTime(record: PublishRecord): string | null {
  if (record.kind === "none") return null;
  const times = record.platforms.filter((p) => p.submitted && p.time).map((p) => p.time!);
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

export async function readPublishPlanRaw(contentId: string, dataDir: string): Promise<string | null> {
  const binding = resolveContentProject(contentId, dataDir);
  if (!binding) return null;
  try { return await fs.readFile(path.join(binding.project_root, "06-publish/publish-plan.json"), "utf8"); } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** 读盘 + 解析 + 叠手动标记；读盘本身失败（权限等）也落成「读不到」 */
export async function readPublishRecord(contentId: string, manual: ManualPublication[] | undefined, dataDir: string, now: number = Date.now()): Promise<PublishRecord> {
  let raw: string | null;
  try { raw = await readPublishPlanRaw(contentId, dataDir); } catch (e) {
    return withManual({ kind: "unreadable", reason: `发布记录读不到：${e instanceof Error ? e.message : String(e)}`, platforms: [] }, manual);
  }
  return withManual(parsePublishPlan(raw, now), manual);
}
