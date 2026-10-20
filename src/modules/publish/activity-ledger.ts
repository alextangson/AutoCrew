/**
 * 活动台账（spec 2026-10-20-activity-ledger）：纯逻辑——记录形状、key、新鲜度、规则差异、入参规范化。
 * 落盘与并发在 activity-ledger-store.ts。和「增长活动」(campaign) 无关。
 */
import { maybeJson, UNPARSABLE } from "./review-gate/plan.js";
import { dateIn, parseWhen } from "./activity-ledger-time.js";

export const ACTIVITY_PLATFORMS = ["douyin", "xiaohongshu", "bilibili", "wechat_video"] as const;
export type ActivityPlatform = (typeof ACTIVITY_PLATFORMS)[number];
export type Freshness = "fresh" | "recheck" | "not_open" | "expired";
export type Relevance = "fits_us" | "not_for_us";

type Obj = Record<string, unknown>;
export interface HistoryEntry { at: string; field: string; before: unknown; after: unknown; founder_quote?: string }
export interface ActivityRecord {
  key: string;
  platform: ActivityPlatform;
  name: string;
  platform_activity_id?: string;
  official_url: string;
  window?: { start?: string; end?: string; timezone?: string; raw?: string };
  rules?: Obj;
  form?: { url?: string; deadline?: string };
  relevance: Relevance;
  reason?: string;
  verified_at: string;
  verified_via?: string;
  sources: unknown[];
  evidence?: string[];
  history: HistoryEntry[];
}
export interface Ledger { version: 1; activities: Record<string, ActivityRecord> }

const DAY = 24 * 3600 * 1000;
const FRESH_DAYS = 7;
const NEAR_DEADLINE_MS = 48 * 3600 * 1000;
/** 进 diff / history 的字段：规则相关的都算，核查时间、来源、证据不算 */
export const RULE_FIELDS = ["name", "platform_activity_id", "official_url", "window", "rules", "form", "relevance", "reason"] as const;

/** 规范化活动名：全半角、大小写、空白、# 与常见括号标点都抹平，只用于 key 和疑似重复判断 */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[#＃\s"'“”‘’「」『』《》()（）[\]【】·・,，.。:：;；!！?？\-—_|｜/]/g, "");
}

export function activityKey(platform: string, name: string, platformActivityId?: string): string {
  const id = platformActivityId?.trim();
  return id ? `${platform}:${id}` : `${platform}:${normalizeName(name)}`;
}

const tzOf = (r: ActivityRecord) => r.window?.timezone || "Asia/Shanghai";

/** 截止对新鲜度的判断：null = 截止本身不逼重核；解析不了的截止按保守算 recheck */
function deadlineVerdict(r: ActivityRecord, now: number): Freshness | null {
  const end = r.window?.end?.trim();
  if (!end) return null;
  const w = parseWhen(end, tzOf(r));
  if (!w) return "recheck";
  if (w.kind === "date") {
    // 只写日期没写时刻：不补 23:59；截止当天就重核，过了那天才算过期（边界 6）
    const today = dateIn(now, tzOf(r));
    if (today > w.date) return "expired";
    return today === w.date ? "recheck" : null;
  }
  if (now > w.ms) return "expired";
  return w.ms - now < NEAR_DEADLINE_MS ? "recheck" : null;
}

/** 投稿期还没开始：start 只有日期按 timezone 的日历日比，有时刻按时刻比；解析不了不算未开始 */
function notOpenYet(r: ActivityRecord, now: number): boolean {
  const start = r.window?.start?.trim();
  if (!start) return false;
  const w = parseWhen(start, tzOf(r));
  if (!w) return false;
  return w.kind === "date" ? dateIn(now, tzOf(r)) < w.date : now < w.ms;
}

export function freshnessOf(r: ActivityRecord, now: number): Freshness {
  const byDeadline = deadlineVerdict(r, now);
  if (byDeadline) return byDeadline;
  if (notOpenYet(r, now)) return "not_open";
  const verified = Date.parse(r.verified_at);
  if (Number.isNaN(verified) || now - verified > FRESH_DAYS * DAY) return "recheck";
  return "fresh";
}

const WINDOW_KEYS = ["start", "end", "timezone", "raw"], FORM_KEYS = ["url", "deadline"];

/** 嵌套对象的值类型：window / form 的已知子字段只能是字符串（写入时 null 表示清空） */
export function nestedTypeProblem(field: string, v: Record<string, unknown>, allowNull: boolean): string | null {
  const keys = field === "window" ? WINDOW_KEYS : field === "form" ? FORM_KEYS : [];
  for (const k of keys) {
    const x = v[k];
    if (x === undefined || (allowNull && x === null)) continue;
    if (typeof x !== "string") return `${field}.${k} 要是字符串${allowNull ? "（清空请传 null）" : ""}`;
  }
  return null;
}

