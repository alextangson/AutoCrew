/**
 * 视频号(channels.weixin.qq.com)创作者后台数据拉取 —— **in-page fetch** 路线
 * (spec §4.2 传输策略总表;参照 wechat-mp-stats.ts 的既有做法)。
 *
 * 为什么是三家里最简单的一条:`mmfinderassistant-bin` 系纯 Cookie + 固定 header,无签名。
 * 全部 POST + JSON body,前缀 `/cgi-bin/mmfinderassistant-bin`。
 *
 * 顺序(端点文档 §2):
 *   1. `/auth/auth_data`          → 登录**正向证据**:errCode===0 且拿得到 finderUsername
 *   2. `/helper/helper_upload_params` → uin,填 `X-WECHAT-UIN`(拿不到用 "0000000000",不阻断)
 *   3. `/post/post_list`          → 作品列表(自带累计指标,不逐作品打详情,少碰风控)
 *
 * **待真实抓包校准**:`userpageType` 各仓库取值不一(3/13/0/10/11),这里取 3;
 * finderUsername 的实际路径也未确认,`pickFinderUsername` 认几条常见路径。
 * Referer:文档要求带,但浏览器禁止 fetch 设置 Referer——我们是在后台页 origin 内发起的,
 * Referer 由页面自身 URL 自动带上,反而比手工拼更真;所以这里不设,也不算漏项。
 */
import { CdpSession } from "./cdp-session.js";
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import {
  PAGE_ROW_LIMIT,
  assign,
  classifyThrown,
  envelopeOf,
  failure,
  fetchInPageWithInit,
  firstString,
  idOf,
  isRecord,
  isoFromSeconds,
  paginate,
  waitForPageHost,
  withTab,
  type PageEvaluator,
  type PageFetchOutcome,
  type PageStep,
  type TabHost,
} from "./pull-shared.js";

const ORIGIN = "https://channels.weixin.qq.com";
const HOST_FRAGMENT = "channels.weixin.qq.com";
/** 后台作品列表页:in-page fetch 的落脚点(Referer 由它自动带上) */
export const WECHAT_VIDEO_PAGE = `${ORIGIN}/platform/post/list`;
const API = `${ORIGIN}/cgi-bin/mmfinderassistant-bin`;
const DEFAULT_PAGE_SIZE = 20;
/** 各仓库取值不一(3/13/0/10/11),**待校准** */
const USERPAGE_TYPE = 3;
const UIN_FALLBACK = "0000000000";
/** objectId/exportId 是 19 位数字,同样会丢精度 */
const WECHAT_ID_KEYS = ["objectId", "exportId"];

function randomHex(len: number): string {
  let out = "";
  while (out.length < len) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, len);
}

/** 公共 body(端点文档 §2):timestamp 是**毫秒字符串**,不是秒 */
export function commonBody(finderUsername: string): Record<string, unknown> {
  return {
    timestamp: String(Date.now()),
    _log_finder_uin: "",
    _log_finder_id: finderUsername,
    rawKeyBuff: "",
    pluginSessionId: null,
    scene: 7,
    reqScene: 7,
  };
}

function apiUrl(path: string): string {
  const q = new URLSearchParams({ _aid: "", _rid: randomHex(12), _pageUrl: WECHAT_VIDEO_PAGE });
  return `${API}${path}?${q.toString()}`;
}

function headers(uin: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "X-WECHAT-UIN": uin,
    "finger-print-device-id": randomHex(32),
  };
}

async function postJson(
  page: PageEvaluator,
  sessionId: string,
  path: string,
  body: Record<string, unknown>,
  uin: string,
): Promise<PageFetchOutcome> {
  return fetchInPageWithInit(page, apiUrl(path), { method: "POST", headers: headers(uin), body: JSON.stringify(body) }, sessionId);
}

/** finderUsername 的真实路径未确认,认几条社区里出现过的形态(**待校准**) */
export function pickFinderUsername(data: unknown): string {
  if (!isRecord(data)) return "";
  const user = isRecord(data.finderUser) ? data.finderUser : {};
  const alt = isRecord(data.user) ? data.user : {};
  return firstString(user.finderUsername, data.finderUsername, alt.finderUsername, user.username);
}

