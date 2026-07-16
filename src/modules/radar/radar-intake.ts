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
import { saveTopic, listTopics, listTrash, updateTopic } from "../../storage/local-store.js";
import type { Topic } from "../../storage/local-store.js";
import { loadProfile, personaSummary } from "../profile/creator-profile.js";

const INTAKE_LIMIT = 3;
const CANDIDATE_POOL = 20;
const RELEVANCE_THRESHOLD = 7;
// 关注型信源(X)在评判池里的保底名额——不被关键词粗筛挤掉,交给 LLM 判相关性。
// 控在 2:judge 只评前 MAX_CANDIDATES(4) 条,留 2 给 X、2 给关键词命中项,兼顾两边。
const X_POOL_RESERVE = 2;

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
  options?: { judge?: typeof judgeRelevance; limit?: number; poolSize?: number },
): Promise<RadarIntakeResult> {
  const profile = await loadProfile(dataDir);
  const industry = profile?.industry?.trim() ?? "";
  // 无定位 = 无过滤器 = 不自动入库（首跑校准后管道自然开启）
  if (!industry) return { saved: [], skippedDuplicates: 0, qualified: 0, filter: "keyword" };

  const cache = await loadTopicCache(dataDir);
  if (!cache || cache.items.length === 0) return { saved: [], skippedDuplicates: 0, qualified: 0, filter: "keyword" };

  // 先排除看过/删过的条目再评分：否则每次「继续收集」都把同一批重复项送进模型，永远走不到后面的池。
  const [active, trash] = await Promise.all([listTopics(dataDir), listTrash(dataDir)]);
  const allTopics = [...active, ...trash.topics];
  const seenTitles = new Set(allTopics.flatMap((t) => [t.title, t.originalTitle].filter((v): v is string => Boolean(v))));
  const seenLinks = new Set(allTopics.map((t) => t.link).filter((l): l is string => Boolean(l)));
  const unseen = cache.items.filter((item) => !seenTitles.has(item.title) && !seenLinks.has(item.link));

  // 粗筛:确定性排序取池（免费）;终筛:LLM 四维评分+中文加工（主路）。
  // X 是关注型信源——好观点不 keyword-stuff(karpathy「joined Anthropic」命中定位词=[]),
  // 会被关键词粗筛埋在池外、LLM 根本看不到。故给 X 留固定名额:粗筛只是控池大小,真正的
  // 相关性判断交给 LLM(它看得懂账号观点是否切题)。账号本身已是质量过滤,值得这个名额。
  const poolSize = Math.max(1, Math.min(options?.poolSize ?? CANDIDATE_POOL, 24));
  const ranked = rankCandidatesScored(unseen, industry, unseen.length);
  // X 放池首:judge 内部只取前 MAX_CANDIDATES 条,放末尾会被切掉、白留名额。
  const xReserved = ranked.filter((s) => s.item.source === "X").slice(0, X_POOL_RESERVE);
  const rest = ranked.filter((s) => s.item.source !== "X").slice(0, poolSize - xReserved.length);
  const pool = [...xReserved, ...rest];
  const judge = options?.judge ?? judgeRelevance;
  const audience = personaSummary(profile?.audiencePersona);
  const verdicts = await judge(
    industry,
    audience,
    pool.map((s) => ({ title: s.item.title, source: s.item.source, description: s.item.description })),
    dataDir,
  );

  let qualified: Array<{
    item: ScoredRadarItem["item"];
    reason: string;
    title: string;
    description: string;
    score?: number;
    scoreBreakdown?: Topic["scoreBreakdown"];
    angles?: string[];
  }>;
  let filter: RadarIntakeResult["filter"];
  if (verdicts) {
    filter = "llm";
    qualified = verdicts
      .filter((v) => v.score >= RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .map((v) => {
        const s = pool[v.index];
        if (!s) return null;
        const why = v.reason || `相关度 ${v.score}/10`;
        return {
          item: s.item,
          title: v.titleZh || s.item.title,
          description: v.summaryZh || s.item.description || `材料不足：写作前需先阅读原始链接并补充事实。`,
          reason: `${why} · ${s.item.source} · ${ageHours(s.item.publishedAt)}h 前`,
          score: v.totalScore,
          scoreBreakdown: v.scoreBreakdown,
          angles: v.angles,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
  } else {
    // 引擎不可用 → 只保留本身已有中文、且明确命中定位词的候选。
    // 英文候选无法可靠翻译/补材料时宁可不入库，避免再次污染灵感库。
    filter = "keyword";
    qualified = pool
      .filter((s) => s.matchedTokens.length > 0 && /[\u3400-\u9fff]/.test(s.item.title))
      .map((s) => ({
        item: s.item,
        title: s.item.title,
        description: s.item.description || `材料不足：写作前需先阅读原始链接并补充事实。`,
        reason: keywordReason(s),
        score: Math.min(69, 45 + s.score * 5),
      }));
  }

  const saved: Topic[] = [];
  let skippedDuplicates = 0;
  const intakeLimit = Math.max(1, Math.min(options?.limit ?? INTAKE_LIMIT, 10));
  for (const q of qualified) {
    if (saved.length >= intakeLimit) break;
    if (seenTitles.has(q.title) || seenTitles.has(q.item.title) || seenLinks.has(q.item.link)) {
      skippedDuplicates++;
      continue;
    }
    const topic = await saveTopic(
      {
        title: q.title,
        description: q.description,
        tags: ["radar"],
        source: `radar:${q.item.source}`,
        reason: q.reason,
        link: q.item.link,
        ...(q.title !== q.item.title ? { originalTitle: q.item.title } : {}),
        ...(typeof q.score === "number" ? { score: q.score, scoredAt: new Date().toISOString() } : {}),
        ...(q.scoreBreakdown ? { scoreBreakdown: q.scoreBreakdown } : {}),
        ...(q.angles?.length ? { angles: q.angles } : {}),
      },
      dataDir,
    );
    saved.push(topic);
    seenTitles.add(topic.title);
    if (topic.link) seenLinks.add(topic.link);
  }

  return { saved, skippedDuplicates, qualified: qualified.length, filter };
}

/** 对已有雷达/搜索灵感补做中文化、四维评分与可写角度，不改变手工灵感。 */
export async function rescoreExistingTopics(
  dataDir?: string,
  deps?: { judge?: typeof judgeRelevance },
): Promise<{ updated: Topic[]; examined: number }> {
  const [profile, topics] = await Promise.all([loadProfile(dataDir), listTopics(dataDir)]);
  const industry = profile?.industry?.trim() ?? "";
  if (!industry) throw new Error("先在校准中心填写定位，才能重评选题");
  const candidates = topics
    .filter((t) => t.source?.startsWith("radar:") || t.source?.startsWith("search:"))
    .slice(0, 24);
  if (candidates.length === 0) return { updated: [], examined: 0 };
  const judge = deps?.judge ?? judgeRelevance;
  const updated: Topic[] = [];
  const BATCH_SIZE = 8;
  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    const verdicts = await judge(
      industry,
      personaSummary(profile?.audiencePersona),
      batch.map((t) => ({
        title: t.originalTitle || t.title,
        source: t.source || "unknown",
        description: t.description,
      })),
      dataDir,
    );
    if (!verdicts) continue;
    for (const verdict of verdicts) {
      const topic = batch[verdict.index];
      if (!topic) continue;
      const title = verdict.titleZh || topic.title;
      const next = await updateTopic(
        topic.id,
        {
          title,
          ...(title !== topic.title && !topic.originalTitle ? { originalTitle: topic.title } : {}),
          ...(verdict.summaryZh ? { description: verdict.summaryZh } : {}),
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          score: verdict.totalScore,
          ...(verdict.scoreBreakdown ? { scoreBreakdown: verdict.scoreBreakdown } : {}),
          ...(verdict.angles?.length ? { angles: verdict.angles } : {}),
          scoredAt: new Date().toISOString(),
        },
        dataDir,
      );
      if (next) updated.push(next);
    }
  }
  if (updated.length === 0) throw new Error("选题重评模型暂时不可用，请稍后重试");
  return { updated, examined: candidates.length };
}
