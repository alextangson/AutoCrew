/**
 * 账号级每日数据（管线重规划 §4、§8-9）—— **旁听**各平台创作后台首页，只读页面自己收到的响应。
 *
 * 每个平台只取后台概览页真给了的数（2026-10-25 只读探查，脱敏样本在 __fixtures__/account/）：
 *
 * | 平台 | 页面 | 粉丝 | 当日新增粉丝 | 当日播放/阅读 |
 * |---|---|---|---|---|
 * | 抖音 | creator-micro/home → `/aweme/janus/creator/data/overview/all/` | `fans.option_list`（每日累计） | `new_fans.option_list` | `play.option_list`（近 7 天，每天一个数） |
 * | 小红书 | new/home → `datacenter/account/base` + `home/personal_info` | `personal_info.fans_count`（抓取时） | `seven.rise_fans_list` | `seven.view_list`（近 7 天观看） |
 * | B站 | platform/home → `/x/web/data/index/stat` | `total_fans` | `incr_fans` | `incr_click`（`log_date` 那天） |
 * | 公众号 | 后台首页 HTML（文档本身） | `total_friend_cnt` | `yesterdaySummary.subscribe` | `yesterdaySummary.pv`（昨日阅读人数） |
 *
 * 视频号：探查时 ego lite 里没登录，看不到首页结构 → 不接（不编字段）。
 */
import { EgoSession, type BrowseOutcome, type CapturedResponse, type EgoRunner } from "./ego-session.js";
import type { BrowseParams } from "./ego-scripts.js";
import type { PullStatus } from "./pull-types.js";
import { classifyThrown, envelopeOf, isRecord, toCount } from "./pull-shared.js";
import { LOGIN_TEXT_COMMON, RISK_TEXT_COMMON, RISK_URL_COMMON } from "./gates.js";
import { shanghaiDate } from "../../modules/flywheel/outcome-schema.js";

export type AccountPlatform = "douyin" | "xiaohongshu" | "bilibili" | "wechat_mp";
export const ACCOUNT_PLATFORMS: readonly AccountPlatform[] = ["douyin", "xiaohongshu", "bilibili", "wechat_mp"];
export const isAccountPlatform = (p: string): p is AccountPlatform => (ACCOUNT_PLATFORMS as readonly string[]).includes(p);

/** 一天一行（北京自然日）；拿不到的字段是 null，不填 0 */
export interface AccountDayRow {
  metricDate: string;
  followers: number | null;
  newFollowers: number | null;
  views: number | null;
}

export interface AccountPullResult {
  status: PullStatus;
  rows: AccountDayRow[];
  /** 账号名（后台显示的昵称）；页面没给就 null */
  account: string | null;
  errorCode?: string;
}

type Parsed = { rows: AccountDayRow[]; account?: string | null } | { stop: PullStatus; errorCode: string };

const n = (v: unknown): number | null => toCount(v) ?? null;
const emptyRow = (metricDate: string): AccountDayRow => ({ metricDate, followers: null, newFollowers: null, views: null });

/** 同一天多处来源：逐字段取非空的（后来的覆盖先来的） */
export function mergeDayRows(rows: AccountDayRow[]): AccountDayRow[] {
  const by = new Map<string, AccountDayRow>();
  for (const r of rows) {
    const cur = by.get(r.metricDate) ?? emptyRow(r.metricDate);
    by.set(r.metricDate, {
      metricDate: r.metricDate,
      followers: r.followers ?? cur.followers,
      newFollowers: r.newFollowers ?? cur.newFollowers,
      views: r.views ?? cur.views,
    });
  }
  return [...by.values()].sort((a, b) => a.metricDate.localeCompare(b.metricDate));
}

// ── 抖音 ──────────────────────────────────────────────────────────────────

function douyinSeries(data: Record<string, unknown>, key: string, field: keyof Omit<AccountDayRow, "metricDate">): AccountDayRow[] {
  const bag = isRecord(data[key]) ? data[key] : null;
  const list = bag && Array.isArray(bag.option_list) ? bag.option_list : [];
  return list.filter(isRecord).flatMap((x) => {
    const date = typeof x.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : null;
    return date ? [{ ...emptyRow(date), [field]: n(x.count) }] : [];
  });
}

export function parseDouyinAccount(res: CapturedResponse): Parsed {
  const env = envelopeOf(res, "account_overview");
  if (!env.ok) return { stop: env.result.status, errorCode: env.result.errorCode ?? "envelope" };
  const code = typeof env.json.status_code === "number" ? env.json.status_code : 0;
  if (code === 8) return { stop: "needs_login", errorCode: "envelope:8" };
  if (res.url.includes("/media/user/info")) {
    const user = isRecord(env.json.user) ? env.json.user : {};
    return { rows: [], account: typeof user.nickname === "string" ? user.nickname : null };
  }
  if (code !== 0) return { stop: "error", errorCode: `envelope:${code}` };
  const data = isRecord(env.json.data) ? env.json.data : null;
  if (!data || !isRecord(data.fans) || !isRecord(data.play)) return { stop: "schema_changed", errorCode: "missing:data.fans/play" };
  return { rows: [...douyinSeries(data, "fans", "followers"), ...douyinSeries(data, "new_fans", "newFollowers"), ...douyinSeries(data, "play", "views")] };
}

