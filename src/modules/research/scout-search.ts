/**
 * 侦查员主动搜集（IA v5 V5.3）——总编辑派活:按定位/画像生成搜索词 → 网页搜索 →
 * LLM 相关性过滤 → 查重 → 入灵感库。骨架与 radar-intake 同构(同一套「宁缺勿滥」
 * 纪律):雷达是被动订阅进水,侦查是主动出击,两者共用相关性评审与查重口径。
 */
import { searchWeb, loadSearchConfig } from "./search-provider.js";
import type { WebSearchResult } from "./search-provider.js";
import { judgeRelevance } from "../radar/relevance.js";
import { saveTopic, listTopics, listTrash } from "../../storage/local-store.js";
import type { Topic } from "../../storage/local-store.js";
import { loadProfile, personaSummary } from "../profile/creator-profile.js";

const SAVE_LIMIT = 5;
const RELEVANCE_THRESHOLD = 7;
const PER_QUERY_COUNT = 6;

export interface ScoutSearchResult {
  queriesUsed: string[];
  /** 搜索返回的去重候选数 */
  found: number;
  saved: Topic[];
  skippedDuplicates: number;
  /** llm=语义评审主路;none=引擎不可用,用户显式搜索意图下全量保留 */
  filter: "llm" | "none";
}

function domain(url: string): string {
  const m = url.match(/https?:\/\/([^/\s]+)/);
  return m ? m[1].replace(/^www\./, "") : "web";
}

/** 无显式搜索词时,从定位+核心画像痛点推导 2-3 个查询(确定性,零 token) */
function deriveQueries(industry: string, painPoints: string[]): string[] {
  const queries = [`${industry} 最新动态`];
  for (const pain of painPoints.slice(0, 2)) {
    queries.push(`${industry} ${pain}`);
  }
  return queries;
}

export async function scoutInspiration(
  opts: { query?: string },
  dataDir?: string,
  deps?: { searchImpl?: typeof searchWeb; judge?: typeof judgeRelevance },
): Promise<ScoutSearchResult> {
  const cfg = await loadSearchConfig(dataDir);
  if (!cfg) {
    throw new Error("搜索能力未配置:在「设置 → 搜索 API」填入博查或 Tavily 的 key,配置好后我就能主动出去搜灵感");
  }
  const profile = await loadProfile(dataDir);
  const industry = profile?.industry?.trim() ?? "";
  if (!industry) {
    throw new Error("先在校准中心填写定位——侦查员按定位搜集,没有定位就没有过滤标准");
  }

  const queries = opts.query?.trim()
    ? [opts.query.trim()]
    : deriveQueries(industry, profile?.audiencePersona?.core?.painPoints ?? []);

  const search = deps?.searchImpl ?? searchWeb;
  const seen = new Set<string>();
  const candidates: WebSearchResult[] = [];
  const errors: string[] = [];
  for (const q of queries) {
    try {
      for (const r of await search(q, { count: PER_QUERY_COUNT, dataDir, config: cfg })) {
        if (seen.has(r.url) || seen.has(r.title)) continue;
        seen.add(r.url);
        seen.add(r.title);
        candidates.push(r);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (candidates.length === 0) {
    if (errors.length > 0) throw new Error(`搜索失败:${errors[0]}`);
    return { queriesUsed: queries, found: 0, saved: [], skippedDuplicates: 0, filter: "llm" };
  }

  // 相关性评审(与雷达同口径);引擎不可用时:这是用户显式动作,不静默丢弃 → 全量保留并注明
  const judge = deps?.judge ?? judgeRelevance;
  const audience = personaSummary(profile?.audiencePersona);
  const verdicts = await judge(
    industry,
    audience,
    candidates.map((c) => ({ title: c.title, source: domain(c.url) })),
    dataDir,
  );
  let qualified: Array<{ c: WebSearchResult; reason: string }>;
  let filter: ScoutSearchResult["filter"];
  if (verdicts) {
    filter = "llm";
    qualified = verdicts
      .filter((v) => v.score >= RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .map((v) => ({ c: candidates[v.index], reason: v.reason || `相关度 ${v.score}/10` }));
  } else {
    filter = "none";
    qualified = candidates.map((c) => ({ c, reason: "搜索命中(语义评审不可用,未过滤)" }));
  }

  // 查重口径与雷达一致:活跃 + 回收站,删过的灵感不许还魂
  const [active, trash] = await Promise.all([listTopics(dataDir), listTrash(dataDir)]);
  const seenTitles = new Set([...active, ...trash.topics].map((t) => t.title));
  const seenLinks = new Set([...active, ...trash.topics].map((t) => t.link).filter((l): l is string => Boolean(l)));

  const saved: Topic[] = [];
  let skippedDuplicates = 0;
  for (const q of qualified) {
    if (saved.length >= SAVE_LIMIT) break;
    if (seenTitles.has(q.c.title) || seenLinks.has(q.c.url)) {
      skippedDuplicates++;
      continue;
    }
    const topic = await saveTopic(
      {
        title: q.c.title,
        description: q.c.snippet ? q.c.snippet.slice(0, 300) : `侦查员搜集:${q.c.title}`,
        tags: ["scout"],
        source: `search:${cfg.provider}`,
        reason: `${q.reason} · ${domain(q.c.url)}`,
        link: q.c.url,
      },
      dataDir,
    );
    saved.push(topic);
    seenTitles.add(topic.title);
    if (topic.link) seenLinks.add(topic.link);
  }

  return { queriesUsed: queries, found: candidates.length, saved, skippedDuplicates, filter };
}
