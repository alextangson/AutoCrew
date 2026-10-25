/**
 * B站创作中心数据回流 —— **旁听**(规格 docs/2026-10-03-metrics-pull-human-like-spec.md)。
 *
 * 打开官方「内容管理 → 稿件管理」页,页面自己请求 `member.bilibili.com/x/web/archives`(2026-10-25 只读探查实测),
 * 我们只读它收到的响应;要下一页就像人一样点「下一页」。代码不向 B站后台发任何请求。
 *
 * 字段(2026-10-25 实测):`data.arc_audits[].Archive.{bvid,title,ptime(秒)}` + `.stat.{view,like,reply,share,favorite}`,
 * 分页 `data.page.{pn,ps,count}`。信封 `code`:0 = 正常;-101 = 未登录;-352 / -412 = 风控。
 * 「下一页」控件的文字待真机校准(探查时只有 1 页内的近 30 天稿件,没翻过页)。
 */
import type { CapturedResponse } from "./ego-session.js";
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import { assign, envelopeOf, failure, firstString, idOf, isRecord, isoFromSeconds, schemaChanged } from "./pull-shared.js";
import { runPassivePull, type PageParse, type PassivePlatform, type PassivePullOptions } from "./passive-pull.js";
import { LOGIN_TEXT_COMMON, RISK_TEXT_COMMON, RISK_URL_COMMON } from "./gates.js";

export const BILIBILI_MANAGE_URL = "https://member.bilibili.com/platform/upload-manager/article";
export const ARCHIVES_PATTERNS = ["/x/web/archives"];
/** 信封:未登录 / 风控 */
const NOT_LOGGED_IN = -101;
const RISK_CODES = new Set([-352, -412]);

function mapArchive(entry: unknown): TypedRow {
  const audit = isRecord(entry) ? entry : {};
  const arc = isRecord(audit.Archive) ? audit.Archive : {};
  const stat = isRecord(audit.stat) ? audit.stat : {};
  const metrics: Partial<OutcomeMetrics> = {};
  assign(metrics, "views", stat.view);
  assign(metrics, "likes", stat.like);
  assign(metrics, "comments", stat.reply);
  assign(metrics, "shares", stat.share);
  assign(metrics, "favorites", stat.favorite);
  const id = idOf(arc.bvid);
  return {
    title: firstString(arc.title),
    publishedAt: isoFromSeconds(arc.ptime),
    ...(id ? { platformItemId: id } : {}),
    metrics,
  };
}

/** 页面收到的一条稿件列表响应的解析(纯函数,fixture 单测锚定) */
export function parseArchives(res: CapturedResponse): PageParse {
  const env = envelopeOf(res, "archives");
  if (!env.ok) return { kind: "stop", result: env.result };
  const code = typeof env.json.code === "number" ? env.json.code : null;
  if (code === NOT_LOGGED_IN) return { kind: "stop", result: failure("needs_login", `envelope:${code}`) };
  if (code !== null && RISK_CODES.has(code)) return { kind: "stop", result: failure("risk_control", `envelope:${code}`) };
  if (code !== 0) return { kind: "stop", result: failure("error", `envelope:${code ?? "missing"}`) };
  const data = isRecord(env.json.data) ? env.json.data : null;
  if (!data) return { kind: "stop", result: schemaChanged("data") };
  // 没有稿件时 B站给 null:不是结构变了,是这页确实没有
  if (data.arc_audits === null) return { kind: "ok", rows: [] };
  if (!Array.isArray(data.arc_audits)) return { kind: "stop", result: schemaChanged("data.arc_audits") };
  return { kind: "ok", rows: data.arc_audits.map(mapArchive) };
}

/** ego 子进程里跑(自包含):本页最早发布时间 + pn×ps 是否已到 count;-101 立刻收手 */
export const BILIBILI_INSPECT_SRC = `(responses) => {
  let oldest = null, more = null, terminal = null;
  for (const r of responses) {
    let j; try { j = JSON.parse(r.body); } catch { continue; }
    if (j && j.code === -101) terminal = "login";
    if (j && (j.code === -352 || j.code === -412)) terminal = "risk";
    const d = (j && j.data) || {};
    for (const it of Array.isArray(d.arc_audits) ? d.arc_audits : []) {
      const t = Number(it && it.Archive && it.Archive.ptime);
      if (t > 0 && (oldest === null || t * 1000 < oldest)) oldest = t * 1000;
    }
    const p = d.page || {};
    const pn = Number(p.pn), ps = Number(p.ps), count = Number(p.count);
    if (pn > 0 && ps > 0 && Number.isFinite(count)) more = more === true || pn * ps < count;
  }
  return { oldestMs: oldest, hasMore: more, terminal };
}`;

export const BILIBILI_PLATFORM: PassivePlatform = {
  label: "bilibili",
  url: BILIBILI_MANAGE_URL,
  patterns: ARCHIVES_PATTERNS,
  gates: { loginUrl: "passport\\.bilibili\\.com/login", riskUrl: RISK_URL_COMMON, loginText: LOGIN_TEXT_COMMON, riskText: RISK_TEXT_COMMON },
  next: { kind: "click", css: "a,button,span,li", texts: ["下一页"] },
  inspectSrc: BILIBILI_INSPECT_SRC,
  parseResponse: parseArchives,
};

/** 抓取 B站近 30 天稿件数据(状态判定同 passive-pull.judgeBrowse) */
export function pullBilibiliStats(opts: PassivePullOptions = {}): Promise<PullResult> {
  return runPassivePull(BILIBILI_PLATFORM, opts);
}
