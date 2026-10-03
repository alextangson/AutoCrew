/**
 * 公众号后台数据回流 —— **旁听**(规格 docs/2026-10-03-metrics-pull-human-like-spec.md)。
 *
 * 打开 mp.weixin.qq.com,等它自己跳到带 token 的首页,再像人一样打开「发表记录」页
 * (`/cgi-bin/appmsgpublish?sub=list`),只读页面自己收到的响应(文档本身或页面翻页时的 JSON),
 * 要下一页就点页面上的「下一页」。代码不向公众号后台发任何请求。
 *
 * 字段沿用 musegzh 已验证的 `publish_page.publish_list[].publish_info.appmsg_info[]`
 * (read_num / share_num / old_like_num / sent_info.time)。**旁听形态待真机校准**:2026-10-03 探查时
 * ego lite 里公众号未登录,没看到发表记录页的真实响应——页面首屏若把数据嵌在 HTML 里,按 `publish_page = {...};` 取。
 */
import type { CapturedResponse } from "./ego-session.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import { assign, failure, httpFailure, isRecord, isoFromSeconds, parseJsonSafe } from "./pull-shared.js";
import { runPassivePull, type PageParse, type PassivePlatform, type PassivePullOptions } from "./passive-pull.js";
import { LOGIN_TEXT_COMMON, RISK_TEXT_COMMON, RISK_URL_COMMON } from "./gates.js";

const BACKEND = "https://mp.weixin.qq.com/";
export const PUBLISH_LIST_TEMPLATE = `${BACKEND}cgi-bin/appmsgpublish?sub=list&begin=0&count=10&token=$1&lang=zh_CN`;
export const PUBLISH_PATTERNS = ["/cgi-bin/appmsgpublish"];

/** 响应 → publish_page 对象:JSON 响应直接取;HTML 文档里取 `publish_page = {...};`。取不到 = null */
export function extractPublishPage(body: string): Record<string, unknown> | null {
  let raw: unknown;
  const json = parseJsonSafe(body);
  if (json.ok && isRecord(json.value)) raw = json.value.publish_page;
  else {
    const m = /publish_page\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:\n|<\/script>|var |window)/.exec(body);
    if (!m) return null;
    raw = m[1];
  }
  if (typeof raw === "string") {
    const inner = parseJsonSafe(raw);
    raw = inner.ok ? inner.value : null;
  }
  return isRecord(raw) ? raw : null;
}

function rowsOfEntry(entry: unknown): TypedRow[] {
  let info: unknown = isRecord(entry) ? entry.publish_info : null;
  if (typeof info === "string") {
    const p = parseJsonSafe(info);
    info = p.ok ? p.value : null;
  }
  if (!isRecord(info)) return [];
  const sent = isRecord(info.sent_info) ? info.sent_info : {};
  const publishedAt = isoFromSeconds(sent.time);
  const articles = Array.isArray(info.appmsg_info) ? info.appmsg_info : [];
  return articles.filter(isRecord).map((a) => {
    const metrics: TypedRow["metrics"] = {};
    assign(metrics, "views", a.read_num);
    assign(metrics, "shares", a.share_num);
    assign(metrics, "likes", a.old_like_num);
    return { title: String(a.title ?? "").trim(), publishedAt, metrics };
  });
}

/** 页面收到的一条发表记录响应的解析(纯函数) */
export function parsePublishResponse(res: CapturedResponse): PageParse {
  if (res.status < 200 || res.status >= 300) return { kind: "stop", result: httpFailure(res.status) };
  const pp = extractPublishPage(res.body);
  if (!pp) return { kind: "stop", result: failure("schema_changed", "missing:publish_page") };
  if (!Array.isArray(pp.publish_list)) return { kind: "stop", result: failure("schema_changed", "missing:publish_page.publish_list") };
  return { kind: "ok", rows: pp.publish_list.flatMap(rowsOfEntry) };
}

/** ego 子进程里跑(自包含):本页最早群发时间 + begin+count 是否已到 total_count */
export const WECHAT_MP_INSPECT_SRC = `(responses) => {
  let oldest = null, more = null;
  const pick = (body) => {
    let pp = null;
    try { pp = JSON.parse(body).publish_page; } catch {
      const m = /publish_page\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;\\s*(?:\\n|<\\/script>|var |window)/.exec(body);
      pp = m ? m[1] : null;
    }
    if (typeof pp === "string") { try { pp = JSON.parse(pp); } catch { pp = null; } }
    return pp && typeof pp === "object" ? pp : null;
  };
  for (const r of responses) {
    const pp = pick(r.body);
    if (!pp) continue;
    for (const e of Array.isArray(pp.publish_list) ? pp.publish_list : []) {
      let info = e && e.publish_info;
      if (typeof info === "string") { try { info = JSON.parse(info); } catch { info = null; } }
      const t = Number(info && info.sent_info && info.sent_info.time);
      if (t > 0 && (oldest === null || t * 1000 < oldest)) oldest = t * 1000;
    }
    const q = new URL(r.url).searchParams;
    const begin = Number(q.get("begin") || 0), count = Number(q.get("count") || 0), total = Number(pp.total_count);
    if (count > 0 && Number.isFinite(total)) more = more === true || begin + count < total;
  }
  return { oldestMs: oldest, hasMore: more };
}`;

export const WECHAT_MP_PLATFORM: PassivePlatform = {
  label: "wechat_mp",
  url: BACKEND,
  follow: { match: "token=(\\d+)", template: PUBLISH_LIST_TEMPLATE },
  patterns: PUBLISH_PATTERNS,
  gates: { riskUrl: RISK_URL_COMMON, loginText: LOGIN_TEXT_COMMON, riskText: RISK_TEXT_COMMON },
  next: { kind: "click", css: "a,button,span", texts: ["下一页"] },
  inspectSrc: WECHAT_MP_INSPECT_SRC,
  parseResponse: parsePublishResponse,
};

/** 抓取公众号近 30 天已发表文章的数据(状态判定同 passive-pull.judgeBrowse;同标题后者覆盖前者) */
export async function pullWechatMpStats(opts: PassivePullOptions = {}): Promise<PullResult> {
  const r = await runPassivePull(WECHAT_MP_PLATFORM, opts);
  if (r.status !== "ok") return r;
  const byTitle = new Map<string, TypedRow>();
  for (const row of r.rows) byTitle.set(normTitle(row.title), row);
  return { ...r, rows: [...byTitle.values()] };
}

const normTitle = (t: string): string => (t || "").toLowerCase().replace(/[^\w一-鿿]/g, "");

function fmtSentTime(iso: string | null): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/** 行 → 导入管线列(键名对齐 PLATFORM_MAPPINGS.wechat_mp 别名;与旧拉数口径一致,走同一条 CSV 导入) */
export function statsToImportRows(rows: TypedRow[]): Array<Record<string, string>> {
  return rows.map((r) => ({
    标题: r.title,
    发表时间: fmtSentTime(r.publishedAt),
    阅读次数: String(r.metrics.views ?? 0),
    分享次数: String(r.metrics.shares ?? 0),
    在看次数: String(r.metrics.likes ?? 0),
  }));
}