// ── 小红书 ────────────────────────────────────────────────────────────────

const msDate = (v: unknown): string | null => {
  const ms = toCount(v);
  return ms ? shanghaiDate(new Date(ms).toISOString()) : null;
};

function xhsSeries(seven: Record<string, unknown>, key: string, field: "newFollowers" | "views"): AccountDayRow[] {
  const list = Array.isArray(seven[key]) ? (seven[key] as unknown[]) : [];
  return list.filter(isRecord).flatMap((x) => {
    const date = msDate(x.date);
    return date ? [{ ...emptyRow(date), [field]: n(x.count) }] : [];
  });
}

export function parseXhsAccount(res: CapturedResponse, capturedAt: string): Parsed {
  const env = envelopeOf(res, "xhs_account");
  if (!env.ok) return { stop: env.result.status, errorCode: env.result.errorCode ?? "envelope" };
  if (env.json.success === false) return { stop: "error", errorCode: `xhs_account_code:${String(env.json.code ?? "unknown")}` };
  const data = isRecord(env.json.data) ? env.json.data : null;
  if (!data) return { stop: "schema_changed", errorCode: "missing:data" };
  if (res.url.includes("personal_info")) {
    // 粉丝总数是「抓取此刻」的数：记在抓取那天之前的最后一个数据日（昨天）上，和其余字段同一天
    const day = shanghaiDate(new Date(Date.parse(capturedAt) - 86_400_000).toISOString());
    return { rows: [{ ...emptyRow(day), followers: n(data.fans_count) }], account: typeof data.name === "string" ? data.name : null };
  }
  const seven = isRecord(data.seven) ? data.seven : null;
  if (!seven || !Array.isArray(seven.view_list)) return { stop: "schema_changed", errorCode: "missing:data.seven.view_list" };
  return { rows: [...xhsSeries(seven, "view_list", "views"), ...xhsSeries(seven, "rise_fans_list", "newFollowers")] };
}

// ── B站 ───────────────────────────────────────────────────────────────────

export function parseBilibiliAccount(res: CapturedResponse): Parsed {
  const env = envelopeOf(res, "bili_stat");
  if (!env.ok) return { stop: env.result.status, errorCode: env.result.errorCode ?? "envelope" };
  const code = env.json.code;
  if (code === -101) return { stop: "needs_login", errorCode: "envelope:-101" };
  if (code === -352 || code === -412) return { stop: "risk_control", errorCode: `envelope:${code}` };
  if (code !== 0) return { stop: "error", errorCode: `envelope:${String(code)}` };
  const d = isRecord(env.json.data) ? env.json.data : null;
  const logDate = d ? String(d.log_date ?? "") : "";
  if (!d || !/^\d{8}$/.test(logDate)) return { stop: "schema_changed", errorCode: "missing:data.log_date" };
  const date = `${logDate.slice(0, 4)}-${logDate.slice(4, 6)}-${logDate.slice(6, 8)}`;
  return { rows: [{ metricDate: date, followers: n(d.total_fans), newFollowers: n(d.incr_fans), views: n(d.incr_click) }] };
}

// ── 公众号 ────────────────────────────────────────────────────────────────

const quoted = (body: string, key: string): number | null => {
  const m = new RegExp(`\\b${key}\\s*:\\s*'(\\d+)'`).exec(body);
  return m ? Number(m[1]) : null;
};

/** 首页文档：`total_friend_cnt` + `yesterdaySummary.{pv,subscribe}`（「数据统计时间」= 昨天） */
export function parseWechatMpAccount(res: CapturedResponse, capturedAt: string): Parsed {
  if (res.status < 200 || res.status >= 300) return { stop: res.status === 401 || res.status === 403 ? "needs_login" : "error", errorCode: `http_${res.status}` };
  if (!res.body.includes("total_friend_cnt")) return { rows: [] }; // 同路径的 JSON 小请求，不是首页文档
  const summary = /yesterdaySummary\s*=\s*\{([\s\S]*?)\}/.exec(res.body)?.[1] ?? "";
  const day = shanghaiDate(new Date(Date.parse(capturedAt) - 86_400_000).toISOString());
  const nick = /nick_name\s*:\s*'([^']*)'/.exec(res.body)?.[1] ?? null;
  return { rows: [{ metricDate: day, followers: quoted(res.body, "total_friend_cnt"), newFollowers: quoted(summary, "subscribe"), views: quoted(summary, "pv") }], account: nick };
}

// ── 抓取 ──────────────────────────────────────────────────────────────────

