/**
 * 收件箱专用加固网页抓取 — 信任边界与 chat 路径不同：URL 来自外部转发（TG 等），
 * 不再是与本机同信任级的用户输入，因此必须拦私网、封响应体、限跳数。
 *
 * chat 路径的 `src/utils/fetch-page.ts` 保持其「不拦私网」假设不变，本文件只复用其
 * 纯抽取函数 `htmlToText`，不改其行为。
 *
 * 加固链：协议白名单 → 每跳 SSRF 校验（DNS 解析后逐个 IP 判段）→ 手动跟随 ≤5 跳 →
 * Content-Type 白名单 → 流式 2MB 封顶 → 15s 硬超时。
 *
 * 前三段（协议/SSRF/重定向）由 `utils/guarded-fetch` 提供，与深调研图片下载器共用
 * 同一份实现——本文件只保留网页侧的裁决（Content-Type、正文抽取、图片候选采集）。
 * 错误类型仍是本文件的 `FetchExternalError`：骨架通过 makeError 工厂产出它。
 *
 * 残余风险（V1 显式接受）：DNS rebinding TOCTOU —— 校验用的解析与 fetch 实际连接时的
 * 解析是两次独立解析，两次之间 DNS 可被改写指向内网。V1 不做 connect-by-IP（会破坏
 * TLS SNI / 证书校验与后续 undici 代理链路），显式接受该残余面。
 */
import { htmlToText } from "../../utils/fetch-page.js";
import { fetchFollowingRedirects, isBlockedAddress } from "../../utils/guarded-fetch.js";
import type { LookupFn } from "../../utils/guarded-fetch.js";

/** 守卫原语在 utils/guarded-fetch，这里原样转出——既有调用方与测试的导入路径不变 */
export { isBlockedAddress };
export type { LookupFn };

export type FetchExternalErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "ssrf_blocked"
  | "too_many_redirects"
  | "unsupported_content_type"
  | "body_too_large"
  | "timeout"
  | "fetch_failed"
  | `http_${number}`;

export class FetchExternalError extends Error {
  constructor(
    readonly errorCode: FetchExternalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FetchExternalError";
  }
}

export interface FetchExternalOptions {
  /** 全流程硬超时，默认 15_000ms（覆盖全部重定向跳数与读体） */
  timeoutMs?: number;
  /** 响应体字节上限，默认 2MB，超限即断连 */
  maxBytes?: number;
  /** 重定向上限，默认 5 跳 */
  maxRedirects?: number;
  /**
   * 仅测试注入：让环回测试服在 SSRF 守卫眼中呈现为公网地址。
   * 生产路径不传 —— 默认走 node:dns。
   */
  lookup?: LookupFn;
  /**
   * 深调研素材采集（深调研 spec §3）：额外从原始 HTML 抽图片候选。
   * 默认关闭 —— 关闭时返回值形状与本选项存在前逐字一致（收件箱路径零变化）。
   */
  collectImages?: boolean;
}

/** 候选出自哪个位置：img 的 src / img 的 srcset 最大候选 / og:image */
export type ImageCandidateSource = "img" | "srcset" | "og";

export interface ImageCandidate {
  /** 已按 finalUrl 解析成的绝对地址（http/https） */
  url: string;
  sourceAttr: ImageCandidateSource;
}

export interface ExternalPage {
  /** 跟随全部重定向后的最终 URL */
  finalUrl: string;
  text: string;
  title?: string;
  /** 仅 collectImages 开启时存在；开启即必有（无图为空数组，text/plain 亦然） */
  imageCandidates?: ImageCandidate[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 AutoCrew/1.0",
  accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
};

function contentKind(header: string | null): "html" | "text" | null {
  const mime = (header ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "text/html") return "html";
  if (mime === "text/plain") return "text";
  return null;
}

/** 流式读，字节封顶即断连——不允许先整体 res.text()。 */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FetchExternalError("body_too_large", `响应体超过 ${maxBytes} 字节上限，已中止`);
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

// ─── 图片候选采集（深调研 spec §3/§17：确定性采集，不信模型转述 URL）───────────

/** 每页上限：够综合挑图，又不会让一个图墙页把全 job 素材位吃光 */
const MAX_IMAGE_CANDIDATES = 10;
/** URL 里出现即判埋点像素——启发式，宁可漏采不可采回一堆 1x1 */
const TRACKER_HINTS = ["pixel", "tracker", "beacon"];
/** 尺寸属性只认纯像素值："100%" 是布局宽度不是像素，不据此丢弃 */
const PIXEL_SIZE = /^\s*(\d+)(?:px)?\s*$/i;
const MIN_IMAGE_SIZE_PX = 200;
const SCRIPT_OR_STYLE = /<(script|style)\b[\s\S]*?<\/\1>/gi;
const TAG_ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(TAG_ATTR)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/**
 * `url 1024w, url2 2x` → 取描述值最大的候选；无描述子按 1 计。
 * w 与 x 混用是非法 HTML，真撞上就让 x 乘 1000 保证倍率不输给宽度值。
 */
function pickLargestSrcset(value: string): string | null {
  let best: { url: string; weight: number } | null = null;
  for (const part of value.split(",")) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length === 0) continue;
    const desc = /^(\d+(?:\.\d+)?)(w|x)$/i.exec(bits[1] ?? "");
    const weight = desc ? Number(desc[1]) * (desc[2].toLowerCase() === "x" ? 1000 : 1) : 1;
    if (!best || weight > best.weight) best = { url: bits[0], weight };
  }
  return best?.url ?? null;
}