/**
 * 登录判定(spec §4.1 正向证据):`errCode === 0` **且**拿得到 finderUsername 才算在线。
 * errCode 非 0 一律 needs_login——这个端点不签名,失败只可能是登录态问题。
 */
export function parseAuthData(res: PageFetchOutcome): { ok: true; finderUsername: string } | { ok: false; result: PullResult } {
  const env = envelopeOf(res, "auth_data");
  if (!env.ok) return { ok: false, result: env.result };
  const errCode = typeof env.json.errCode === "number" ? env.json.errCode : NaN;
  if (!Number.isFinite(errCode)) return { ok: false, result: failure("schema_changed", "missing:auth_data.errCode") };
  if (errCode !== 0) return { ok: false, result: failure("needs_login", `auth_errcode:${errCode}`) };
  const finderUsername = pickFinderUsername(env.json.data);
  if (!finderUsername) return { ok: false, result: failure("needs_login", "auth_no_finder_username") };
  return { ok: true, finderUsername };
}

/** 标题:优先 shortTitle,退 description(端点文档 §2) */
export function pickTitle(desc: unknown): string {
  if (!isRecord(desc)) return "";
  const shorts = Array.isArray(desc.shortTitle) ? desc.shortTitle : [];
  const first = isRecord(shorts[0]) ? shorts[0] : {};
  return firstString(first.shortTitle, desc.description);
}

export function mapPostRow(entry: unknown): TypedRow {
  const post = isRecord(entry) ? entry : {};
  const metrics: Partial<OutcomeMetrics> = {};
  assign(metrics, "views", post.readCount);
  assign(metrics, "likes", post.likeCount);
  assign(metrics, "comments", post.commentCount);
  assign(metrics, "shares", post.forwardCount);
  assign(metrics, "favorites", post.favCount);
  assign(metrics, "follows", post.followCount);
  assign(metrics, "completionRate", post.fullPlayRate);
  const id = idOf(post.objectId, post.exportId);
  return {
    title: pickTitle(post.desc),
    publishedAt: isoFromSeconds(post.createTime),
    ...(id ? { platformItemId: id } : {}),
    metrics,
  };
}

export type PostListParse =
  | { kind: "ok"; rows: TypedRow[]; totalCount: number | null }
  | { kind: "stop"; result: PullResult };

/** 一页 post_list 的解析(纯函数,fixture 单测锚定) */
export function parsePostList(res: PageFetchOutcome): PostListParse {
  const env = envelopeOf(res, "post_list", WECHAT_ID_KEYS);
  if (!env.ok) return { kind: "stop", result: env.result };
  const errCode = typeof env.json.errCode === "number" ? env.json.errCode : NaN;
  if (!Number.isFinite(errCode)) return { kind: "stop", result: failure("schema_changed", "missing:post_list.errCode") };
  if (errCode !== 0) return { kind: "stop", result: failure("error", `post_list_errcode:${errCode}`) };
  const data = isRecord(env.json.data) ? env.json.data : null;
  if (!data || !Array.isArray(data.list)) return { kind: "stop", result: failure("schema_changed", "missing:data.list") };
  const total = typeof data.totalCount === "number" ? data.totalCount : null;
  return { kind: "ok", rows: data.list.map(mapPostRow), totalCount: total };
}

export interface WechatVideoCdp extends PageEvaluator, TabHost {
  close(): void;
}

export interface PullWechatVideoOptions {
  pageSize?: number;
  limit?: number;
  /** 翻页间隔,默认 300ms:少打请求 = 少碰风控 */
  delayMs?: number;
  navTimeoutMs?: number;
  /** 测试注入点:默认连常驻 chrome-cdp */
  connect?: () => Promise<{ session: WechatVideoCdp }>;
}

