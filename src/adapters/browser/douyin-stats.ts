/**
 * 抖音创作者后台数据拉取 —— **网络旁听**路线(spec §4.2 传输策略总表;通道是 ego lite,页内 CDP)。
 *
 * 为什么不像视频号那样 in-page fetch:抖音接口带 `msToken`/`a_bogus` 签名,裸 fetch 缺参
 * 会被风控打回 `status_code: 8`。所以改成旁听——打开作品管理页,让页面自己带齐签名去请求,
 * 我们只在 `Network.responseReceived` 上接住它的 JSON 响应,解析后关页(旁听在 ego-scripts.interceptScript 里)。
 *
 * 三个坑(端点文档 §1,来源为社区仓库,**待真实抓包校准**):
 * ① `items[].id` 是超长 JSON number,`JSON.parse` 直接丢精度 → 解析前先把它包成字符串;
 * ② `metrics.*` 数值全是字符串 → 统一 `Number()` + NaN 防御(`toCount`);
 * ③ 登录判定:信封 `status_code: 8` = 未登录/风控;什么都没拦到时用 DOM 兜底
 *    (页面文本命中「扫码登录」= needs_login),**URL/title 不可靠**,不拿它们判。
 *
 * 状态判定矩阵见文件末 `pullDouyinStats` 的注释。
 */
import { EgoSession, type InterceptResult } from "./ego-session.js";
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import {
  PAGE_ROW_LIMIT,
  assign,
  classifyThrown,
  failure,
  firstString,
  idOf,
  isRecord,
  isoFromSeconds,
  keepValidRows,
  looksLikeHtml,
  okResult,
  parseJsonSafe,
  protectLongNumbers,
  schemaChanged,
} from "./pull-shared.js";

/** 作品管理页:页面自己会去打列表接口,我们只旁听 */
export const DOUYIN_MANAGE_URL = "https://creator.douyin.com/creator-micro/content/manage";
/** 现行主路 + 旧路(端点文档说两套并存,社区仓库互相矛盾 → 都认) */
export const LIST_URL_PATTERNS = ["/web/api/creator/item/list", "/janus/douyin/creator/pc/work_list"];
/** 拦截等待窗口:页面加载 + 首个列表响应 */
const DEFAULT_WAIT_MS = 20_000;
/** 首个响应命中后再等一会儿,接住页面自己发的后续分页请求 */
const DEFAULT_SETTLE_MS = 1_500;
/** 信封:未登录/风控 */
const ENVELOPE_NOT_LOGGED_IN = 8;

export function isDouyinListUrl(url: string): boolean {
  return LIST_URL_PATTERNS.some((p) => url.includes(p));
}

/** 抖音会丢精度的 id 字段(端点文档 §1 坑 ①) */
const DOUYIN_ID_KEYS = ["id", "item_id", "aweme_id", "group_id", "object_id"];

/** 精度保护:`"id":7412345678901234567` 过 `JSON.parse` 会变成 7412345678901234000 */
export function protectBigIntIds(text: string): string {
  return protectLongNumbers(text, DOUYIN_ID_KEYS);
}

type Bag = Record<string, unknown>;

/** 一条作品的字段来源:基础字段 + 指标袋(新路 metrics / 旧路 statistics) */
function mapItem(base: Bag, metricBags: Bag[]): TypedRow {
  const pick = (...keys: string[]): unknown => {
    for (const bag of metricBags) {
      for (const k of keys) {
        if (bag[k] !== undefined && bag[k] !== null) return bag[k];
      }
    }
    return undefined;
  };
  const metrics: Partial<OutcomeMetrics> = {};
  assign(metrics, "views", pick("view_count", "play_count"));
  assign(metrics, "likes", pick("like_count", "digg_count"));
  assign(metrics, "comments", pick("comment_count"));
  assign(metrics, "shares", pick("share_count", "forward_count"));
  assign(metrics, "favorites", pick("favorite_count", "collect_count"));
  assign(metrics, "completionRate", pick("completion_rate"));
  assign(metrics, "completion5s", pick("completion_rate_5s"));
  assign(metrics, "coverClickRate", pick("cover_click_rate"));
  const id = idOf(base.id, base.item_id, base.aweme_id);
  const coverUrl = coverUrlOf(base);
  return {
    title: firstString(base.item_title, base.description, base.desc, base.title),
    publishedAt: isoFromSeconds(base.create_time),
    ...(id ? { platformItemId: id } : {}),
    metrics,
    ...(coverUrl ? { coverUrl } : {}),
  };
}

