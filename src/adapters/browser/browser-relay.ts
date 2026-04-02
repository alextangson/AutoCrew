/**
 * Browser Relay Adapter — uses OpenClaw Gateway + Chrome Relay
 *
 * Controls the user's real browser via OpenClaw Gateway HTTP API.
 * Falls back to the legacy CDP proxy adapter if Gateway is unavailable.
 */
import { GatewayClient } from "./gateway-client.js";
import { browserCdpAdapter } from "./browser-cdp.js";
import type {
  BrowserAdapter,
  BrowserPlatform,
  BrowserResearchQuery,
  BrowserSessionStatus,
  ResearchItem,
} from "./types.js";

function buildPlatformUrl(platform: BrowserPlatform): string {
  const urls: Record<BrowserPlatform, string> = {
    xiaohongshu: "https://www.xiaohongshu.com/",
    douyin: "https://www.douyin.com/",
    wechat_mp: "https://mp.weixin.qq.com/",
    wechat_video: "https://channels.weixin.qq.com/platform/",
    bilibili: "https://www.bilibili.com/",
  };
  return urls[platform] || urls.xiaohongshu;
}

function buildSearchUrl(platform: BrowserPlatform, keyword: string): string {
  const encoded = encodeURIComponent(keyword);
  const urls: Record<BrowserPlatform, string> = {
    xiaohongshu: `https://www.xiaohongshu.com/search_result?keyword=${encoded}`,
    douyin: `https://www.douyin.com/search/${encoded}?type=video`,
    bilibili: `https://search.bilibili.com/all?keyword=${encoded}`,
    wechat_mp: `https://weixin.sogou.com/weixin?type=2&query=${encoded}`,
    wechat_video: `https://channels.weixin.qq.com/platform/`,
  };
  return urls[platform] || urls.xiaohongshu;
}

/** JS expression to check login status via page content */
function sessionCheckExpression(platform: BrowserPlatform): string {
  return `(() => {
    const href = location.href;
    const text = (document.body?.innerText || "").slice(0, 2000);
    const checks = {
      xiaohongshu: /login|登录/.test(href) || /登录后查看更多|立即登录/.test(text),
      douyin: /login|sso\\.douyin/.test(href) || /扫码登录|手机号登录/.test(text),
      wechat_mp: /login/.test(href) || /扫码登录|微信公众平台/.test(text),
      wechat_video: /login/.test(href) || /扫码登录|视频号助手/.test(text),
      bilibili: /passport|login/.test(href) || /请先登录|登录后/.test(text),
    };
    const loggedIn = !checks[${JSON.stringify(platform)}];
    return JSON.stringify({
      href,
      title: document.title,
      loggedIn,
      textHint: text.slice(0, 200),
    });
  })()`;
}

