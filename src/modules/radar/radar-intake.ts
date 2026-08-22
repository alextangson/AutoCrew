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
// 查重(含回收站)与 7 天落选记忆住在 intake-gate——与收件箱单条入库门共用同一口径,只此一份实现。
import { loadDedupeIndex, loadRejects, saveRejects, rejectKeySet } from "./intake-gate.js";
import { saveTopic, listTopics, updateTopic } from "../../storage/local-store.js";
import type { Topic } from "../../storage/local-store.js";
import { loadProfile, personaSummary } from "../profile/creator-profile.js";

const INTAKE_LIMIT = 3;
const CANDIDATE_POOL = 20;
const RELEVANCE_THRESHOLD = 7;
// 关注型信源(X)在评判池里的保底名额——不被关键词粗筛挤掉,交给 LLM 判相关性。
// two-stage judge 的 Stage1 能覆盖 ~20 条,留 5 席给 X 足够;够格的才进 Stage2 精修入库。
const X_POOL_RESERVE = 5;
// 单源池内上限:一个源最多占 5 席。粗筛分很容易被某个源整体拉高(HN 全是英文短标题、
// PH 天天有新品),没有上限时评判池会被一个源包圆,arXiv 这类慢源永远挤不进去。
// 不是硬配额:先按上限取一轮,池没满再回填超限源的剩余条目——宁可单源霸池也不让池空着。
const PER_SOURCE_CAP = 5;

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

/** 按 ranked 顺序取 limit 条,每源先不超过 cap;取完不够再按顺序回填超限源的剩余条目。 */
function takeWithSourceCap(ranked: ScoredRadarItem[], limit: number, cap: number): ScoredRadarItem[] {
  const picked: ScoredRadarItem[] = [];
  const overflow: ScoredRadarItem[] = [];
  const used = new Map<string, number>();
  for (const s of ranked) {
    if (picked.length >= limit) return picked;
    const n = used.get(s.item.source) ?? 0;
    if (n >= cap) {
      overflow.push(s);
      continue;
    }
    used.set(s.item.source, n + 1);
    picked.push(s);
  }
  for (const s of overflow) {
    if (picked.length >= limit) break;
    picked.push(s);
  }
  return picked;
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
  const dedupe = await loadDedupeIndex(dataDir);
  // 落选记忆:近 7 天被 LLM 评过且没过关的不再回池,把名额让给新候选
  const rejects = await loadRejects(dataDir);
  const rejectKeys = rejectKeySet(rejects);
  const unseen = cache.items.filter(
    (item) =>
      !dedupe.findDuplicate([item.title], item.link) &&
      !rejectKeys.has(item.title) && !rejectKeys.has(item.link),
  );

  // 粗筛:确定性排序取池（免费）;终筛:LLM 四维评分+中文加工（主路）。
  // X 是关注型信源——好观点不 keyword-stuff(karpathy「joined Anthropic」命中定位词=[]),
  // 会被关键词粗筛埋在池外、LLM 根本看不到。故给 X 留固定名额:粗筛只是控池大小,真正的
  // 相关性判断交给 LLM(它看得懂账号观点是否切题)。账号本身已是质量过滤,值得这个名额。
  const poolSize = Math.max(1, Math.min(options?.poolSize ?? CANDIDATE_POOL, 24));
  const ranked = rankCandidatesScored(unseen, industry, unseen.length, profile?.focusKeywords);
  // X 放池首:judge 内部只取前 MAX_CANDIDATES 条,放末尾会被切掉、白留名额。
  const xReserved = ranked.filter((s) => s.item.source === "X").slice(0, X_POOL_RESERVE);
  const rest = takeWithSourceCap(
    ranked.filter((s) => s.item.source !== "X"),
    poolSize - xReserved.length,
    PER_SOURCE_CAP,
  );
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
    if (dedupe.findDuplicate([q.title, q.item.title], q.item.link)) {
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
    dedupe.remember(topic);
  }

  // 记录本轮 LLM 评过但没过关的候选(verdicts 里没有的 pool 项 = Stage1 低分/未选中),
  // 下轮不再回池重评。只在 llm 路径记——关键词回退是降级,别让它误杀 LLM 会喜欢的题。
  if (verdicts) {
    const passedIdx = new Set(verdicts.map((v) => v.index));
    const now = new Date().toISOString();
    const newRejects = pool
      .filter((_, i) => !passedIdx.has(i))
      .map((s) => ({ title: s.item.title, link: s.item.link, at: now }));
    if (newRejects.length > 0) {
      await saveRejects([...rejects, ...newRejects], dataDir).catch(() => {});
    }
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