/** 读台账时逐条核形状：坏一条就整本报错（带路径），不抛裸 TypeError */
export function recordShapeProblem(r: unknown): string | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "不是对象";
  const o = r as Record<string, unknown>;
  for (const k of ["key", "platform", "name", "verified_at"]) if (typeof o[k] !== "string") return `${k} 要是字符串`;
  for (const k of ["window", "form", "rules"]) {
    if (o[k] === undefined) continue;
    if (!o[k] || typeof o[k] !== "object" || Array.isArray(o[k])) return `${k} 要是对象`;
    const p = nestedTypeProblem(k, o[k] as Record<string, unknown>, false);
    if (p) return p;
  }
  if (o.history !== undefined && !Array.isArray(o.history)) return "history 要是数组";
  if (!Array.isArray(o.sources) || o.sources.some((x) => typeof x !== "string")) return "sources 要是字符串数组";
  if (o.evidence !== undefined && (!Array.isArray(o.evidence) || o.evidence.some((x) => typeof x !== "string"))) return "evidence 要是字符串数组";
  if (o.relevance !== "fits_us" && o.relevance !== "not_for_us") return "relevance 要是 fits_us / not_for_us";
  if (o.relevance === "not_for_us" && (typeof o.reason !== "string" || !o.reason.trim())) return "not_for_us 缺 reason";
  return null;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Obj).sort().filter((k) => (v as Obj)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Obj)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** 规则字段差异：对象字段按子键细分（rules.main_topic），便于在发布说明里点名「规则变了：…」 */
export function ruleDiff(prev: ActivityRecord, next: ActivityRecord): Array<{ field: string; before: unknown; after: unknown }> {
  const out: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const f of RULE_FIELDS) {
    const a = prev[f] as unknown, b = next[f] as unknown;
    const isObj = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
    if (isObj(a) || isObj(b)) {
      const ao = (isObj(a) ? a : {}) as Obj, bo = (isObj(b) ? b : {}) as Obj;
      for (const k of [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort()) {
        if (canonical(ao[k]) !== canonical(bo[k])) out.push({ field: `${f}.${k}`, before: ao[k] ?? null, after: bo[k] ?? null });
      }
    } else if (canonical(a) !== canonical(b)) out.push({ field: f, before: a ?? null, after: b ?? null });
  }
  return out;
}

/** 模型参数可能是 JSON 字符串（中转端点）：对象 → 用；字符串 → 解析、修引号重试；解析不了才拒（边界 11） */
export function objectParam(raw: unknown, name: string): { ok: true; value: Obj } | { ok: false; error: string } {
  const v = maybeJson(raw);
  if (v === UNPARSABLE) return { ok: false, error: `${name} 看着是 JSON，但修过引号也解析不了：检查括号与逗号` };
  if (v === undefined || v === null || v === "") return { ok: true, value: {} };
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, error: `${name} 要是 JSON 对象` };
  return { ok: true, value: v as Obj };
}

/** 列表参数：数组 / JSON 字符串数组 / 单个字符串都认；解析不了的 JSON 拒 */
export function listParam(raw: unknown): unknown[] | typeof UNPARSABLE {
  const v = maybeJson(raw);
  if (v === UNPARSABLE) return UNPARSABLE;
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && x !== "");
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (v && typeof v === "object") return [v];
  return [];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function isHttp(u: string): boolean {
  try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; }
}

export type RecordInput = Omit<ActivityRecord, "key" | "history"> & { founder_quote?: string };

/** activity_record 入参校验：必填 platform、name、official_url、verified_at、sources（spec「工具」节） */
export function validateRecordInput(o: Obj): { ok: true; input: RecordInput } | { ok: false; error: string } {
  const platform = str(o.platform), name = str(o.name), url = str(o.official_url), verifiedAt = str(o.verified_at);
  if (!platform || !(ACTIVITY_PLATFORMS as readonly string[]).includes(platform)) return { ok: false, error: `platform 必填，取值 ${ACTIVITY_PLATFORMS.join(" / ")}` };
  if (!name) return { ok: false, error: "name 必填：活动名称" };
  if (!url || !isHttp(url)) return { ok: false, error: "official_url 必填，且是 http(s) 地址" };
  if (!verifiedAt || Number.isNaN(Date.parse(verifiedAt))) return { ok: false, error: "verified_at 必填：带时区的核查时间（ISO 8601）" };
  const sources = listParam(o.sources);
  if (sources === UNPARSABLE) return { ok: false, error: "sources 看着是 JSON，但修过引号也解析不了" };
  if (!sources.length) return { ok: false, error: "sources 必填：核查依据的页面（至少一条）" };
  const relevance = (str(o.relevance) ?? "fits_us") as Relevance;
  if (relevance !== "fits_us" && relevance !== "not_for_us") return { ok: false, error: "relevance 取值 fits_us / not_for_us" };
  if (relevance === "not_for_us" && !str(o.reason)) return { ok: false, error: "not_for_us 必须带 reason（账号层面的排除理由）" };
  const nested = ["window", "rules", "form"].map((k) => [k, objectParam(o[k], k)] as const);
  const bad = nested.find(([, r]) => !r.ok);
  if (bad) return { ok: false, error: (bad[1] as { error: string }).error };
  const pick = (k: string) => { const r = nested.find(([n]) => n === k)![1] as { value: Obj }; return Object.keys(r.value).length ? r.value : undefined; };
  const evidence = listParam(o.evidence);
  return { ok: true, input: {
    platform: platform as ActivityPlatform, name, official_url: url, verified_at: verifiedAt, sources, relevance,
    platform_activity_id: str(o.platform_activity_id), reason: relevance === "not_for_us" ? str(o.reason) : undefined,
    verified_via: str(o.verified_via), window: pick("window"), rules: pick("rules"), form: pick("form"),
    evidence: evidence === UNPARSABLE ? undefined : evidence.map(String), founder_quote: str(o.founder_quote),
  } };
}
