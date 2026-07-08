/**
 * 雷达自动入库（IA v4.2 §A1 + 工程线语义升级）— 候选经相关性过滤 + 查重后写入灵感库。
 *
 * 过滤两级:LLM 语义评分为主路（任意定位成立,产出真入库理由）;引擎不可用时回退
 * 关键词机械匹配（链不断,但只对「AI」这类标题词有效——回退是降级不是常态）。
 * 宁缺勿滥:不相关的纯热点不入库,否则灵感库退化为 RSS 收件箱（契约 §4 反模式）。
 * 查重口径:与全部既有 Topic（含回收站）比标题与链接——用户删过的灵感不许次日还魂。
 * 触发:app 启动雷达刷新后 + 手动扫榜后（真调度器随总监 L2 上，PRD-v4 §4）。
 */
import { loadTopicCache, rankCandidatesScored } from "./topic-radar.js";
import type { ScoredRadarItem } from "./topic-radar.js";
import { judgeRelevance } from "./relevance.js";
import { saveTopic, listTopics, listTrash } from "../../storage/local-store.js";
import type { Topic } from "../../storage/local-store.js";
import { loadProfile } from "../profile/creator-profile.js";

const INTAKE_LIMIT = 3;
const CANDIDATE_POOL = 20;
const RELEVANCE_THRESHOLD = 7;

export interface RadarIntakeResult {
  saved: Topic[];
  skippedDuplicates: number;
  /** 通过相关性过滤的候选数（含重复的） */
  qualified: number;
  /** 本轮用的过滤器:llm（语义）| keyword（回退） */
  filter: "llm" | "keyword";
}

function ageHours(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3600_000));
}

function keywordReason(s: ScoredRadarItem): string {
  return `命中定位「${s.matchedTokens.join("、")}」 · ${s.item.source} · ${ageHours(s.item.publishedAt)}h 前`;
}

export async function intakeRadarTopics(
  dataDir?: string,
  deps?: { judge?: typeof judgeRelevance },
): Promise<RadarIntakeResult> {
  const profile = await loadProfile(dataDir);
  const industry = profile?.industry?.trim() ?? "";
  // 无定位 = 无过滤器 = 不自动入库（首跑校准后管道自然开启）
  if (!industry) return { saved: [], skippedDuplicates: 0, qualified: 0, filter: "keyword" };

  const cache = await loadTopicCache(dataDir);
  if (!cache || cache.items.length === 0) return { saved: [], skippedDuplicates: 0, qualified: 0, filter: "keyword" };

  // 粗筛:确定性排序取池（免费）;终筛:LLM 语义评分（主路）
  const pool = rankCandidatesScored(cache.items, industry, CANDIDATE_POOL);
  const judge = deps?.judge ?? judgeRelevance;
  const audience = profile?.audiencePersona?.name ?? "";
  const verdicts = await judge(industry, audience, pool.map((s) => ({ title: s.item.title, source: s.item.source })), dataDir);

  let qualified: Array<{ item: ScoredRadarItem["item"]; reason: string }>;
  let filter: RadarIntakeResult["filter"];
  if (verdicts) {
    filter = "llm";
    qualified = verdicts
      .filter((v) => v.score >= RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .map((v) => {
        const s = pool[v.index];
        const why = v.reason || `相关度 ${v.score}/10`;
        return { item: s.item, reason: `${why} · ${s.item.source} · ${ageHours(s.item.publishedAt)}h 前` };
      });
  } else {
    // 引擎不可用 → 关键词回退（只对标题里出现定位词的候选有效）
    filter = "keyword";
    qualified = pool.filter((s) => s.matchedTokens.length > 0).map((s) => ({ item: s.item, reason: keywordReason(s) }));
  }

  const [active, trash] = await Promise.all([listTopics(dataDir), listTrash(dataDir)]);
  const seenTitles = new Set([...active, ...trash.topics].map((t) => t.title));
  const seenLinks = new Set(
    [...active, ...trash.topics].map((t) => t.link).filter((l): l is string => Boolean(l)),
  );

  const saved: Topic[] = [];
  let skippedDuplicates = 0;
  for (const q of qualified) {
    if (saved.length >= INTAKE_LIMIT) break;
    if (seenTitles.has(q.item.title) || seenLinks.has(q.item.link)) {
      skippedDuplicates++;
      continue;
    }
    const topic = await saveTopic(
      {
        title: q.item.title,
        description: `雷达候选（自动入库）：${q.item.title}`,
        tags: ["radar"],
        source: `radar:${q.item.source}`,
        reason: q.reason,
        link: q.item.link,
      },
      dataDir,
    );
    saved.push(topic);
    seenTitles.add(topic.title);
    if (topic.link) seenLinks.add(topic.link);
  }

  return { saved, skippedDuplicates, qualified: qualified.length, filter };
}
