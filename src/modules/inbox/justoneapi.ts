/**
 * 抖音解析器 · justoneapi（灵感收件箱 spec §3.2 抖音行，V1.1）。
 *
 * 两个端点串起来才拿得到一条视频：
 *   v.douyin.com 短链 → `share-url-transfer/v1` 换标准链 → 抠 videoId
 *   videoId → `get-video-detail/v2` 取详情（响应是抖音原始结构，我们只挑用得上的字段）
 *
 * 四条纪律：
 * 1. **直连，不走 settings.proxyUrl**——那个代理是 Telegram 通道的（§3.2 明确「twitterapi.io /
 *    justoneapi 默认直连」），把它套到这里等于给 API 调用加一条没验证过的链路。
 * 2. **超时 60s**：官方建议 120s，但 worker 是串行的（一条卡住 = 整条队列卡住），实测 ~2s
 *    返回，60s 已是 30 倍余量。这是与官方建议的**显式偏差**，不是漏看文档。
 * 3. **业务码 → 三态**（§3.1 rejected/blocked/failed 不共用一个词）：映射表见 `CODE_OUTCOME`，
 *    是验收项。判不出的码一律偏 failed（可见地重试几次），不判死。
 * 4. **短链解析出的地址必须是抖音域**——上游返回什么就跟到什么等于开放跳转，
 *    非抖音域一律 rejected。
 *
 * token 走 query 参数（vendor 契约如此），所以本模块的任何错误消息都只带端点路径与业务码，
 * 绝不回显请求 URL。
 */
import { canonicalizeUrl } from "./url-canonical.js";

export const JUSTONEAPI_BASE = "https://api.justoneapi.com";
export const JUSTONEAPI_TIMEOUT_MS = 60_000;

const SHARE_URL_TRANSFER = "/api/douyin/share-url-transfer/v1";
const GET_VIDEO_DETAIL = "/api/douyin/get-video-detail/v2";

// ─── 契约类型 ────────────────────────────────────────────────────────────────

/** 抓取时点的公开数据。play_count 不收：抖音公开面恒 0（spec §3.2 实测） */
export interface DouyinStats {
  likes?: number;
  comments?: number;
  collects?: number;
  shares?: number;
}

export interface DouyinVideoContent {
  videoId: string;
  /** 幂等键，与 canonicalizeUrl 同形态：https://www.douyin.com/video/<id> */
  canonicalUrl: string;
  desc: string;
  authorNickname?: string;
  /** unix 秒 */
  createTime?: number;
  durationMs?: number;
  stats: DouyinStats;
}

/** 解析器出口：两个端点各一个方法，管线按域名形态决定调哪个 */
export interface JustoneapiClient {
  /** v.douyin.com 短链 → 已校验域名的标准抖音链接 */
  resolveShareUrl(shareUrl: string): Promise<string>;
  fetchVideoDetail(videoId: string): Promise<DouyinVideoContent>;
}