/**
 * 竖封面（3:4）地址。字段来自 2026-09-27 创始人后台的真实 work_list 响应
 * （docs/research/2026-09-27-platform-cover-surfaces.md）：旧路 `aweme_list[].Cover.url_list`，
 * 现行主路 `items[].cover.url_list`。拿不到就不填，不猜别的字段。
 */
export function coverUrlOf(base: Bag): string | undefined {
  for (const bag of [base.Cover, base.cover]) {
    const list = isRecord(bag) && Array.isArray(bag.url_list) ? bag.url_list : [];
    const url = list.find((u): u is string => typeof u === "string" && u.startsWith("https://"));
    if (url) return url;
  }
  return undefined;
}

function bagOf(v: unknown): Bag {
  return isRecord(v) ? v : {};
}

/** 旧路 work_list:`aweme_list[]` 出基础字段与计数,率类指标在同索引的 `items[].metrics` */
function rowsFromLegacy(awemeList: unknown[], items: unknown[]): TypedRow[] {
  return awemeList.map((entry, i) => {
    const base = bagOf(entry);
    const paired = bagOf(items[i]);
    return mapItem(base, [bagOf(base.statistics), bagOf(paired.metrics), base]);
  });
}

/** 现行主路 item/list:基础字段与 `metrics` 都在同一个对象上 */
function rowsFromItems(items: unknown[]): TypedRow[] {
  return items.map((entry) => {
    const base = bagOf(entry);
    return mapItem(base, [bagOf(base.metrics), bagOf(base.statistics), base]);
  });
}

export type DouyinParse =
  | { kind: "ok"; rows: TypedRow[]; hasMore: boolean }
  /** 非 ok:直接就是最终 PullResult(rows 恒空 = 零写入) */
  | { kind: "stop"; result: PullResult };

/**
 * 解析一条拦截到的列表响应(纯函数,fixture 单测锚定)。
 * 任何一步不认得的形状 → `schema_changed` + 空 rows,绝不猜。
 */
export function parseDouyinItemList(bodyText: string): DouyinParse {
  if (looksLikeHtml("", bodyText)) return { kind: "stop", result: failure("schema_changed", "html_response:item_list") };
  const parsed = parseJsonSafe(protectBigIntIds(bodyText));
  if (!parsed.ok) return { kind: "stop", result: failure("schema_changed", "json_parse:item_list") };
  if (!isRecord(parsed.value)) return { kind: "stop", result: schemaChanged("item_list.envelope") };
  const json = parsed.value;

  const statusCode = typeof json.status_code === "number" ? json.status_code : 0;
  if (statusCode === ENVELOPE_NOT_LOGGED_IN) {
    return { kind: "stop", result: failure("needs_login", `envelope:${ENVELOPE_NOT_LOGGED_IN}`) };
  }
  if (statusCode !== 0) return { kind: "stop", result: failure("error", `envelope:${statusCode}`) };

  const awemeList = json.aweme_list;
  const items = json.items;
  let rows: TypedRow[];
  if (Array.isArray(awemeList)) rows = rowsFromLegacy(awemeList, Array.isArray(items) ? items : []);
  else if (Array.isArray(items)) rows = rowsFromItems(items);
  else return { kind: "stop", result: schemaChanged("items") };

  return { kind: "ok", rows, hasMore: json.has_more === true || json.has_more === 1 };
}

