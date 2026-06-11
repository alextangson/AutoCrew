/**
 * 网页正文抓取 — read_url 工具与选题雷达的取数原语。
 * 桌面单用户场景：URL 来自用户/模型，仅协议白名单（http/https），
 * 不做私网 IP 拦截（与用户同信任级，本机权限内）。
 */
import { checkFetchResponse } from "./retry.js";

export interface PageText {
  title: string | null;
  text: string;
  truncated: boolean;
}

export interface FetchPageOptions {
  fetchImpl?: typeof fetch;
  /** 默认 15_000 */
  timeoutMs?: number;
  /** 默认 8_000 */
  maxChars?: number;
}

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) || null : null;
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return { title, text };
}

export async function fetchPageText(url: string, opts: FetchPageOptions = {}): Promise<PageText> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("仅支持 http/https 链接");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 链接");
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let html: string;
  try {
    const res = await fetchImpl(parsed.href, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 AutoCrew/1.0", accept: "text/html,application/xhtml+xml,*/*" },
    });
    checkFetchResponse(res, `read_url ${parsed.hostname}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const { title, text } = htmlToText(html);
  const maxChars = opts.maxChars ?? 8_000;
  const truncated = text.length > maxChars;
  return { title, text: truncated ? text.slice(0, maxChars) : text, truncated };
}
