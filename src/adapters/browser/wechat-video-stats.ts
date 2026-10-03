/**
 * 视频号助手(channels.weixin.qq.com)数据回流 —— **旁听**(规格 docs/2026-10-03-metrics-pull-human-like-spec.md)。
 *
 * 打开官方「内容管理」页,页面自己请求 `/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list`
 * (2026-10-03 实测 HTTP 201 + `errCode:0` 是正常),我们只读它收到的响应体;要下一页就像人一样点页面上的
 * 「下一页」(页面是 wujie 微前端,分页控件在 shadow DOM 里)。代码不向视频号后台发任何请求、不加任何请求头。
 */
import type { CapturedResponse } from "./ego-session.js";
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import { assign, envelopeOf, failure, firstString, idOf, isRecord, isoFromSeconds } from "./pull-shared.js";
import { runPassivePull, type PageParse, type PassivePlatform, type PassivePullOptions } from "./passive-pull.js";
import { LOGIN_TEXT_COMMON, RISK_TEXT_COMMON, RISK_URL_COMMON } from "./gates.js";

/** 后台作品列表页 */
export const WECHAT_VIDEO_PAGE = "https://channels.weixin.qq.com/platform/post/list";
/** 页面自己发的作品列表请求(2026-10-03 实测路径带 /micro/content 前缀;不带前缀的旧路也认) */
export const POST_LIST_PATTERNS = ["/mmfinderassistant-bin/post/post_list"];
/** objectId/exportId 是 19 位数字,会丢精度 */
const WECHAT_ID_KEYS = ["objectId", "exportId"];

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

/** 页面收到的一条 post_list 响应的解析(纯函数,fixture 单测锚定) */
export function parsePostList(res: CapturedResponse): PageParse {
  const env = envelopeOf(res, "post_list", WECHAT_ID_KEYS);
  if (!env.ok) return { kind: "stop", result: env.result };
  const errCode = typeof env.json.errCode === "number" ? env.json.errCode : NaN;
  if (!Number.isFinite(errCode)) return { kind: "stop", result: failure("schema_changed", "missing:post_list.errCode") };
  if (errCode !== 0) return { kind: "stop", result: failure("error", `post_list_errcode:${errCode}`) };
  const data = isRecord(env.json.data) ? env.json.data : null;
  if (!data || !Array.isArray(data.list)) return { kind: "stop", result: failure("schema_changed", "missing:data.list") };
  return { kind: "ok", rows: data.list.map(mapPostRow) };
}

/** ego 子进程里跑(自包含):本页最早发布时间 + `continueFlag`(2026-10-03 实测字段) */
export const WECHAT_VIDEO_INSPECT_SRC = `(responses) => {
  let oldest = null, more = null;
  for (const r of responses) {
    let j; try { j = JSON.parse(r.body); } catch { continue; }
    const d = (j && j.data) || {};
    for (const it of Array.isArray(d.list) ? d.list : []) { const t = Number(it && it.createTime); if (t > 0 && (oldest === null || t * 1000 < oldest)) oldest = t * 1000; }
    if (d.continueFlag === true) more = true; else if (more === null && d.continueFlag === false) more = false;
  }
  return { oldestMs: oldest, hasMore: more };
}`;

export const WECHAT_VIDEO_PLATFORM: PassivePlatform = {
  label: "wechat_video",
  url: WECHAT_VIDEO_PAGE,
  patterns: POST_LIST_PATTERNS,
  gates: { loginUrl: "channels\\.weixin\\.qq\\.com/(platform/)?login", riskUrl: RISK_URL_COMMON, loginText: LOGIN_TEXT_COMMON, riskText: RISK_TEXT_COMMON },
  next: { kind: "click", css: "a,button,span", texts: ["下一页"] },
  inspectSrc: WECHAT_VIDEO_INSPECT_SRC,
  parseResponse: parsePostList,
};

/**
 * 抓取视频号作品数据。状态判定:
 *
 * | 输入 | 状态 |
 * |---|---|
 * | 收到 post_list,2xx + `errCode:0` + `data.list` 合法 | `ok` |
 * | HTTP 401/403 | `needs_login`;其他非 2xx → `error`(`http:<状态>`) |
 * | HTML 伪装 / JSON 解析失败 / 缺 `errCode` / 缺 `data.list` | `schema_changed` + 空 rows |
 * | `errCode !== 0` | `error`(`post_list_errcode:<码>`) |
 * | 跳到登录页 / 风控页 | `needs_login` / `risk_control` |
 * | 其余(等不到数据、通道故障、超时、中途出错、翻页)见 passive-pull.judgeBrowse | |
 */
export function pullWechatVideoStats(opts: PassivePullOptions = {}): Promise<PullResult> {
  return runPassivePull(WECHAT_VIDEO_PLATFORM, opts);
}
