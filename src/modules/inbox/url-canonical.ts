/**
 * URL 规范化 — 收件箱幂等键的唯一来源（spec §3.1）。纯函数、零网络。
 *
 * 入参必须是**已解析到最终跳**的 URL：重定向解析与 SSRF 校验属于抓取层（§3.2），
 * 短链解析失败时上游按约定回退用原始 URL 当键——所以这里对任何解析不了的输入
 * 都原样返回，绝不抛错（幂等键不能因为一个怪 URL 就断掉整条管线）。
 *
 * 只做 spec 明列的三条规则：x 取 status id、抖音取 video id、通用去显式 tracking 参数。
 * 不做通配删参、不重排参数、不动 fragment/末尾斜杠——多余的「聪明」会把两个
 * 本来不同的链接并成一个，比漏查重更贵。
 */
import { createHash } from "node:crypto";

/** 显式 strip 清单（§3.1）：前缀匹配只用于 utm_*，其余必须整名命中 */
const TRACKING_PREFIXES = ["utm_"];
const TRACKING_KEYS = new Set(["fbclid", "gclid", "spm", "share_token"]);

const X_DOMAINS = ["x.com", "twitter.com"];
const DOUYIN_DOMAIN = "douyin.com";

/** 平台 id 一律纯数字；非数字段说明命中的不是 status/video 路径，回落通用规则 */
const NUMERIC_ID = /^\d+$/;

/** 子域一并归属主域：mobile.twitter.com、v.douyin.com 都要走同一条规范化 */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathSegments(u: URL): string[] {
  return u.pathname.split("/").filter(Boolean);
}

/** /<user>/status/<id>、/i/web/status/<id>、/statuses/<id> 三种形态统一取 id */
function xStatusId(u: URL): string | null {
  const segs = pathSegments(u);
  const at = segs.findIndex((s) => s === "status" || s === "statuses");
  if (at < 0) return null;
  const id = segs[at + 1];
  return id && NUMERIC_ID.test(id) ? id : null;
}

/** /video/<id> 与「主页 + modal_id」两种分享形态都是同一条视频 */
function douyinVideoId(u: URL): string | null {
  const segs = pathSegments(u);
  const at = segs.indexOf("video");
  const fromPath = at >= 0 ? segs[at + 1] : undefined;
  if (fromPath && NUMERIC_ID.test(fromPath)) return fromPath;
  const modalId = u.searchParams.get("modal_id");
  return modalId && NUMERIC_ID.test(modalId) ? modalId : null;
}

function isTrackingKey(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACKING_KEYS.has(lower) || TRACKING_PREFIXES.some((p) => lower.startsWith(p));
}

/** 无命中就不碰 searchParams——一旦写入会整段重新编码，凭空改变未被要求改的 URL */
function stripTracking(u: URL): void {
  const doomed = [...u.searchParams.keys()].filter(isTrackingKey);
  for (const key of doomed) u.searchParams.delete(key);
}

/**
 * 规范化最终 URL，产出幂等键。不可解析 / 非 http(s) 的输入原样（trim 后）返回：
 * 入队前的协议白名单是 ingress 的活（§2.2），这里保持全函数、可组合。
 */
export function canonicalizeUrl(finalUrl: string): string {
  const raw = finalUrl.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return raw;

  const host = u.hostname.toLowerCase();
  if (X_DOMAINS.some((d) => hostMatches(host, d))) {
    const id = xStatusId(u);
    if (id) return `https://x.com/i/status/${id}`;
  }
  if (hostMatches(host, DOUYIN_DOMAIN)) {
    const id = douyinVideoId(u);
    if (id) return `https://www.douyin.com/video/${id}`;
  }

  stripTracking(u);
  return u.toString();
}

/**
 * 纯文字笔记的幂等键（§2.1）：trim + 空白折叠 + sha256。
 * 不做大小写归一——中文笔记里 "AI" 与 "ai" 不该被当成同一条。
 * 返回 sha256 十六进制串（不是归一化后的文本）。
 */
export function normalizeTextForHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}
