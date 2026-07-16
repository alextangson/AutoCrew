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
import { loadProfile } from "../profile/creator-profile.js";
import { loadWechatMpConfig } from "../publish/wechat-config.js";
import sourcesJson from "../../data/topic-sources.json";

export interface RadarItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string;
  /** 源摘要(RSS description 去标签截断)——灵感卡"看得出是什么"的原料(V5.4c) */
  description?: string;
  /** 源侧真实热度（stars/points 等），后续评分时可作为时效/热度证据。 */
  heat?: number;
}

export interface TopicCache {
  fetchedAt: string;
  items: RadarItem[];
}

/**
 * 统一情报源（IA v4.2 工程线:单一 SourceAdapter 抽象,国内 RSS 与海外 API 同一张注册表）。
 * kind=rss 需要 config.url;海外 kind 走 research/sources 的 adapter,config.keyword
 * 可选（缺省从定位派生 ASCII 词,如「AI 技术」→ "AI"）。enabled=false 的源不参与扫描。
 */
export type RadarSourceKind = "rss" | "hackernews" | "producthunt" | "github" | "arxiv" | "huggingface" | "x";
export const OVERSEAS_KINDS: RadarSourceKind[] = ["hackernews", "producthunt", "github", "arxiv", "huggingface", "x"];

export interface RadarSource {
  id: string;
  kind: RadarSourceKind;
  name: string;
  enabled: boolean;
  config: { url?: string; keyword?: string };
}

/** v1 形状（type:"rss"+url 顶层）——用户文件与老内置格式,读取时自动升格 */
interface RadarSourceV1 {
  id: string;
  name: string;
  type: string;
  url: string;
  tracks?: string[];
}

const CACHE_FILE = "topic-radar.json";
const SOURCES_FILE = "radar-sources.json";
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
    // 摘要:去 HTML 标签、压空白、截 240——灵感库里"看得出这个灵感是什么"靠它
    const rawDesc = field(m[0], "description");
    const description = rawDesc
      ? rawDesc.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240)
      : "";
    items.push({
      title,
      link,
      publishedAt: isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString(),
      ...(description ? { description } : {}),
    });
  }
  return items;
}

export interface ScoredRadarItem {
  item: RadarItem;
  score: number;
  /** 命中的定位 token（入库理由的原料；空 = 纯新鲜度上位，未命中定位） */
  matchedTokens: string[];
}

// 热度进排序:热度是「同源里被讨论最多的那条」这个相对概念,源间不可比(GitHub stars
// 上千、HN points 上百),所以按源内 log 归一到 [0,1] 再加权。上限 3 分——与一次定位
// 命中同量级,能把爆款顶到前面,但不盖过内容相关性(否则热但不相关的会霸榜)。
const HEAT_WEIGHT = 3;

/** 各源内部把 heat 做 log 归一,返回 item→[0,1] 的热度分位函数（无热度/源内独一条 → 中性档）。 */
function buildHeatNorm(items: RadarItem[]): (item: RadarItem) => number {
  const range = new Map<string, { min: number; max: number }>();
  for (const it of items) {
    if (typeof it.heat !== "number" || it.heat <= 0) continue;
    const v = Math.log1p(it.heat);
    const cur = range.get(it.source);
    if (!cur) range.set(it.source, { min: v, max: v });
    else {
      cur.min = Math.min(cur.min, v);
      cur.max = Math.max(cur.max, v);
    }
  }
  return (item) => {
    if (typeof item.heat !== "number" || item.heat <= 0) return 0;
    const r = range.get(item.source);
    if (!r || r.max === r.min) return 0.5; // 源内独一条,无从相对比较 → 中性半档:给信号但不霸榜
    return (Math.log1p(item.heat) - r.min) / (r.max - r.min);
  };
}

