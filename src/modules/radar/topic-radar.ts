/**
 * 选题雷达 v1（PRD §7.1 增补）— 公开热榜 RSS → 缓存落盘 → 按定位排序候选。
 * 「定期抓取」v1 = app 启动 fire-and-forget + 工具内 TTL 兜底；
 * 真调度器随 L2 定时拟稿上（PRD §4 信任阶梯）。
 * 合规：只读消费公开 RSS，不自建爬虫，不碰登录态（§6 红线）。
 * 评分裁决：本模块只做确定性排序（关键词×新鲜度）；LLM 评分由 loop 里的
 * 模型对 find_topics 返回的候选自然完成，不嵌套调用。
 *
 * JSON import: 使用仓库现状写法（resolveJsonModule:true，无 with assertion）
 * 参照 src/modules/filter/sensitive-words.ts 第 51 行。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import sourcesJson from "../../data/topic-sources.json";

export interface RadarItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
}

export interface TopicCache {
  fetchedAt: string;
  items: RadarItem[];
}

interface RadarSource {
  id: string;
  name: string;
  type: string;
  url: string;
  tracks: string[];
}

const CACHE_FILE = "topic-radar.json";
const CACHE_TTL_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 12_000;

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

function field(itemXml: string, tag: string): string {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return decodeEntities(m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim());
}

/** RSS 2.0 子集解析（零依赖正则；源不规范时安全降级为空数组） */
export function parseRssItems(xml: string): Array<Omit<RadarItem, "source">> {
  const items: Array<Omit<RadarItem, "source">> = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const title = field(m[0], "title");
    const link = field(m[0], "link");
    if (!title || !link) continue;
    const pub = field(m[0], "pubDate");
    const ts = pub ? new Date(pub) : new Date();
    items.push({ title, link, publishedAt: isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString() });
  }
  return items;
}

/** 确定性候选排序：定位 token 命中 ×3 + 新鲜度（<24h +2, <72h +1） */
export function rankCandidates(items: RadarItem[], industry: string, limit: number): RadarItem[] {
  const tokens = industry.split(/[/\s,，、|]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  const now = Date.now();
  const scored = items.map((item) => {
    let score = 0;
    for (const tok of tokens) {
      if (item.title.toLowerCase().includes(tok.toLowerCase())) score += 3;
    }
    const ageH = (now - new Date(item.publishedAt).getTime()) / 3600_000;
    if (ageH < 24) score += 2;
    else if (ageH < 72) score += 1;
    return { item, score };
  });
  scored.sort(
    (a, b) => b.score - a.score ||
      new Date(b.item.publishedAt).getTime() - new Date(a.item.publishedAt).getTime(),
  );
  return scored.slice(0, limit).map((s) => s.item);
}

function cachePath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), CACHE_FILE);
}

export async function loadTopicCache(dataDir?: string): Promise<TopicCache | null> {
  try {
    return JSON.parse(await fs.readFile(cachePath(dataDir), "utf-8")) as TopicCache;
  } catch {
    return null;
  }
}

export async function refreshTopicRadar(
  dataDir?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ ok: boolean; itemCount: number; failedSources: string[] }> {
  const sources = (sourcesJson as { sources: RadarSource[] }).sources;
  const items: RadarItem[] = [];
  const failedSources: string[] = [];

  await Promise.all(
    sources.map(async (src) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetchImpl(src.url, {
          signal: controller.signal,
          headers: { "user-agent": "Mozilla/5.0 AutoCrew/1.0" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        for (const item of parseRssItems(await res.text())) {
          items.push({ ...item, source: src.name });
        }
      } catch {
        failedSources.push(src.name); // 单源失败不拖垮整体——禁止静默返回空（§6），失败名单上报
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  if (items.length > 0) {
    const dir = getDataDir(dataDir);
    await fs.mkdir(dir, { recursive: true });
    const cache: TopicCache = { fetchedAt: new Date().toISOString(), items };
    await fs.writeFile(cachePath(dataDir), JSON.stringify(cache, null, 2) + "\n");
  }
  return { ok: items.length > 0, itemCount: items.length, failedSources };
}

/** 工具侧入口：新鲜缓存直读；缺失/过期则刷新后排序。 */
export async function getTopicCandidates(
  industry: string,
  dataDir?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  limit = 10,
): Promise<RadarItem[]> {
  let cache = await loadTopicCache(dataDir);
  const stale = !cache || Date.now() - new Date(cache.fetchedAt).getTime() > CACHE_TTL_MS;
  if (stale) {
    await refreshTopicRadar(dataDir, fetchImpl);
    cache = await loadTopicCache(dataDir);
  }
  if (!cache) return [];
  return rankCandidates(cache.items, industry, limit);
}