export interface JustoneapiOptions {
  /** 测试注入假服务器 */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// ─── 错误与三态映射（验收项） ────────────────────────────────────────────────

/** 调用方（digest-pipeline.classifyError）据此落 blocked / failed / rejected */
export type JustoneapiOutcome = "blocked" | "failed" | "rejected";

export class JustoneapiError extends Error {
  readonly name = "JustoneapiError";
  constructor(
    readonly errorCode: string,
    readonly outcome: JustoneapiOutcome,
    message: string,
  ) {
    super(message);
  }
}

/** 业务码 → 三态 + 人话原因。表里没有的码走 `failed`（判错方向偏可重试） */
const CODE_OUTCOME: Record<number, { outcome: JustoneapiOutcome; reason: string }> = {
  100: { outcome: "blocked", reason: "token 无效或已失效" },
  301: { outcome: "failed", reason: "上游查询失败" },
  302: { outcome: "failed", reason: "触发限流" },
  303: { outcome: "failed", reason: "触发限流" },
  400: { outcome: "rejected", reason: "请求参数不合法（这条链接上游不认）" },
  500: { outcome: "failed", reason: "上游服务异常" },
  600: { outcome: "blocked", reason: "该接口无调用权限" },
  601: { outcome: "blocked", reason: "余额 / 额度不足" },
  602: { outcome: "blocked", reason: "余额 / 额度不足" },
};

/** 导出供管线与测试消费：0 = 成功，其余落三态之一 */
export function classifyJustoneapiCode(code: number): "ok" | JustoneapiOutcome {
  if (code === 0) return "ok";
  return CODE_OUTCOME[code]?.outcome ?? "failed";
}

// ─── 域名判定（管线路由与开放跳转防护共用） ──────────────────────────────────

const DOUYIN_HOSTS = ["douyin.com", "iesdouyin.com"];
const SHARE_HOST = "v.douyin.com";
const NUMERIC_ID = /^\d+$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isDouyinHost(host: string): boolean {
  return DOUYIN_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** 管线域名路由入口：命中即不走通用抓取（§3.2） */
export function isDouyinUrl(url: string): boolean {
  const host = hostOf(url);
  return host !== null && isDouyinHost(host);
}

/** 短链形态：只有 v.douyin.com 需要先换标准链 */
export function isDouyinShareLink(url: string): boolean {
  return hostOf(url) === SHARE_HOST;
}

export function douyinCanonicalUrl(videoId: string): string {
  return `https://www.douyin.com/video/${videoId}`;
}

/**
 * 标准链 → videoId。主路径交给 canonicalizeUrl（它已认 /video/<id> 与 modal_id 两种形态），
 * iesdouyin 分享页（/share/video/<id>/）不在它的域名清单里，这里补一条。
 */
export function extractDouyinVideoId(url: string): string | null {
  const canonical = canonicalizeUrl(url);
  const fromCanonical = /^https:\/\/www\.douyin\.com\/video\/(\d+)$/.exec(canonical);
  if (fromCanonical) return fromCanonical[1];
  let u: URL;
  try {
    u = new URL(canonical);
  } catch {
    return null;
  }
  if (!isDouyinHost(u.hostname.toLowerCase())) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  const at = segs.lastIndexOf("video");
  const id = at >= 0 ? segs[at + 1] : undefined;
  return id && NUMERIC_ID.test(id) ? id : null;
}

// ─── 响应解析（抖音原始结构，字段只挑用得上的） ──────────────────────────────

/** 视频对象的两种键名都见过（实测 aweme_info；文档另有 aweme_detail），且藏在嵌套里 */
const VIDEO_KEYS = ["aweme_detail", "aweme_info"];
/** 短链换标准链的响应键名未定死，先按这些常见键找，找不到再全树扫第一个 http 串 */
const URL_KEYS = ["url", "shareUrl", "share_url", "redirectUrl", "redirect_url", "location", "originalUrl"];
const MAX_DEPTH = 8;

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** 丢掉 undefined 的键：产物直接进台账与拆解卡，不该带一串空字段 */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function findVideoObject(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(node)) {
    for (const el of node) {
      const hit = findVideoObject(el, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const obj = asObject(node);
  if (!obj) return null;
  for (const key of VIDEO_KEYS) {
    const nested = asObject(obj[key]);
    if (nested) return nested;
  }
  for (const value of Object.values(obj)) {
    const hit = findVideoObject(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function findUrl(node: unknown, depth = 0): string | null {
  if (typeof node === "string") return HTTP_URL_RE.test(node.trim()) ? node.trim() : null;
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(node)) {
    for (const el of node) {
      const hit = findUrl(el, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const obj = asObject(node);
  if (!obj) return null;
  for (const key of URL_KEYS) {
    const hit = findUrl(obj[key], depth + 1);
    if (hit) return hit;
  }
  for (const value of Object.values(obj)) {
    const hit = findUrl(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function toVideoContent(raw: Record<string, unknown>, fallbackId: string): DouyinVideoContent {
  const author = asObject(raw.author) ?? {};
  const statistics = asObject(raw.statistics) ?? {};
  const video = asObject(raw.video) ?? {};
  const videoId = str(raw.aweme_id) || fallbackId;
  return compact({
    videoId,
    canonicalUrl: douyinCanonicalUrl(videoId),
    desc: str(raw.desc),
    authorNickname: str(author.nickname) || undefined,
    createTime: num(raw.create_time),
    durationMs: num(video.duration),
    stats: compact({
      likes: num(statistics.digg_count),
      comments: num(statistics.comment_count),
      collects: num(statistics.collect_count),
      shares: num(statistics.share_count),
    }),
  });
}

// ─── HTTP 层 ─────────────────────────────────────────────────────────────────

interface Resolved {
  token: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

const VENDOR_MSG_CHARS = 120;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function badResponse(endpoint: string, detail: string): JustoneapiError {
  return new JustoneapiError("justoneapi_bad_response", "failed", `justoneapi ${endpoint} 返回不认识的结构：${detail}`);
}

/**
 * HTTP 层非 2xx。401/403 是「凭证被拒」——等人去换 key，属 blocked；
 * 其余（含 5xx）按可重试处理。
 */
function httpError(status: number, endpoint: string): JustoneapiError {
  const blocked = status === 401 || status === 403;
  return new JustoneapiError(
    `justoneapi_http_${status}`,
    blocked ? "blocked" : "failed",
    `justoneapi ${endpoint} 返回 HTTP ${status}${blocked ? "（key 被拒）" : ""}`,
  );
}

function businessError(code: number, vendorMessage: string, endpoint: string): JustoneapiError {
  const known = CODE_OUTCOME[code];
  const reason = known?.reason ?? "未知业务码";
  const tail = vendorMessage ? ` · ${vendorMessage.slice(0, VENDOR_MSG_CHARS)}` : "";
  return new JustoneapiError(
    `justoneapi_${code}`,
    known?.outcome ?? "failed",
    `justoneapi ${endpoint} 调用被拒（code ${code}：${reason}${tail}）`,
  );
}

/** 返回 data 段。任何非 0 业务码、HTTP 错、网络错、坏 JSON 一律抛 JustoneapiError */
async function callJustoneapi(
  endpoint: string,
  params: Record<string, string>,
  cfg: Resolved,
): Promise<unknown> {
  const query = new URLSearchParams({ token: cfg.token, ...params }).toString();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, cfg.timeoutMs);

  let res: Response;
  try {
    res = await cfg.fetchImpl(`${cfg.baseUrl}${endpoint}?${query}`, { signal: controller.signal });
  } catch (err) {
    throw timedOut
      ? new JustoneapiError("justoneapi_timeout", "failed", `justoneapi ${endpoint} 超时（${cfg.timeoutMs / 1000}s）`)
      : new JustoneapiError("justoneapi_unreachable", "failed", `justoneapi ${endpoint} 请求失败：${errText(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw httpError(res.status, endpoint);
  const body = asObject(await res.json().catch(() => null));
  if (!body) throw badResponse(endpoint, "响应不是 JSON 对象");
  const code = num(body.code);
  if (code === undefined) throw badResponse(endpoint, "响应缺 code 字段");
  if (code !== 0) throw businessError(code, str(body.message), endpoint);
  return body.data;
}

// ─── 客户端 ──────────────────────────────────────────────────────────────────

export function createJustoneapiClient(token: string, opts: JustoneapiOptions = {}): JustoneapiClient {
  const cfg: Resolved = {
    token,
    baseUrl: opts.baseUrl ?? JUSTONEAPI_BASE,
    timeoutMs: opts.timeoutMs ?? JUSTONEAPI_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl ?? fetch,
  };

  return {
    async resolveShareUrl(shareUrl: string): Promise<string> {
      // 端点只认短链；标准链直接送进来会拿回 400，不如在门口说清楚
      if (!isDouyinShareLink(shareUrl)) {
        throw new JustoneapiError("douyin_not_share_link", "rejected", `短链解析只吃 ${SHARE_HOST} 链接`);
      }
      const data = await callJustoneapi(SHARE_URL_TRANSFER, { shareUrl }, cfg);
      const found = findUrl(data);
      if (!found) throw badResponse(SHARE_URL_TRANSFER, "没找到重定向后的地址");
      const host = hostOf(found);
      // 上游给什么就跟什么 = 开放跳转；非抖音域当场拒，且只回显域名不回显整串
      if (!host || !isDouyinHost(host)) {
        throw new JustoneapiError(
          "justoneapi_foreign_redirect",
          "rejected",
          `短链解析出的地址不是抖音域名（${host ?? "无法解析"}），已拒绝`,
        );
      }
      return found;
    },

    async fetchVideoDetail(videoId: string): Promise<DouyinVideoContent> {
      const data = await callJustoneapi(GET_VIDEO_DETAIL, { videoId }, cfg);
      const raw = findVideoObject(data);
      if (!raw) throw badResponse(GET_VIDEO_DETAIL, `响应里没有 ${VIDEO_KEYS.join(" / ")} 视频对象`);
      return toVideoContent(raw, videoId);
    },
  };
}