/** 确定性候选排序（带评分明细）：定位 token 命中 ×3 + 新鲜度（<24h +2, <72h +1）+ 源内热度（≤3） */
export function rankCandidatesScored(items: RadarItem[], industry: string, limit: number): ScoredRadarItem[] {
  const baseTokens = industry.split(/[/\s,，、|]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  // 中英混写定位（如 "AI技术博主"）：ASCII 串单独成 token，否则永远匹配不上英文标题里的 "AI"/"GPT"
  const asciiTokens = (industry.match(/[A-Za-z0-9]{2,}/g) ?? []);
  const tokens = [...new Set([...baseTokens, ...asciiTokens])];
  const now = Date.now();
  const heatNorm = buildHeatNorm(items);
  const scored = items.map((item) => {
    let score = 0;
    const matchedTokens: string[] = [];
    const haystack = `${item.title} ${item.description ?? ""}`;
    for (const tok of tokens) {
      const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // ASCII 定位词按词边界匹配，避免把 Airbnb 里的 "Ai" 误判成 AI 命中。
      const matched = /^[A-Za-z0-9]+$/.test(tok)
        ? new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(haystack) ||
          // 全大写缩写允许嵌在产品名中（OpenAI/AIGC），但必须大小写精确，Airbnb 的 Ai 不算。
          (tok === tok.toUpperCase() && haystack.includes(tok))
        : haystack.toLowerCase().includes(tok.toLowerCase());
      if (matched) {
        score += 3;
        matchedTokens.push(tok);
      }
    }
    const ageH = (now - new Date(item.publishedAt).getTime()) / 3600_000;
    if (ageH < 24) score += 2;
    else if (ageH < 72) score += 1;
    score += heatNorm(item) * HEAT_WEIGHT;
    return { item, score, matchedTokens };
  });
  scored.sort(
    (a, b) => b.score - a.score ||
      new Date(b.item.publishedAt).getTime() - new Date(a.item.publishedAt).getTime(),
  );
  return scored.slice(0, limit);
}

export function rankCandidates(items: RadarItem[], industry: string, limit: number): RadarItem[] {
  return rankCandidatesScored(items, industry, limit).map((s) => s.item);
}

function cachePath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), CACHE_FILE);
}

// ── 用户级源配置（IA v4.2 §A1「源清单可配置」）────────────────────────────────
// <dataDir>/radar-sources.json 存在即完全接管（含删除内置源的自由）;不存在用内置默认。

function sourcesPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), SOURCES_FILE);
}

/** v1 条目（type+url 顶层）→ v2;已是 v2 原样回。名称校验留给 saveRadarSources 的显式分支 */
function upgradeSource(raw: Record<string, unknown>): RadarSource | null {
  if (typeof raw.kind === "string") {
    const s = raw as unknown as RadarSource;
    return { id: s.id || "", kind: s.kind, name: String(s.name ?? ""), enabled: s.enabled !== false, config: s.config ?? {} };
  }
  const v1 = raw as unknown as RadarSourceV1;
  if (typeof v1.url !== "string") return null;
  return { id: v1.id || "", kind: "rss", name: String(v1.name ?? ""), enabled: true, config: { url: v1.url } };
}

export async function loadRadarSources(dataDir?: string): Promise<RadarSource[]> {
  try {
    const raw = JSON.parse(await fs.readFile(sourcesPath(dataDir), "utf-8")) as { sources?: Array<Record<string, unknown>> };
    if (Array.isArray(raw.sources)) {
      return raw.sources.map(upgradeSource).filter((s): s is RadarSource => s !== null);
    }
  } catch { /* 无用户配置 → 内置 */ }
  return ((sourcesJson as { sources: Array<Record<string, unknown>> }).sources)
    .map(upgradeSource)
    .filter((s): s is RadarSource => s !== null);
}