interface AccountSource {
  url: string;
  patterns: string[];
  /** 少了哪条就算「只抓到一部分」（抖音的昵称接口可有可无） */
  required: string[];
  gates: BrowseParams["gates"];
  parse(res: CapturedResponse, capturedAt: string): Parsed;
}

const GATES = { riskUrl: RISK_URL_COMMON, loginText: LOGIN_TEXT_COMMON, riskText: RISK_TEXT_COMMON };

export const ACCOUNT_SOURCES: Record<AccountPlatform, AccountSource> = {
  douyin: { url: "https://creator.douyin.com/creator-micro/home", patterns: ["/aweme/janus/creator/data/overview/all", "/web/api/media/user/info"], required: ["/aweme/janus/creator/data/overview/all"], gates: GATES, parse: (r) => parseDouyinAccount(r) },
  xiaohongshu: {
    url: "https://creator.xiaohongshu.com/new/home", patterns: ["/datacenter/account/base", "/creator/home/personal_info"], required: ["/datacenter/account/base", "/creator/home/personal_info"],
    gates: { ...GATES, loginUrl: "creator\\.xiaohongshu\\.com/login" }, parse: parseXhsAccount,
  },
  bilibili: { url: "https://member.bilibili.com/platform/home", patterns: ["/x/web/data/index/stat"], required: ["/x/web/data/index/stat"], gates: { ...GATES, loginUrl: "passport\\.bilibili\\.com/login" }, parse: (r) => parseBilibiliAccount(r) },
  wechat_mp: { url: "https://mp.weixin.qq.com/", patterns: ["/cgi-bin/home"], required: ["/cgi-bin/home"], gates: GATES, parse: parseWechatMpAccount },
};

/** 一页里所有响应 → 结果（纯函数）：任一条能用就算拿到；全都停 → 风控 > 登录 > 其他 */
export function judgeAccountPage(platform: AccountPlatform, o: BrowseOutcome, capturedAt: string): AccountPullResult {
  if (o.end === "error") { const t = classifyThrown(o.error); return { status: t.status, rows: [], account: null, errorCode: t.errorCode }; }
  if (o.gate) return { status: o.gate === "risk" ? "risk_control" : "needs_login", rows: [], account: null, errorCode: `${o.gate}_page` };
  const responses = o.pages[0]?.responses ?? [];
  const parsed = responses.map((r) => ACCOUNT_SOURCES[platform].parse(r, capturedAt));
  const stops = parsed.filter((p): p is Extract<Parsed, { stop: PullStatus }> => "stop" in p);
  const oks = parsed.filter((p): p is Extract<Parsed, { rows: AccountDayRow[] }> => "rows" in p);
  const rows = mergeDayRows(oks.flatMap((p) => p.rows));
  const account = oks.map((p) => p.account).find((a) => typeof a === "string") ?? null;
  const stop = stops.find((s) => s.stop === "risk_control") ?? stops.find((s) => s.stop === "needs_login");
  if (stop) return { status: stop.stop, rows: [], account: null, errorCode: stop.errorCode };
  if (rows.length === 0) {
    const first = stops[0];
    return first ? { status: first.stop, rows: [], account: null, errorCode: first.errorCode } : { status: "error", rows: [], account: null, errorCode: "no_data_response" };
  }
  // 有能用的行，但某条来源坏了或没等到：行照收，缺口记进 errorCode（健康里看得见，首页能说明为什么缺某个数）
  const missing = ACCOUNT_SOURCES[platform].required.filter((pat) => !responses.some((r) => r.url.includes(pat)));
  const gap = stops[0]?.errorCode ?? (missing.length ? `missing_response:${missing[0]}` : null);
  return { status: "ok", rows, account, ...(gap ? { errorCode: `partial:${gap}` } : {}) };
}

export interface AccountPullOptions {
  now?: () => Date;
  session?: { browse(p: Omit<BrowseParams, "space">): Promise<BrowseOutcome> };
  runner?: EgoRunner;
}

/** 只翻一页：概览数据一屏就全；inspect 直接说「没有下一页」 */
export async function pullAccountStats(platform: AccountPlatform, opts: AccountPullOptions = {}): Promise<AccountPullResult> {
  const capturedAt = (opts.now ?? (() => new Date()))().toISOString();
  const src = ACCOUNT_SOURCES[platform];
  try {
    const session = opts.session ?? new EgoSession({ label: `${platform}-account`, runner: opts.runner });
    const outcome = await session.browse({
      url: src.url, patterns: src.patterns, gates: src.gates, next: { kind: "scroll" },
      inspectSrc: "() => ({ oldestMs: null, hasMore: false })",
      cutoffMs: 0, maxPages: 1, waitMs: 25_000, nextWaitMs: 0, settleMs: 6_000, navTimeoutMs: 30_000, pauseMinMs: 0, pauseMaxMs: 0,
    });
    return judgeAccountPage(platform, outcome, capturedAt);
  } catch (err) {
    const t = classifyThrown(err);
    return { status: t.status, rows: [], account: null, errorCode: t.errorCode };
  }
}