/** JS expression to extract research results from search page */
function researchExpression(platform: BrowserPlatform, limit: number): string {
  return `(() => {
    const limit = ${limit};
    const abs = (href) => {
      try { return new URL(href, location.href).href; } catch { return href || ""; }
    };
    const dedupe = new Set();
    const push = (items, item) => {
      if (!item || !item.title) return;
      const key = item.title + "::" + (item.url || "");
      if (dedupe.has(key)) return;
      dedupe.add(key);
      items.push(item);
    };
    const text = (el) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
    const items = [];

    if (${JSON.stringify(platform)} === "xiaohongshu") {
      const cards = Array.from(document.querySelectorAll("section, .note-item, [data-index], a"));
      for (const card of cards) {
        const titleEl = card.querySelector?.("a[href*='/explore/'], a[href*='/discovery/item/'], a[href*='/note/'], .title span, .desc, .note-title") || card;
        const linkEl = card.querySelector?.("a[href*='/explore/'], a[href*='/discovery/item/'], a[href*='/note/']") || card.closest?.("a");
        const authorEl = card.querySelector?.(".author, .name");
        const title = text(titleEl);
        const url = linkEl?.href ? abs(linkEl.href) : "";
        if (title.length >= 4 && url.includes("xiaohongshu.com")) {
          push(items, { title, url, author: text(authorEl) });
        }
        if (items.length >= limit) break;
      }
    } else if (${JSON.stringify(platform)} === "douyin") {
      const cards = Array.from(document.querySelectorAll("a[href*='/video/'], [data-e2e='search-result-container'] a, .ECMy_Zdt"));
      for (const card of cards) {
        const titleEl = card.querySelector?.("span, p, h3") || card;
        const url = card.href ? abs(card.href) : abs(card.querySelector?.("a")?.href || "");
        const title = text(titleEl);
        if (title.length >= 4 && url.includes("douyin.com")) {
          push(items, { title, url });
        }
        if (items.length >= limit) break;
      }
    } else if (${JSON.stringify(platform)} === "bilibili") {
      const cards = Array.from(document.querySelectorAll("a[href*='/video/'], .bili-video-card a, .video-list-item a"));
      for (const card of cards) {
        const title = card.getAttribute?.("title") || text(card);
        const url = card.href ? abs(card.href) : "";
        if (title && url.includes("bilibili.com")) {
          push(items, { title, url });
        }
        if (items.length >= limit) break;
      }
    } else {
      const links = Array.from(document.querySelectorAll("a"));
      for (const link of links) {
        const title = text(link);
        const url = link.href ? abs(link.href) : "";
        if (title.length >= 6 && url) {
          push(items, { title, url });
        }
        if (items.length >= limit) break;
      }
    }

    return JSON.stringify(items.slice(0, limit));
  })()`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Relay Adapter ---

async function getSessionStatus(
  platform: BrowserPlatform,
  gatewayUrl?: string,
): Promise<BrowserSessionStatus> {
  const gw = new GatewayClient(gatewayUrl);
  const available = await gw.isAvailable();

  if (!available) {
    // Fallback to legacy CDP adapter
    if (browserCdpAdapter.getSessionStatus) {
      return browserCdpAdapter.getSessionStatus(platform);
    }
    return { platform, loggedIn: false, note: "Gateway unavailable, no fallback" };
  }

  try {
    // Navigate to platform homepage
    const navResult = await gw.navigate(buildPlatformUrl(platform));
    if (!navResult.ok) {
      return { platform, loggedIn: false, note: navResult.error || "navigate failed" };
    }

    await sleep(2000);

    // Evaluate login check expression
    const evalResult = await gw.evaluate(sessionCheckExpression(platform));
    if (!evalResult.ok || evalResult.value === undefined) {
      return { platform, loggedIn: false, note: evalResult.error || "eval failed" };
    }

    const parsed = typeof evalResult.value === "string"
      ? JSON.parse(evalResult.value)
      : evalResult.value;

    return {
      platform,
      loggedIn: Boolean(parsed.loggedIn),
      note: parsed.href || parsed.title || "session checked via relay",
    };
  } catch (error: any) {
    return { platform, loggedIn: false, note: error?.message || "relay session check failed" };
  }
}

async function research(
  query: BrowserResearchQuery,
  gatewayUrl?: string,
): Promise<ResearchItem[]> {
  const gw = new GatewayClient(gatewayUrl);
  const available = await gw.isAvailable();

  if (!available) {
    // Fallback to legacy CDP adapter
    return browserCdpAdapter.research(query);
  }

  try {
    // Navigate to search URL
    const navResult = await gw.navigate(buildSearchUrl(query.platform, query.keyword));
    if (!navResult.ok) return [];

    await sleep(3000); // Wait for search results to load

    // Extract results via JS evaluation
    const evalResult = await gw.evaluate(researchExpression(query.platform, query.limit || 5));
    if (!evalResult.ok || evalResult.value === undefined) return [];

    const parsed = typeof evalResult.value === "string"
      ? JSON.parse(evalResult.value as string)
      : evalResult.value;

    if (!Array.isArray(parsed)) return [];

    return parsed.map((item: any) => ({
      title: String(item.title || "").trim(),
      summary: item.author
        ? `参考账号：${String(item.author).trim()}`
        : "来自 Chrome Relay 登录态搜索结果",
      url: item.url ? String(item.url) : undefined,
      author: item.author ? String(item.author) : undefined,
      platform: query.platform,
      source: "browser_relay" as const,
    }));
  } catch {
    // Fallback to legacy CDP adapter
    return browserCdpAdapter.research(query);
  }
}

export function createBrowserRelayAdapter(gatewayUrl?: string): BrowserAdapter {
  return {
    id: "browser_relay",
    description:
      "Browser adapter using OpenClaw Gateway + Chrome Relay. Controls the user's real Chrome browser with existing login sessions.",
    getSessionStatus: (platform) => getSessionStatus(platform, gatewayUrl),
    research: (query) => research(query, gatewayUrl),
  };
}

/** Default instance using env/default gateway URL */
export const browserRelayAdapter = createBrowserRelayAdapter();
