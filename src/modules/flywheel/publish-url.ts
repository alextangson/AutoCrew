/**
 * 平台链接 → 平台作品 id（spec §5.1）。
 *
 * 两条纪律：
 * 1. **解析不出就返回 null，绝不猜**——猜错的绑定比没有绑定贵得多：数据会挂到别的稿子上，
 *    复盘从此按错的账本推结论，而且「已绑定」的自愈机制会把错误固化下来。
 * 2. **网络只在短链这一步出现**，且注入 fetch：`parsePublishUrl` 是纯函数（无 IO，随处可调），
 *    `resolveShortLink` 单独一支，超时/失败一律 null 不抛——短链解不开不该阻塞发布确认。
 */
import { normalizePlatform } from "./outcome-schema.js";

export interface ParsedPublishUrl {
  /** 由 URL 自身推出的平台（douyin / xiaohongshu / wechat_video） */
  platform: string;
  /** 抖音 item_id / xhs note_id / 视频号 objectId */
  itemId: string;
}

/** 跟随重定向的上限：3 跳还没落地就交给人，不无限跟 */
const MAX_REDIRECTS = 3;
/** 短链解析总超时（跨全部跳数共用一个预算） */
const SHORT_LINK_TIMEOUT_MS = 5000;

/** 只认 http(s)：javascript:/file: 既不是发布地址，也不该被解析成绑定依据 */
function asHttpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith("." + domain);
}

/** 短链域：本身不含作品 id，必须跟一次重定向才知道指向谁 */
const SHORT_LINK_DOMAINS = ["v.douyin.com", "xhslink.com"];

export function isShortLink(raw: string): boolean {
  const u = asHttpUrl(raw);
  return !!u && SHORT_LINK_DOMAINS.some((d) => hostMatches(u.hostname.toLowerCase(), d));
}

/** 域名 → 平台。判不出的域一律 null（宁可不认，不认错） */
function platformOfHost(host: string): string | null {
  if (hostMatches(host, "douyin.com") || hostMatches(host, "iesdouyin.com")) return "douyin";
  if (hostMatches(host, "xiaohongshu.com") || hostMatches(host, "xhslink.com")) return "xiaohongshu";
  if (hostMatches(host, "channels.weixin.qq.com")) return "wechat_video";
  return null;
}

function firstParam(u: URL, keys: string[]): string | null {
  for (const key of keys) {
    const v = u.searchParams.get(key)?.trim();
    if (v) return v;
  }
  return null;
}

/** 抖音：作品页 /video/<id>、分享页 /share/video/<id>、主页弹层 ?modal_id=、创作者后台 ?item_id= */
function douyinItemId(u: URL): string | null {
  const m = u.pathname.match(/\/(?:share\/)?(?:video|note)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return firstParam(u, ["modal_id", "item_id", "itemId", "aweme_id", "vid"]);
}

/** 小红书：/explore/<id>、/discovery/item/<id>、/user/profile/<uid>/<noteId> */
function xiaohongshuItemId(u: URL): string | null {
  const direct = u.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/);
  if (direct) return direct[1];
  const inProfile = u.pathname.match(/\/user\/profile\/[A-Za-z0-9]+\/([A-Za-z0-9]+)/);
  return inProfile ? inProfile[1] : null;
}

/**
 * 视频号：只认明写 objectId 的形态。
 * 分享链里的 `eid`/`exportkey` 是**分享令牌，不是作品 id**——抓取器产出的是 objectId，
 * 拿令牌冒充 itemId 只会造出一条永远对不上的绑定。这条腿可能缺（spec §5.1 明示），
 * 缺了就靠精确标题命中登记，等 P1b spike 抓到真实分享链形态再补。
 */
function wechatVideoItemId(u: URL): string | null {
  // 不按路径猜：/platform/post/list 这类后台页面路径长得跟作品路径一模一样，猜就是错
  return firstParam(u, ["objectId", "object_id"]);
}

/**
 * 解析平台链接。`platform` 是**过滤器**：传了它，只接受该平台的链接
 * （别的平台的 id 返回给调用方只会诱发张冠李戴的比较）；不传则由 URL 自证平台。
 * 短链（v.douyin.com / xhslink.com）本身不含 id，这里一律 null——要先 `resolveShortLink`。
 */
export function parsePublishUrl(rawUrl: string, platform?: string): ParsedPublishUrl | null {
  const u = asHttpUrl(rawUrl);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const urlPlatform = platformOfHost(host);
  if (!urlPlatform) return null;
  if (platform && normalizePlatform(platform) !== urlPlatform) return null;

  const itemId =
    urlPlatform === "douyin"
      ? douyinItemId(u)
      : urlPlatform === "xiaohongshu"
        ? xiaohongshuItemId(u)
        : wechatVideoItemId(u);
  return itemId ? { platform: urlPlatform, itemId } : null;
}

/**
 * 跟随短链重定向，返回落地 URL；失败/超时/跳数超限一律 null（不抛）。
 * 注入 fetch 便于测试；`redirect: "manual"` 自己数跳数，拿到非短链的 Location 就收工——
 * 不去实际访问作品页，少打一次平台请求。
 */
export async function resolveShortLink(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!asHttpUrl(rawUrl)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHORT_LINK_TIMEOUT_MS);
  try {
    let current = rawUrl.trim();
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      const res = await fetchImpl(current, { method: "GET", redirect: "manual", signal: controller.signal });
      const location = res.headers?.get("location");
      if (!location) return res.status >= 200 && res.status < 300 ? current : null;
      const next = asHttpUrl(new URL(location, current).toString());
      if (!next) return null;
      current = next.toString();
      if (!isShortLink(current)) return current; // 落地到真实域，不必再打一次
    }
    return null; // 3 跳还在短链里绕：不猜
  } catch {
    return null; // 超时/网络失败：短链是尽力而为，失败不阻塞任何流程
  } finally {
    clearTimeout(timer);
  }
}

/** 解析链接，短链先跟重定向再解析。网络失败 = null，调用方按「没解析出来」处理 */
export async function resolvePublishUrl(
  rawUrl: string,
  platform?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedPublishUrl | null> {
  const direct = parsePublishUrl(rawUrl, platform);
  if (direct || !isShortLink(rawUrl)) return direct;
  const landed = await resolveShortLink(rawUrl, fetchImpl);
  return landed ? parsePublishUrl(landed, platform) : null;
}
