import type {
  BrowserAdapter,
  BrowserPlatform,
  BrowserResearchQuery,
  BrowserSessionStatus,
  ResearchItem,
} from "./types.js";

const DEFAULT_PROXY_URL = process.env.AUTOCREW_CDP_PROXY_URL || "http://127.0.0.1:3456";

type ProxyEvalResult = {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPlatformUrl(platform: BrowserPlatform): string {
  switch (platform) {
    case "xiaohongshu":
      return "https://www.xiaohongshu.com/";
    case "douyin":
      return "https://www.douyin.com/";
    case "wechat_mp":
      return "https://mp.weixin.qq.com/";
    case "wechat_video":
      return "https://channels.weixin.qq.com/platform/";
    case "bilibili":
      return "https://www.bilibili.com/";
    default:
      return "https://www.xiaohongshu.com/";
  }
}

function buildSearchUrl(platform: BrowserPlatform, keyword: string): string {
  const encoded = encodeURIComponent(keyword);
  switch (platform) {
    case "xiaohongshu":
      return `https://www.xiaohongshu.com/search_result?keyword=${encoded}`;
    case "douyin":
      return `https://www.douyin.com/search/${encoded}?type=video`;
    case "bilibili":
      return `https://search.bilibili.com/all?keyword=${encoded}`;
    case "wechat_mp":
      return `https://weixin.sogou.com/weixin?type=2&query=${encoded}`;
    case "wechat_video":
      return `https://channels.weixin.qq.com/platform/`;
    default:
      return `https://www.xiaohongshu.com/search_result?keyword=${encoded}`;
  }
}

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

class WebAccessProxyClient {
  constructor(private readonly baseUrl: string) {}

  async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async open(url: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/new?url=${encodeURIComponent(url)}`);
    if (!response.ok) {
      throw new Error(`Failed to open tab for ${url}`);
    }
    const data = await response.json();
    return data.id || data.targetId || data.tabId;
  }

  async eval(tabId: string, expression: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/eval/${encodeURIComponent(tabId)}`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: expression,
    });
    if (!response.ok) {
      throw new Error(`Failed to eval expression for tab ${tabId}`);
    }
    const data = (await response.json()) as ProxyEvalResult;
    if (data.exceptionDetails) {
      throw new Error(`Browser eval failed for tab ${tabId}`);
    }
    return data.result?.value;
  }

  async close(tabId: string): Promise<void> {
    await fetch(`${this.baseUrl}/close/${encodeURIComponent(tabId)}`);
  }
}

async function withTab<T>(url: string, fn: (client: WebAccessProxyClient, tabId: string) => Promise<T>): Promise<T> {
  const client = new WebAccessProxyClient(DEFAULT_PROXY_URL);
  const tabId = await client.open(url);
  try {
    await sleep(2500);
    return await fn(client, tabId);
  } finally {
    await client.close(tabId).catch(() => undefined);
  }
}

async function getSessionStatus(platform: BrowserPlatform): Promise<BrowserSessionStatus> {
  const client = new WebAccessProxyClient(DEFAULT_PROXY_URL);
  const reachable = await client.isReachable();
  if (!reachable) {
    return {
      platform,
      loggedIn: false,
      note: `CDP proxy unreachable at ${DEFAULT_PROXY_URL}`,
    };
  }

  try {
    return await withTab(buildPlatformUrl(platform), async (tabClient, tabId) => {
      const raw = await tabClient.eval(tabId, sessionCheckExpression(platform));
      const parsed = typeof raw === "string" ? JSON.parse(raw) : {};
      return {
        platform,
        loggedIn: Boolean(parsed.loggedIn),
        note: parsed.href || parsed.title || "session checked",
      };
    });
  } catch (error: any) {
    return {
      platform,
      loggedIn: false,
      note: error?.message || "session check failed",
    };
  }
}

async function research(query: BrowserResearchQuery): Promise<ResearchItem[]> {
  const client = new WebAccessProxyClient(DEFAULT_PROXY_URL);
  const reachable = await client.isReachable();
  if (!reachable) {
    return [];
  }

  try {
    return await withTab(buildSearchUrl(query.platform, query.keyword), async (tabClient, tabId) => {
      const raw = await tabClient.eval(tabId, researchExpression(query.platform, query.limit || 5));
      const parsed = typeof raw === "string" ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((item: any) => ({
        title: String(item.title || "").trim(),
        summary: item.author ? `参考账号：${String(item.author).trim()}` : "来自浏览器登录态搜索结果",
        url: item.url ? String(item.url) : undefined,
        author: item.author ? String(item.author) : undefined,
        platform: query.platform,
        source: "browser_cdp" as const,
      }));
    });
  } catch {
    return [];
  }
}

export const browserCdpAdapter: BrowserAdapter = {
  id: "browser_cdp",
  description:
    "Browser-first adapter using a web-access style CDP proxy. Reads the user's own logged-in browser session through HTTP endpoints.",
  getSessionStatus,
  research,
};