/** 相对→绝对 + 全部跳过规则；不合格返回 null（调用方据此回落下一个来源） */
function toCandidateUrl(raw: string | undefined, base: URL): string | null {
  const value = (raw ?? "").trim().replace(/&amp;/gi, "&");
  if (!value || /^data:/i.test(value)) return null;
  let abs: URL;
  try {
    abs = new URL(value, base);
  } catch {
    return null;
  }
  if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;
  if (abs.pathname.toLowerCase().endsWith(".svg")) return null;
  const probe = `${abs.hostname}${abs.pathname}${abs.search}`.toLowerCase();
  if (TRACKER_HINTS.some((h) => probe.includes(h))) return null;
  return abs.href;
}

function tooSmall(attrs: Record<string, string>): boolean {
  return ["width", "height"].some((key) => {
    const m = PIXEL_SIZE.exec(attrs[key] ?? "");
    return m !== null && Number(m[1]) < MIN_IMAGE_SIZE_PX;
  });
}

function ogImage(html: string, base: URL): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttrs(m[0]);
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (key !== "og:image" && key !== "og:image:url" && key !== "og:image:secure_url") continue;
    const url = toCandidateUrl(attrs.content, base);
    if (url) return url;
  }
  return null;
}

/**
 * 从**原始 HTML**（正文抽取前）收集图片候选：og:image 优先（页面自选主图，
 * 最该在 10 条上限里活下来），其后按文档顺序逐个 `<img>`——有 srcset 取最大候选，
 * 否则用 src。页内按绝对 URL 去重；全 job 去重与上限归 broker 管。
 */
export function collectImageCandidates(html: string, baseUrl: string): ImageCandidate[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  const push = (url: string | null, sourceAttr: ImageCandidateSource): void => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, sourceAttr });
  };
  const scannable = html.replace(SCRIPT_OR_STYLE, " ");
  push(ogImage(scannable, base), "og");
  for (const m of scannable.matchAll(/<img\b[^>]*>/gi)) {
    if (out.length >= MAX_IMAGE_CANDIDATES) break;
    const attrs = parseAttrs(m[0]);
    if (tooSmall(attrs)) continue;
    const fromSrcset = attrs.srcset ? toCandidateUrl(pickLargestSrcset(attrs.srcset) ?? "", base) : null;
    if (fromSrcset) push(fromSrcset, "srcset");
    else push(toCandidateUrl(attrs.src, base), "img");
  }
  return out.slice(0, MAX_IMAGE_CANDIDATES);
}

async function readPage(
  res: Response,
  finalUrl: URL,
  maxBytes: number,
  collectImages: boolean,
): Promise<ExternalPage> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FetchExternalError(`http_${res.status}`, `上游返回 ${res.status}`);
  }
  const kind = contentKind(res.headers.get("content-type"));
  if (!kind) {
    await res.body?.cancel().catch(() => {});
    throw new FetchExternalError(
      "unsupported_content_type",
      `仅接受 text/html 与 text/plain，实际：${res.headers.get("content-type") ?? "(缺失)"}`,
    );
  }
  const body = await readCappedText(res, maxBytes);
  if (kind === "text") {
    return { finalUrl: finalUrl.href, text: body.trim(), ...(collectImages ? { imageCandidates: [] } : {}) };
  }
  // 采集必须发生在正文抽取之前：htmlToText 会把标签整片剥掉，之后再找 img 已无从谈起
  const imageCandidates = collectImages ? collectImageCandidates(body, finalUrl.href) : null;
  const { title, text } = htmlToText(body);
  return {
    finalUrl: finalUrl.href,
    text,
    ...(title ? { title } : {}),
    ...(imageCandidates ? { imageCandidates } : {}),
  };
}

function toFetchError(err: unknown, timedOut: boolean): FetchExternalError {
  if (err instanceof FetchExternalError) return err;
  const name = err instanceof Error ? err.name : "";
  if (timedOut || name === "AbortError" || name === "TimeoutError") {
    return new FetchExternalError("timeout", "抓取超时");
  }
  return new FetchExternalError("fetch_failed", `抓取失败：${err instanceof Error ? err.message : String(err)}`);
}

/**
 * 抓取外部网页（收件箱路径）。失败一律抛 FetchExternalError，带稳定 errorCode。
 */
export async function fetchExternalPage(url: string, opts: FetchExternalOptions = {}): Promise<ExternalPage> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const { res, finalUrl } = await fetchFollowingRedirects({
      url,
      maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      signal: controller.signal,
      headers: REQUEST_HEADERS,
      lookup: opts.lookup,
      makeError: (code, message) => new FetchExternalError(code, message),
    });
    return await readPage(res, finalUrl, maxBytes, opts.collectImages === true);
  } catch (err) {
    throw toFetchError(err, timedOut);
  } finally {
    clearTimeout(timer);
  }
}