/** 多条拦截响应合并:任一条判出终止态就整体终止(未登录优先于「解析不出」) */
export function mergeDouyinParses(parses: DouyinParse[], limit = PAGE_ROW_LIMIT): PullResult & { rejected?: number } {
  const stops = parses.filter((p): p is Extract<DouyinParse, { kind: "stop" }> => p.kind === "stop");
  const oks = parses.filter((p): p is Extract<DouyinParse, { kind: "ok" }> => p.kind === "ok");
  if (oks.length === 0) {
    const login = stops.find((s) => s.result.status === "needs_login");
    return login?.result ?? stops[0]?.result ?? schemaChanged("items");
  }
  const merged: TypedRow[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  let hasMore = false;
  for (const ok of oks) {
    const valid = keepValidRows(ok.rows);
    rejected += valid.rejected;
    for (const row of valid.rows) {
      const key = row.platformItemId ?? `${row.title}@${row.publishedAt ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
    hasMore = hasMore || ok.hasMore;
  }
  return { ...okResult(merged.slice(0, limit), hasMore || merged.length > limit), rejected };
}

/** 旁听能力面(EgoSession 满足);测试塞桩,不连浏览器 */
export interface DouyinBrowser {
  intercept(p: { url: string; patterns: string[]; waitMs: number; settleMs: number }): Promise<InterceptResult>;
}

export interface PullDouyinOptions {
  waitMs?: number;
  settleMs?: number;
  limit?: number;
  /** 测试注入点:默认走 ego lite 通道 */
  connect?: () => DouyinBrowser;
}

/**
 * DOM 兜底(只在**什么都没拦到**时才用):页面文本命中登录墙 = needs_login,否则 timeout。
 * 页面文本只用于判定,**永不进 errorCode**(spec §4.1 脱敏红线)。
 */
function judgeDomText(domText: string | null): PullResult {
  if (domText === null) return failure("timeout", "dom_probe_failed");
  if (/扫码登录|手机号登录|请先登录|登录后查看/.test(domText)) return failure("needs_login", "dom_login_wall");
  return failure("timeout", "no_list_response");
}

/** 旁听结果 → 最终状态(纯函数) */
export function judgeIntercept(r: InterceptResult, limit = PAGE_ROW_LIMIT): PullResult {
  // 窗口内一条都没拦到:先分清是登录墙还是慢/接口没发
  if (r.matched === 0) return judgeDomText(r.domText);
  // 拦到事件却一个响应体都读不出来 → 归 timeout(不是接口漂移,别误报 canary)
  if (r.bodies.length === 0) return failure("timeout", "response_body_unavailable");
  return mergeDouyinParses(r.bodies.map(parseDouyinItemList), limit);
}

/**
 * 抓取抖音作品数据。状态判定矩阵:
 *
 * | 输入 | 状态 |
 * |---|---|
 * | 拦到列表响应,`status_code:0` + `items`/`aweme_list` 合法 | `ok`(行超 200 → `hasMore:true`) |
 * | 拦到列表响应,`status_code:8` | `needs_login` |
 * | 拦到列表响应,`status_code` 其他非 0 | `error`(`envelope:<码>`) |
 * | 拦到了,但 HTML 伪装 200 / JSON 解析失败 / 无 `items` 与 `aweme_list` | `schema_changed` + 空 rows |
 * | 窗口内什么都没拦到,页面文本有「扫码登录」(跳了登录页) | `needs_login` |
 * | 窗口内什么都没拦到,页面文本无登录线索 | `timeout` |
 * | 拦到事件但响应体两次都读不出 | `timeout` |
 * | ego lite 没开 / `ego-browser` 不在 | `browser_unreachable` |
 * | 单次抓取总超时(子进程被杀) | `timeout` |
 * | `ego-browser` 输出不是预期 JSON | `error`(`ego_bad_output`),零写入 |
 */
export async function pullDouyinStats(opts: PullDouyinOptions = {}): Promise<PullResult> {
  try {
    const browser = opts.connect ? opts.connect() : new EgoSession({ label: "douyin" });
    const intercepted = await browser.intercept({
      url: DOUYIN_MANAGE_URL,
      patterns: LIST_URL_PATTERNS,
      waitMs: opts.waitMs ?? DEFAULT_WAIT_MS,
      settleMs: opts.settleMs ?? DEFAULT_SETTLE_MS,
    });
    return judgeIntercept(intercepted, opts.limit ?? PAGE_ROW_LIMIT);
  } catch (err) {
    return classifyThrown(err);
  }
}
