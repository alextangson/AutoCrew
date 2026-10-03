/**
 * 小红书创作服务平台数据回流 —— **旁听**(规格 docs/2026-10-03-metrics-pull-human-like-spec.md)。
 *
 * 打开官方「数据看板 → 笔记数据」页,页面自己请求 `/api/galaxy/creator/datacenter/note/analyze/list`
 * (2026-10-03 实测 HTTP 200,页面默认就只查近 30 天),我们只读它收到的响应体;要下一页就像人一样点分页器的
 * 「下一页」箭头。代码不向小红书后台发任何请求、不调页面签名函数。
 * 曝光字段 `imp_count` 有,但三平台曝光口径未对齐 → 照旧不映射 impressions(不改对账口径)。
 */
import type { CapturedResponse } from "./ego-session.js";
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import { assign, envelopeOf, failure, firstString, idOf, isRecord, isoFromMillis } from "./pull-shared.js";
import { runPassivePull, type PageParse, type PassivePlatform, type PassivePullOptions } from "./passive-pull.js";
import { LOGIN_TEXT_COMMON, RISK_TEXT_COMMON, RISK_URL_COMMON } from "./gates.js";

/** 笔记数据页 */
export const XHS_PAGE = "https://creator.xiaohongshu.com/statistics/data-analysis";
export const ANALYZE_PATTERNS = ["/api/galaxy/creator/datacenter/note/analyze/list"];

export function mapNoteRow(entry: unknown): TypedRow {
  const note = isRecord(entry) ? entry : {};
  const metrics: Partial<OutcomeMetrics> = {};
  assign(metrics, "views", note.read_count);
  assign(metrics, "likes", note.like_count);
  assign(metrics, "favorites", note.fav_count);
  assign(metrics, "comments", note.comment_count);
  assign(metrics, "shares", note.share_count);
  const id = idOf(note.id, note.note_id);
  return {
    title: firstString(note.title, note.display_title, note.desc),
    publishedAt: isoFromMillis(note.post_time),
    ...(id ? { platformItemId: id } : {}),
    metrics,
  };
}

/**
 * 页面收到的一条笔记列表响应的解析(纯函数,fixture 单测锚定)。信封 `{success, code, msg, data}`;
 * 列表字段 `data.note_infos`(2026-10-03 实测)。
 */
export function parseNoteList(res: CapturedResponse): PageParse {
  const label = "analyze_list";
  const env = envelopeOf(res, label);
  if (!env.ok) return { kind: "stop", result: env.result };
  if (env.json.success === false) {
    const code = typeof env.json.code === "number" ? env.json.code : "unknown";
    return { kind: "stop", result: failure("error", `${label}_code:${code}`) };
  }
  const data = isRecord(env.json.data) ? env.json.data : null;
  const list = data && Array.isArray(data.note_infos) ? data.note_infos : null;
  if (!list) return { kind: "stop", result: failure("schema_changed", `missing:${label}.data.note_infos`) };
  return { kind: "ok", rows: list.map(mapNoteRow) };
}

/**
 * ego 子进程里跑(自包含):本页最早发布时间(post_time 毫秒)+ 还有没有下一页
 * (`data.total` 对比响应 URL 里的 page_num × page_size,2026-10-03 实测字段)。
 */
export const XHS_INSPECT_SRC = `(responses) => {
  let oldest = null, more = null;
  for (const r of responses) {
    let j; try { j = JSON.parse(r.body); } catch { continue; }
    const d = (j && j.data) || {};
    for (const it of Array.isArray(d.note_infos) ? d.note_infos : []) { const t = Number(it && it.post_time); if (t > 0 && (oldest === null || t < oldest)) oldest = t; }
    const q = new URL(r.url).searchParams;
    const num = Number(q.get("page_num")), size = Number(q.get("page_size")), total = Number(d.total);
    if (num > 0 && size > 0 && total >= 0 && Number.isFinite(total)) more = more === true || num * size < total;
  }
  return { oldestMs: oldest, hasMore: more };
}`;

export const XHS_PLATFORM: PassivePlatform = {
  label: "xiaohongshu",
  url: XHS_PAGE,
  patterns: ANALYZE_PATTERNS,
  gates: { loginUrl: "creator\\.xiaohongshu\\.com/login", riskUrl: RISK_URL_COMMON, loginText: LOGIN_TEXT_COMMON, riskText: RISK_TEXT_COMMON },
  // 分页器的「下一页」是无文字的箭头:取 .d-pagination-page 里最后一个无文字的
  next: { kind: "click", css: ".d-pagination-page", texts: [] },
  inspectSrc: XHS_INSPECT_SRC,
  parseResponse: parseNoteList,
};

/**
 * 抓取小红书笔记数据。状态判定:
 *
 * | 输入 | 状态 |
 * |---|---|
 * | 收到 analyze/list,`success:true` + `data.note_infos` 合法 | `ok` |
 * | HTTP 461/471 | `risk_control`(立即停);401/403 → `needs_login`;其他非 2xx → `error` |
 * | `success:false` | `error`(`analyze_list_code:<码>`) |
 * | HTML 伪装 / JSON 解析失败 / 缺 `data.note_infos` | `schema_changed` + 空 rows |
 * | 跳到登录页 / 风控页 | `needs_login` / `risk_control` |
 * | 其余见 passive-pull.judgeBrowse | |
 */
export function pullXhsStats(opts: PassivePullOptions = {}): Promise<PullResult> {
  return runPassivePull(XHS_PLATFORM, opts);
}