/** uin 拿不到不阻断:只是 header 少一个真值,列表接口照打(端点文档说未取到填 0000000000) */
async function resolveUin(page: PageEvaluator, sessionId: string, finderUsername: string): Promise<string> {
  try {
    const res = await postJson(page, sessionId, "/helper/helper_upload_params", commonBody(finderUsername), UIN_FALLBACK);
    const env = envelopeOf(res, "helper_upload_params");
    if (!env.ok || !isRecord(env.json.data)) return UIN_FALLBACK;
    return idOf(env.json.data.uin) || UIN_FALLBACK;
  } catch {
    return UIN_FALLBACK;
  }
}

async function fetchPostPage(
  page: PageEvaluator,
  sessionId: string,
  ctx: { finderUsername: string; uin: string; pageSize: number },
  cursor: number | undefined,
  pageIndex: number,
): Promise<PageStep<number>> {
  const currentPage = cursor ?? 1;
  const body = {
    pageSize: ctx.pageSize,
    currentPage,
    userpageType: USERPAGE_TYPE,
    forMcn: false,
    needAllCommentCount: true,
    onlyUnread: false,
    ...commonBody(ctx.finderUsername),
  };
  const parsed = parsePostList(await postJson(page, sessionId, "/post/post_list", body, ctx.uin));
  if (parsed.kind === "stop") {
    // 第一页就失败 = 整次失败;后续页失败不该抹掉已抓到的行,但也不谎报「抓全了」
    return pageIndex === 0 ? { kind: "stop", result: parsed.result } : { kind: "page", rows: [], hasMore: false };
  }
  const fetched = currentPage * ctx.pageSize;
  const hasMore =
    parsed.rows.length >= ctx.pageSize && (parsed.totalCount === null || fetched < parsed.totalCount);
  return { kind: "page", rows: parsed.rows, hasMore, next: currentPage + 1 };
}

/**
 * 抓取视频号作品数据。状态判定矩阵:
 *
 * | 输入 | 状态 |
 * |---|---|
 * | auth_data `errCode:0` + finderUsername,post_list `data.list` 合法 | `ok`(超 200 行 → `hasMore:true`) |
 * | auth_data `errCode !== 0` 或取不到 finderUsername | `needs_login` |
 * | 任一接口 HTTP 401/403 | `needs_login` |
 * | 任一接口 HTTP 其他非 200 | `error`(`http:<状态>`) |
 * | HTML 伪装 200 / JSON 解析失败 / 缺 `errCode` / 缺 `data.list` | `schema_changed` + 空 rows |
 * | post_list `errCode !== 0` | `error`(`post_list_errcode:<码>`) |
 * | 标签页超时未落到 channels.weixin.qq.com | `timeout` |
 * | chrome-cdp 连不上/连接断开 | `browser_unreachable` |
 */
export async function pullWechatVideoStats(opts: PullWechatVideoOptions = {}): Promise<PullResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  let session: WechatVideoCdp;
  try {
    session = opts.connect ? (await opts.connect()).session : await CdpSession.connect();
  } catch (err) {
    return classifyThrown(err);
  }
  try {
    return await withTab(session, WECHAT_VIDEO_PAGE, async (tab) => {
      const ready = await waitForPageHost(session, tab.sessionId, HOST_FRAGMENT, opts.navTimeoutMs ?? 20_000);
      if (!ready) return failure("timeout", "page_not_ready");

      const auth = parseAuthData(await postJson(session, tab.sessionId, "/auth/auth_data", commonBody(""), UIN_FALLBACK));
      if (!auth.ok) return auth.result;

      const uin = await resolveUin(session, tab.sessionId, auth.finderUsername);
      const ctx = { finderUsername: auth.finderUsername, uin, pageSize };
      return await paginate<number>(
        (cursor, pageIndex) => fetchPostPage(session, tab.sessionId, ctx, cursor, pageIndex),
        { firstCursor: 1, limit: opts.limit ?? PAGE_ROW_LIMIT, delayMs: opts.delayMs ?? 300 },
      );
    });
  } catch (err) {
    return classifyThrown(err);
  } finally {
    session.close();
  }
}
