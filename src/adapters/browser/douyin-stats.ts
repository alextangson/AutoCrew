/**
 * 抖音创作者后台数据回流 —— **旁听**(规格 docs/2026-10-03-metrics-pull-human-like-spec.md)。
 *
 * 打开作品管理页,页面自己带齐签名去请求作品列表,我们只接住它收到的 JSON 响应;要更多就像人一样往下滚
 * (列表是无限滚动),每次滚动前随机停 2–6 秒。代码不向抖音后台发任何请求。
 *
 * 坑(端点文档 §1):① `items[].id` 是超长 JSON number → 解析前先包成字符串;② `metrics.*` 全是字符串 →
 * `toCount` 统一转;③ 信封 `status_code: 8` = 未登录。
 */
import type { CapturedResponse } from "./ego-session.js";
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import { assign, envelopeOf, failure, firstString, idOf, isRecord, isoFromSeconds, protectLongNumbers, schemaChanged } from "./pull-shared.js";
import { runPassivePull, type PageParse, type PassivePlatform, type PassivePullOptions } from "./passive-pull.js";
import { LOGIN_TEXT_COMMON, RISK_TEXT_COMMON, RISK_URL_COMMON } from "./gates.js";

/** 作品管理页:页面自己会去打列表接口,我们只旁听 */
export const DOUYIN_MANAGE_URL = "https://creator.douyin.com/creator-micro/content/manage";
/** 现行主路 + 旧路(两套并存 → 都认) */
export const LIST_URL_PATTERNS = ["/web/api/creator/item/list", "/janus/douyin/creator/pc/work_list"];
/** 信封:未登录 */
const ENVELOPE_NOT_LOGGED_IN = 8;

/** 抖音会丢精度的 id 字段 */
const DOUYIN_ID_KEYS = ["id", "item_id", "aweme_id", "group_id", "object_id"];

/**
 * 作品 id 取值顺序（2026-10-03 真实 work_list 抓包核实）：旧路 `aweme_list[].item_id` 在**响应原文里**
 * 就已是被抖音截成 …000 的数字，文本层保护救不回来；完整 id 只在字符串字段 `aweme_id` / `id_str`
 * 和主路 `items[].id`（原文完整、靠 protectBigIntIds 保位）里。所以字符串字段优先，item_id 垫底。
 */
function douyinItemId(base: Bag): string {
  return idOf(base.aweme_id, base.id_str, base.id, base.item_id);
}

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
  const id = douyinItemId(base);
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

/**
 * 旧路 work_list:`aweme_list[]` 出基础字段与计数,率类指标在 `items[].metrics`。
 * 两个数组**不同长也不同序**(2026-10-03 抓包:aweme_list 含定时未发的作品,items 只有已发的),
 * 只按作品 id 配对;配不上就不取率类指标,绝不按索引猜(按索引会把别的作品的完播率安到这条上)。
 */
function rowsFromLegacy(awemeList: unknown[], items: unknown[]): TypedRow[] {
  const byId = new Map<string, Bag>();
  for (const it of items) {
    const bag = bagOf(it);
    const id = douyinItemId(bag);
    if (id) byId.set(id, bag);
  }
  return awemeList.map((entry) => {
    const base = bagOf(entry);
    const paired = byId.get(douyinItemId(base)) ?? {};
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

/**
 * 解析页面收到的一条列表响应(纯函数,fixture 单测锚定)。
 * 任何一步不认得的形状 → `schema_changed` + 空 rows,绝不猜。
 */
export function parseDouyinItemList(resp: CapturedResponse): PageParse {
  const env = envelopeOf(resp, "item_list", DOUYIN_ID_KEYS);
  if (!env.ok) return { kind: "stop", result: env.result };
  const json = env.json;
  const statusCode = typeof json.status_code === "number" ? json.status_code : 0;
  if (statusCode === ENVELOPE_NOT_LOGGED_IN) {
    return { kind: "stop", result: failure("needs_login", `envelope:${ENVELOPE_NOT_LOGGED_IN}`) };
  }
  if (statusCode !== 0) return { kind: "stop", result: failure("error", `envelope:${statusCode}`) };
  const awemeList = json.aweme_list;
  const items = json.items;
  if (Array.isArray(awemeList)) return { kind: "ok", rows: rowsFromLegacy(awemeList, Array.isArray(items) ? items : []) };
  if (Array.isArray(items)) return { kind: "ok", rows: rowsFromItems(items) };
  return { kind: "stop", result: schemaChanged("items") };
}

/**
 * 在 ego 子进程里跑(自包含,不能引用外部符号):这一页最早的作品发布时间 + 平台说还有没有下一页
 * + 信封终止态(status_code 8 = 未登录 → 立刻停,不再滚)。
 * 决定还滚不滚;判不出就返回 null,交给 3 页上限兜底。
 */
export const DOUYIN_INSPECT_SRC = `(responses) => {
  let oldest = null, more = null, terminal = null;
  for (const r of responses) {
    let j; try { j = JSON.parse(r.body); } catch { continue; }
    if (j && j.status_code === 8) terminal = "login";
    const list = Array.isArray(j.aweme_list) ? j.aweme_list : Array.isArray(j.items) ? j.items : [];
    for (const it of list) { const t = Number(it && it.create_time); if (t > 0 && (oldest === null || t * 1000 < oldest)) oldest = t * 1000; }
    if (j.has_more === true || j.has_more === 1) more = true; else if (more === null && (j.has_more === false || j.has_more === 0)) more = false;
  }
  return { oldestMs: oldest, hasMore: more, terminal };
}`;

export const DOUYIN_PLATFORM: PassivePlatform = {
  label: "douyin",
  url: DOUYIN_MANAGE_URL,
  patterns: LIST_URL_PATTERNS,
  gates: { riskUrl: RISK_URL_COMMON, loginText: LOGIN_TEXT_COMMON, riskText: RISK_TEXT_COMMON },
  next: { kind: "scroll" },
  inspectSrc: DOUYIN_INSPECT_SRC,
  parseResponse: parseDouyinItemList,
};

/**
 * 抓取抖音作品数据。状态判定:
 *
 * | 输入 | 状态 |
 * |---|---|
 * | 收到列表响应,`status_code:0` + `items`/`aweme_list` 合法 | `ok` |
 * | 收到列表响应,`status_code:8` | `needs_login` |
 * | 收到列表响应,`status_code` 其他非 0 | `error`(`envelope:<码>`) |
 * | HTML 伪装 / JSON 解析失败 / 无 `items` 与 `aweme_list` | `schema_changed` + 空 rows |
 * | 等不到列表响应,页面是登录墙 / 风控页 | `needs_login` / `risk_control` |
 * | 等不到列表响应,也不是登录墙 | `error`(`no_data_response`) |
 * | 其余(通道故障、超时、中途出错、翻页)见 passive-pull.judgeBrowse | |
 */
export function pullDouyinStats(opts: PassivePullOptions = {}): Promise<PullResult> {
  return runPassivePull(DOUYIN_PLATFORM, opts);
}