/** 校验并保存用户源清单（落盘恒为 v2）。校验失败抛错（边界:用户输入）。 */
export async function saveRadarSources(sources: RadarSource[], dataDir?: string): Promise<RadarSource[]> {
  const clean: RadarSource[] = [];
  const seenKey = new Set<string>();
  for (const raw of sources) {
    const upgraded = upgradeSource(raw as unknown as Record<string, unknown>);
    if (!upgraded) throw new Error("源条目缺少必要字段（name/kind 或 url）");
    const name = upgraded.name.trim();
    if (!name) throw new Error("源名称不能为空");
    if (upgraded.kind === "rss") {
      const url = String(upgraded.config.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error(`「${name}」的 RSS URL 必须以 http(s):// 开头`);
      upgraded.config.url = url;
    } else if (!OVERSEAS_KINDS.includes(upgraded.kind)) {
      throw new Error(`「${name}」的类型未知：${upgraded.kind}`);
    }
    const key = upgraded.kind === "rss" ? `rss:${upgraded.config.url}` : upgraded.kind;
    if (seenKey.has(key)) continue; // 同 URL / 同海外源去重
    seenKey.add(key);
    const id = upgraded.id && upgraded.id.trim() ? upgraded.id.trim() : `src-${Date.now()}-${clean.length}`;
    clean.push({ ...upgraded, id, name });
  }
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(sourcesPath(dataDir), JSON.stringify({ version: 2, sources: clean }, null, 2) + "\n", "utf-8");
  return clean;
}

export async function loadTopicCache(dataDir?: string): Promise<TopicCache | null> {
  try {
    return JSON.parse(await fs.readFile(cachePath(dataDir), "utf-8")) as TopicCache;
  } catch {
    return null;
  }
}

/** 海外源的检索词：显式 config.keyword > 定位里的 ASCII 词（「AI 技术」→ "AI"）> 无（跳过并报失败） */
function overseasKeyword(src: RadarSource, industry: string): string {
  const explicit = String(src.config.keyword ?? "").trim();
  if (explicit) return explicit;
  const ascii = industry.match(/[A-Za-z0-9][A-Za-z0-9 .-]{1,30}/g);
  return ascii ? ascii[0].trim() : "";
}

export async function refreshTopicRadar(
  dataDir?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  deps?: {
    overseasFetch?: (
      kind: string,
      keyword: string,
      limit: number,
    ) => Promise<Array<{ title: string; url: string; summary?: string; heat?: number }>>;
  },
): Promise<{ ok: boolean; itemCount: number; failedSources: string[] }> {
  const sources = (await loadRadarSources(dataDir)).filter((s) => s.enabled);
  if (sources.length === 0) return { ok: false, itemCount: 0, failedSources: [] };

  let industry = "";
  try {
    industry = (await loadProfile(dataDir))?.industry ?? "";
  } catch { /* 无定位 → 海外源需要显式 keyword */ }

  // X 源的 twitterapi.io key(自带 key,存 publish.json)。无 key 时 X 源会抛错进 failedSources。
  const xApiKey = (await loadWechatMpConfig(dataDir).catch(() => ({}) as { xApiKey?: string })).xApiKey;

  const overseasFetch =
    deps?.overseasFetch ??
    // 单源直调 registry(不经 fetchFromSources 的吞异常隔离):X 配错 key 时错误上抛 → failedSources,
    // 不静默返回空(§6)。HN/GitHub 等自身出错即返回 [],直调行为一致。
    (async (kind: string, keyword: string, limit: number) => {
      const { SOURCE_REGISTRY } = await import("../research/sources/registry.js");
      const fetcher = SOURCE_REGISTRY[kind];
      if (!fetcher) return [];
      return fetcher(keyword, limit, { xApiKey });
    });

  const items: RadarItem[] = [];
  const failedSources: string[] = [];
  const scannedAt = new Date().toISOString();

  await Promise.all(
    sources.map(async (src) => {
      try {
        if (src.kind === "rss") {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          try {
            const res = await fetchImpl(src.config.url!, {
              signal: controller.signal,
              headers: { "user-agent": "Mozilla/5.0 AutoCrew/1.0" },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            for (const item of parseRssItems(await res.text())) {
              items.push({ ...item, source: src.name });
            }
          } finally {
            clearTimeout(timer);
          }
        } else {
          // X 走关注清单模式,不靠关键词;其余海外源是搜索型,必须有检索词
          const keyword = overseasKeyword(src, industry);
          if (!keyword && src.kind !== "x") throw new Error("no keyword");
          for (const it of await overseasFetch(src.kind, keyword, 10)) {
            items.push({
              title: it.title,
              link: it.url,
              source: src.name,
              publishedAt: scannedAt,
              ...(it.summary ? { description: it.summary } : {}),
              ...(typeof it.heat === "number" ? { heat: it.heat } : {}),
            });
          }
        }
      } catch {
        failedSources.push(src.name); // 单源失败不拖垮整体——禁止静默返回空（§6），失败名单上报
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

/**
 * TTL 门刷新:缓存仍新鲜(6h 内)直接跳过,不打任何源。
 * 给「app 启动」「再找一批」这类自动/半自动触发用——X 等付费源按请求计费,无条件全量扫
 * 是白烧钱(重启一次烧一轮)。「手动扫一轮」是用户明确意图,仍走无条件 refreshTopicRadar。
 */
export async function refreshTopicRadarIfStale(
  dataDir?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  deps?: Parameters<typeof refreshTopicRadar>[2],
): Promise<{ ok: boolean; itemCount: number; failedSources: string[]; skippedFresh: boolean }> {
  const cache = await loadTopicCache(dataDir);
  if (cache && Date.now() - new Date(cache.fetchedAt).getTime() <= CACHE_TTL_MS) {
    return { ok: true, itemCount: cache.items.length, failedSources: [], skippedFresh: true };
  }
  return { ...(await refreshTopicRadar(dataDir, fetchImpl, deps)), skippedFresh: false };
}

/** 首屏只读：仅读缓存并排序，绝不触发网络刷新（缓存空→[]）。getTopicCandidates 的同步姊妹。 */
export async function getCachedTopicCandidates(
  industry: string,
  dataDir?: string,
  limit = 10,
): Promise<RadarItem[]> {
  const cache = await loadTopicCache(dataDir);
  if (!cache) return [];
  return rankCandidates(cache.items, industry, limit);
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
