/**
 * SSRF 加固的重定向跟随骨架 —— 收件箱抓网页（`modules/inbox/fetch-external`）与深调研
 * 下载图片（`modules/research/fetch-image`）共用这一条守卫链：
 * 协议白名单 → 每跳 SSRF 校验（DNS 解析后逐个 IP 判段）→ 手动跟随 ≤N 跳。
 *
 * 抽出来的理由只有一个：**防护逻辑只该有一份实现**。两个调用方各抄一遍同一条链，
 * 早晚有一边漏改（新增网段、修 IPv6 折回规则），而漏的那一边不会有任何症状。
 *
 * 骨架**不定义错误类型**：各调用方保留自己的 Error 子类（errorCode 命名对齐），
 * 通过 `makeError` 工厂注入——既有的 `instanceof` 断言与错误码契约因此零变化。
 *
 * 响应体的读取与裁决（Content-Type 白名单、字节封顶、格式判定）**不在骨架里**：
 * 网页要 text/html + 抽正文，图片要 magic bytes + 像素尺寸，硬凑一个抽象两边都别扭。
 * 超时同理——AbortController 归调用方，骨架只收 signal。
 *
 * 残余风险（继承自收件箱 spec §3.2，显式接受）：DNS rebinding TOCTOU —— 校验用的解析
 * 与 fetch 实际连接时的解析是两次独立解析，两次之间 DNS 可被改写指向内网。不做
 * connect-by-IP（会破坏 TLS SNI / 证书校验与后续 undici 代理链路）。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

/** 骨架能产出的错误码全集；调用方的码集是它的超集（各自还有响应体侧的码） */
export type GuardErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "ssrf_blocked"
  | "too_many_redirects"
  | "fetch_failed";

/** 调用方注入的错误构造器：骨架只给码与文案，错误类型归调用方 */
export type GuardErrorFactory = (code: GuardErrorCode, message: string) => Error;

/** hostname → 地址列表；仅测试注入（生产用 node:dns lookup）。 */
export type LookupFn = (hostname: string) => Promise<string[]>;

/** 仅测试注入：替换真实 fetch（模拟传输层故障）。生产路径不传。 */
export type FetchImpl = typeof globalThis.fetch;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const BLOCKED_ADDRESSES = new net.BlockList();
// IPv4：环回、私网三段、链路本地（含 169.254.169.254 云元数据）、"本网络" 0.0.0.0/8
BLOCKED_ADDRESSES.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_ADDRESSES.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_ADDRESSES.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_ADDRESSES.addSubnet("192.168.0.0", 16, "ipv4");
// IPv6：::/96 一网打尽 ::（未指定）、::1（环回）与已废弃的 IPv4-compatible 形态（::127.0.0.1）
BLOCKED_ADDRESSES.addSubnet("::", 96, "ipv6");
BLOCKED_ADDRESSES.addSubnet("fc00::", 7, "ipv6"); // unique local
BLOCKED_ADDRESSES.addSubnet("fe80::", 10, "ipv6"); // link local
// IPv4-mapped（::ffff:a.b.c.d / ::ffff:7f00:1）由 BlockList 自动折回 IPv4 规则校验

/**
 * 地址是否落在禁止访问的网段。
 * 解析不出来的字符串一律判为受阻（fail closed）——守卫宁可误杀不可漏放。
 */
export function isBlockedAddress(address: string): boolean {
  const bare = address.split("%")[0].replace(/^\[|\]$/g, "").trim();
  const family = net.isIP(bare);
  if (family === 0) return true;
  return BLOCKED_ADDRESSES.check(bare, family === 4 ? "ipv4" : "ipv6");
}

export const defaultLookup: LookupFn = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true, verbatim: true });
  return entries.map((e) => e.address);
};

/** 解析成 http(s) URL，其余协议一律拒（重定向的 Location 也走这里） */
export function parseHttpUrl(raw: string, makeError: GuardErrorFactory, base?: URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw, base);
  } catch {
    throw makeError("invalid_url", `无法解析的链接：${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw makeError("unsupported_protocol", `仅支持 http/https 链接：${parsed.protocol}`);
  }
  return parsed;
}

/** 每一跳都要过这道门：hostname 是 IP 直接判段，否则解析后任一地址命中即拒。 */
export async function assertHostAllowed(
  url: URL,
  lookup: LookupFn,
  makeError: GuardErrorFactory,
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw makeError("ssrf_blocked", `目标地址属环回/私网/链路本地，已拒绝：${host}`);
    }
    return;
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    throw makeError("fetch_failed", `域名解析失败：${host}（${String(err)}）`);
  }
  if (addresses.length === 0) {
    throw makeError("fetch_failed", `域名无解析结果：${host}`);
  }
  const blocked = addresses.find(isBlockedAddress);
  if (blocked !== undefined) {
    throw makeError("ssrf_blocked", `${host} 解析到受限地址，已拒绝：${blocked}`);
  }
}

export interface GuardedFetchOptions {
  url: string;
  /** 重定向上限（跳数），超出即 too_many_redirects */
  maxRedirects: number;
  /** 全流程超时归调用方：骨架只把 signal 透给 fetch */
  signal: AbortSignal;
  headers: Record<string, string>;
  makeError: GuardErrorFactory;
  lookup?: LookupFn;
  fetchImpl?: FetchImpl;
}

export interface GuardedResponse {
  /** 最终跳的响应，**体未读**——读法与裁决归调用方 */
  res: Response;
  /** 跟随全部重定向后的最终 URL（相对 Location 已解析） */
  finalUrl: URL;
}

/**
 * 手动跟随重定向，**每跳都重新过 SSRF 门**（首跳干净、次跳指内网是最常见的绕过）。
 * 中间跳的响应体逐个 cancel，不让它们挂在连接上。
 */
export async function fetchFollowingRedirects(
  opts: GuardedFetchOptions,
): Promise<GuardedResponse> {
  const { maxRedirects, signal, headers, makeError } = opts;
  const lookup = opts.lookup ?? defaultLookup;
  const doFetch = opts.fetchImpl ?? fetch;
  let current = parseHttpUrl(opts.url, makeError);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertHostAllowed(current, lookup, makeError);
    const res = await doFetch(current.href, { signal, redirect: "manual", headers });
    const location = REDIRECT_STATUS.has(res.status) ? res.headers.get("location") : null;
    if (!location) return { res, finalUrl: current };
    await res.body?.cancel().catch(() => {});
    current = parseHttpUrl(location, makeError, current);
  }
  throw makeError("too_many_redirects", `重定向超过 ${maxRedirects} 跳，已放弃`);
}
