/**
 * 网页搜索 provider 抽象（IA v5 V5.3）——侦查员的「主动搜集」能力底座。
 *
 * 配置在 <dataDir>/search.json:{ provider: "bocha"|"tavily", apiKey, baseUrl? }。
 * 博查中文优先,Tavily 英文圈;key 只住本地配置文件(红线:不入库/不进对话/不打印)。
 * 未配置时明确报错(人话),不硬爬——搜索是显性能力,不是兜底黑魔法。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";

export type SearchProviderId = "bocha" | "tavily";

export interface SearchConfig {
  provider: SearchProviderId;
  apiKey: string;
  /** 覆盖默认端点(自建代理/中转时) */
  baseUrl?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

const DEFAULT_BASE: Record<SearchProviderId, string> = {
  bocha: "https://api.bochaai.com/v1",
  tavily: "https://api.tavily.com",
};

const SEARCH_FILE = "search.json";
const TIMEOUT_MS = 15_000;

export async function loadSearchConfig(dataDir?: string): Promise<SearchConfig | null> {
  try {
    const raw = await fs.readFile(path.join(getDataDir(dataDir), SEARCH_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SearchConfig>;
    if ((parsed.provider === "bocha" || parsed.provider === "tavily") && typeof parsed.apiKey === "string" && parsed.apiKey.trim()) {
      return { provider: parsed.provider, apiKey: parsed.apiKey.trim(), ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveSearchConfig(config: SearchConfig, dataDir?: string): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, SEARCH_FILE);
  await fs.writeFile(p, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await fs.chmod(p, 0o600).catch(() => {}); // key 文件收权限,失败不阻断(非 posix 场景)
}

export async function searchAvailable(dataDir?: string): Promise<boolean> {
  return (await loadSearchConfig(dataDir)) !== null;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`搜索超时(${TIMEOUT_MS / 1000}s 无响应)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 博查 web-search:响应形如 {data:{webPages:{value:[{name,url,snippet,summary,datePublished}]}}} */
async function searchBocha(query: string, count: number, cfg: SearchConfig): Promise<WebSearchResult[]> {
  const base = (cfg.baseUrl ?? DEFAULT_BASE.bocha).replace(/\/+$/, "");
  const payload = await fetchJson(`${base}/web-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ query, count, summary: true, freshness: "noLimit" }),
  });
  const root = payload as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const webPages = data.webPages as Record<string, unknown> | undefined;
  const value = (webPages?.value ?? []) as Array<Record<string, unknown>>;
  return value
    .map((v) => ({
      title: str(v.name) || str(v.title),
      url: str(v.url),
      snippet: str(v.summary) || str(v.snippet),
      ...(str(v.datePublished) ? { publishedAt: str(v.datePublished) } : {}),
    }))
    .filter((r) => r.title && r.url);
}

/** Tavily search:响应形如 {results:[{title,url,content,published_date}]} */
async function searchTavily(query: string, count: number, cfg: SearchConfig): Promise<WebSearchResult[]> {
  const base = (cfg.baseUrl ?? DEFAULT_BASE.tavily).replace(/\/+$/, "");
  const payload = await fetchJson(`${base}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: count, search_depth: "basic" }),
  });
  const results = ((payload as Record<string, unknown>).results ?? []) as Array<Record<string, unknown>>;
  return results
    .map((v) => ({
      title: str(v.title),
      url: str(v.url),
      snippet: str(v.content),
      ...(str(v.published_date) ? { publishedAt: str(v.published_date) } : {}),
    }))
    .filter((r) => r.title && r.url);
}

/**
 * 统一搜索入口。config 未配置时抛人话错误(调用方原样透给用户:去设置里配)。
 */
export async function searchWeb(
  query: string,
  opts?: { count?: number; dataDir?: string; config?: SearchConfig },
): Promise<WebSearchResult[]> {
  const cfg = opts?.config ?? (await loadSearchConfig(opts?.dataDir));
  if (!cfg) {
    throw new Error("搜索能力未配置:在「设置 → 搜索 API」填入博查或 Tavily 的 key(配置存本地 search.json)");
  }
  const count = Math.max(1, Math.min(opts?.count ?? 8, 20));
  const q = query.trim();
  if (!q) throw new Error("搜索词不能为空");
  return cfg.provider === "bocha" ? searchBocha(q, count, cfg) : searchTavily(q, count, cfg);
}
