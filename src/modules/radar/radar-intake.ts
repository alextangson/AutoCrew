/**
 * 雷达自动入库（IA v4.2 §A1 + 工程线语义升级）— 候选经相关性过滤 + 查重后写入灵感库。
 *
 * 过滤两级:LLM 语义评分为主路（任意定位成立,产出真入库理由）;引擎不可用时回退
 * 关键词机械匹配（链不断,但只对「AI」这类标题词有效——回退是降级不是常态）。
 * 宁缺勿滥:不相关的纯热点不入库,否则灵感库退化为 RSS 收件箱（契约 §4 反模式）。
 * 查重口径:与全部既有 Topic（含回收站）比标题与链接——用户删过的灵感不许次日还魂。
 * 触发:app 启动雷达刷新后 + 手动扫榜后（真调度器随总监 L2 上，PRD-v4 §4）。
 *
 * 拆成两段(P6 §3.2):buildRadarPool 确定性建池(无模型),applyRadarResults 入库(阈值/限额/
 * 查重/落选记忆)。引擎路径在两段之间插 LLM 打分;宿主路径(radar_pool/radar_score)把池冻结
 * 落盘,由宿主会话用自己的额度打分后交回——两条路共用同一个池口径与同一个入库段。
 */
import crypto from "node:crypto";
import { loadTopicCache, rankCandidatesScored } from "./topic-radar.js";
import type { RadarItem, ScoredRadarItem } from "./topic-radar.js";
import { judgeRelevance, RADAR_PASS_SCORE } from "./relevance.js";
import type { RelevanceVerdict, TopicScoreBreakdown } from "./relevance.js";
// 查重(含回收站)与 7 天落选记忆住在 intake-gate——与收件箱单条入库门共用同一口径,只此一份实现。
import { loadDedupeIndex, loadRejects, saveRejects, rejectKeySet } from "./intake-gate.js";
import { saveTopic, listTopics, updateTopic } from "../../storage/local-store.js";
import type { Topic } from "../../storage/local-store.js";
import { loadProfile, personaSummary } from "../profile/creator-profile.js";
import type { CreatorProfile } from "../profile/creator-profile.js";

export const INTAKE_LIMIT = 3;
const CANDIDATE_POOL = 20;
// 关注型信源(X)在评判池里的保底名额——不被关键词粗筛挤掉,交给 LLM 判相关性。
// two-stage judge 的 Stage1 能覆盖 ~20 条,留 5 席给 X 足够;够格的才进 Stage2 精修入库。
const X_POOL_RESERVE = 5;
// 单源池内上限:一个源最多占 5 席。粗筛分很容易被某个源整体拉高(HN 全是英文短标题、
// PH 天天有新品),没有上限时评判池会被一个源包圆,arXiv 这类慢源永远挤不进去。
// 不是硬配额:先按上限取一轮,池没满再回填超限源的剩余条目——宁可单源霸池也不让池空着。
const PER_SOURCE_CAP = 5;
const THIN_MATERIAL = "材料不足：写作前需先阅读原始链接并补充事实。";

export interface RadarIntakeResult {
  saved: Topic[];
  skippedDuplicates: number;
  /** 通过相关性过滤的候选数（含重复的） */
  qualified: number;
  /** 本轮用的过滤器:llm（语义）| keyword（回退） */
  filter: "llm" | "keyword";
}

/** 评判池里的一条候选:确定性粗筛的产物,引擎与宿主两条打分路径看到的是同一份。 */
export interface RadarPoolCandidate {
  /** 规范化链接(无链接退标题)的哈希——同一条候选跨轮次、跨进程稳定 */
  candidate_id: string;
  item: RadarItem;
  /** 粗筛分(定位命中/新鲜度/热度),不是 100 分制 */
  rank_score: number;
  matched_tokens: string[];
}

export interface BuiltRadarPool {
  /** 跳过原因:没填定位 = 无过滤器 = 不入库;没有雷达缓存 = 无候选 */
  skip?: "no_profile" | "no_cache";
  profile: CreatorProfile | null;
  industry: string;
  audience: string;
  cacheFetchedAt: string | null;
  candidates: RadarPoolCandidate[];
}

/** 一条打分结果(100 分制)。宿主路径由 radar_score 交来,引擎路径由 verdict 换算。 */
export interface RadarScoredResult {
  candidate_id: string;
  score: number;
  title?: string;
  summary?: string;
  angles?: string[];
  reason?: string;
  scoreBreakdown?: TopicScoreBreakdown;
}

export interface RadarApplyOutcome {
  saved: Array<{ candidate_id: string; topic: Topic }>;
  /** 打了分但没过线 → 已写 7 天落选记忆 */
  rejected: string[];
  /** 过线但本轮名额已满,不入库也不记落选,下轮还能回池 */
  notTopN: string[];
  /** 过线但入库时撞上既有灵感(含回收站) */
  duplicates: string[];
  qualified: number;
}

/** 入库候选(已判定值得写),交给共用的查重 + 限额落库循环。 */
interface QualifiedCandidate {
  candidate: RadarPoolCandidate;
  title: string;
  description: string;
  reason: string;
  score?: number;
  scoreBreakdown?: TopicScoreBreakdown;
  angles?: string[];
}

function ageHours(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 3600_000));
}

/** 候选 id:有链接按链接,没有按标题。标题翻译/微调不该让同一条候选变成「新候选」。 */
export function candidateIdFor(item: Pick<RadarItem, "link" | "title">): string {
  const link = item.link?.trim();
  const key = link ? `url:${link}` : `title:${item.title.trim()}`;
  return `cand-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
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

function keywordReason(c: RadarPoolCandidate): string {
  return `命中定位「${c.matched_tokens.join("、")}」 · ${c.item.source} · ${ageHours(c.item.publishedAt)}h 前`;
}

/** 先排除看过/删过/近 7 天落选的条目,同一 candidate_id 只留第一条。 */
async function unseenItems(items: RadarItem[], dataDir?: string): Promise<RadarItem[]> {
  // 先排除看过/删过的条目再评分：否则每次「继续收集」都把同一批重复项送进模型，永远走不到后面的池。
  const dedupe = await loadDedupeIndex(dataDir);
  // 落选记忆:近 7 天被评过且没过关的不再回池,把名额让给新候选
  const rejectKeys = rejectKeySet(await loadRejects(dataDir));
  const seenIds = new Set<string>();
  return items.filter((item) => {
    if (dedupe.findDuplicate([item.title], item.link)) return false;
    if (rejectKeys.has(item.title) || rejectKeys.has(item.link)) return false;
    const id = candidateIdFor(item);
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
}

/**
 * 确定性建池(无模型):查重(含回收站) + 7 天落选记忆 + X 保底位 + 单源上限,池 ≤ poolSize。
 * 引擎两段打分与宿主 radar_pool 共用这一份——两条路看到的候选口径必须一致。
 */
export async function buildRadarPool(dataDir?: string, options?: { poolSize?: number }): Promise<BuiltRadarPool> {
  const profile = await loadProfile(dataDir);
  const industry = profile?.industry?.trim() ?? "";
  const base = { profile, industry, audience: personaSummary(profile?.audiencePersona), cacheFetchedAt: null, candidates: [] };
  // 无定位 = 无过滤器 = 不自动入库（首跑校准后管道自然开启）
  if (!industry) return { ...base, skip: "no_profile" };
  const cache = await loadTopicCache(dataDir);
  if (!cache || cache.items.length === 0) return { ...base, skip: "no_cache" };

  const unseen = await unseenItems(cache.items, dataDir);
  // 粗筛:确定性排序取池（免费）;终筛交给打分方(引擎或宿主)。
  // X 是关注型信源——好观点不 keyword-stuff(karpathy「joined Anthropic」命中定位词=[]),
  // 会被关键词粗筛埋在池外、打分方根本看不到。故给 X 留固定名额:粗筛只是控池大小,真正的
  // 相关性判断交给打分方(它看得懂账号观点是否切题)。账号本身已是质量过滤,值得这个名额。
  const poolSize = Math.max(1, Math.min(options?.poolSize ?? CANDIDATE_POOL, 24));
  const ranked = rankCandidatesScored(unseen, industry, unseen.length, profile?.focusKeywords);
  // X 放池首:judge 内部只取前 MAX_CANDIDATES 条,放末尾会被切掉、白留名额。
  const xReserved = ranked.filter((s) => s.item.source === "X").slice(0, X_POOL_RESERVE);
  const rest = takeWithSourceCap(
    ranked.filter((s) => s.item.source !== "X"),
    poolSize - xReserved.length,
    PER_SOURCE_CAP,
  );
  const candidates = [...xReserved, ...rest].map((s) => ({
    candidate_id: candidateIdFor(s.item),
    item: s.item,
    rank_score: s.score,
    matched_tokens: s.matchedTokens,
  }));
  return { ...base, cacheFetchedAt: cache.fetchedAt, candidates };
}

function radarTopicDraft(q: QualifiedCandidate): Omit<Topic, "id" | "createdAt"> {
  const { item } = q.candidate;
  return {
    title: q.title,
    description: q.description,
    tags: ["radar"],
    source: `radar:${item.source}`,
    reason: q.reason,
    link: item.link,
    ...(q.title !== item.title ? { originalTitle: item.title } : {}),
    ...(typeof q.score === "number" ? { score: q.score, scoredAt: new Date().toISOString() } : {}),
    ...(q.scoreBreakdown ? { scoreBreakdown: q.scoreBreakdown } : {}),
    ...(q.angles?.length ? { angles: q.angles } : {}),
  };
}

/** 共用落库循环:按顺序查重(含回收站、含本批刚入的) → 落库,满 limit 后其余记为未入前 N。 */
async function saveQualified(
  qualified: QualifiedCandidate[],
  dataDir: string | undefined,
  limit: number,
): Promise<Pick<RadarApplyOutcome, "saved" | "notTopN" | "duplicates">> {
  const dedupe = await loadDedupeIndex(dataDir);
  const out: Pick<RadarApplyOutcome, "saved" | "notTopN" | "duplicates"> = { saved: [], notTopN: [], duplicates: [] };
  for (const q of qualified) {
    const id = q.candidate.candidate_id;
    if (out.saved.length >= limit) {
      out.notTopN.push(id);
      continue;
    }
    if (dedupe.findDuplicate([q.title, q.candidate.item.title], q.candidate.item.link)) {
      out.duplicates.push(id);
      continue;
    }
    const topic = await saveTopic(radarTopicDraft(q), dataDir);
    dedupe.remember(topic);
    out.saved.push({ candidate_id: id, topic });
  }
  return out;
}

/** 打过分没过线的写进 7 天落选记忆,下轮不再回池重评。 */
async function rememberRejects(rejected: RadarPoolCandidate[], dataDir?: string): Promise<void> {
  if (rejected.length === 0) return;
  const now = new Date().toISOString();
  const entries = rejected.map((c) => ({ title: c.item.title, link: c.item.link, at: now }));
  await saveRejects([...(await loadRejects(dataDir)), ...entries], dataDir).catch((err) => {
    // 落选记忆写失败不回滚已入库的灵感,但要看得见:下一轮这些候选会回池重评
    console.warn(`[radar-intake] 落选记忆写入失败: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function toQualified(c: RadarPoolCandidate, r: RadarScoredResult): QualifiedCandidate {
  const why = r.reason || `相关度 ${r.score}/100`;
  return {
    candidate: c,
    title: r.title || c.item.title,
    description: r.summary || c.item.description || THIN_MATERIAL,
    reason: `${why} · ${c.item.source} · ${ageHours(c.item.publishedAt)}h 前`,
    score: r.score,
    ...(r.scoreBreakdown ? { scoreBreakdown: r.scoreBreakdown } : {}),
    ...(r.angles?.length ? { angles: r.angles } : {}),
  };
}

/**
 * 入库段(引擎与宿主共用):≥ RADAR_PASS_SCORE 按分数排序入库,每轮 ≤ limit 条,查重含回收站;
 * 打分没过线的写落选记忆。不在 results 里的候选视为没打分:不入库,也不记落选。
 */
export async function applyRadarResults(
  candidates: RadarPoolCandidate[],
  results: RadarScoredResult[],
  dataDir?: string,
  options?: { limit?: number },
): Promise<RadarApplyOutcome> {
  const byId = new Map(candidates.map((c) => [c.candidate_id, c]));
  const scored = results.filter((r) => byId.has(r.candidate_id));
  const qualified = scored
    .filter((r) => r.score >= RADAR_PASS_SCORE)
    .sort((a, b) => b.score - a.score)
    .map((r) => toQualified(byId.get(r.candidate_id)!, r));
  const limit = Math.max(1, Math.min(options?.limit ?? INTAKE_LIMIT, 10));
  const saved = await saveQualified(qualified, dataDir, limit);
  const rejected = scored.filter((r) => r.score < RADAR_PASS_SCORE).map((r) => r.candidate_id);
  await rememberRejects(rejected.map((id) => byId.get(id)!), dataDir);
  return { ...saved, rejected, qualified: qualified.length };
}

/** verdict 的 100 分制分数:以服务端重算的 totalScore 为准,缺省时由 0-10 的 score 换算。 */
function verdictScore(v: RelevanceVerdict): number {
  return Number.isFinite(v.totalScore) ? v.totalScore : Math.round(v.score * 10);
}

/**
 * 引擎 verdict → 打分结果。池里没有 verdict 的候选 = Stage1 评过但没被选进精修
 * (低分/没进前 N/精修漏交),按 0 分记——与改造前「不在 verdicts 里就记落选」同一口径。
 */
function verdictsToResults(candidates: RadarPoolCandidate[], verdicts: RelevanceVerdict[]): RadarScoredResult[] {
  const byIndex = new Map<number, RelevanceVerdict>();
  for (const v of verdicts) if (!byIndex.has(v.index)) byIndex.set(v.index, v);
  return candidates.map((c, i) => {
    const v = byIndex.get(i);
    if (!v) return { candidate_id: c.candidate_id, score: 0 };
    return {
      candidate_id: c.candidate_id,
      score: verdictScore(v),
      ...(v.titleZh ? { title: v.titleZh } : {}),
      ...(v.summaryZh ? { summary: v.summaryZh } : {}),
      ...(v.angles?.length ? { angles: v.angles } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.scoreBreakdown ? { scoreBreakdown: v.scoreBreakdown } : {}),
    };
  });
}

/**
 * 引擎不可用 → 只保留本身已有中文、且明确命中定位词的候选。
 * 英文候选无法可靠翻译/补材料时宁可不入库，避免再次污染灵感库。
 * 关键词回退是降级:不记落选,别让它误杀模型会喜欢的题。
 */
async function keywordIntake(pool: BuiltRadarPool, dataDir: string | undefined, limit: number): Promise<RadarIntakeResult> {
  const qualified = pool.candidates
    .filter((c) => c.matched_tokens.length > 0 && /[\u3400-\u9fff]/.test(c.item.title))
    .map((c) => ({
      candidate: c,
      title: c.item.title,
      description: c.item.description || THIN_MATERIAL,
      reason: keywordReason(c),
      score: Math.min(69, 45 + c.rank_score * 5),
    }));
  const out = await saveQualified(qualified, dataDir, limit);
  return { saved: out.saved.map((s) => s.topic), skippedDuplicates: out.duplicates.length, qualified: qualified.length, filter: "keyword" };
}

/** 引擎路径:建池 → 两段 LLM 打分 → 共用入库段;引擎不可用回退关键词。 */
export async function intakeRadarTopics(
  dataDir?: string,
  options?: { judge?: typeof judgeRelevance; limit?: number; poolSize?: number },
): Promise<RadarIntakeResult> {
  const pool = await buildRadarPool(dataDir, { poolSize: options?.poolSize });
  if (pool.skip) return { saved: [], skippedDuplicates: 0, qualified: 0, filter: "keyword" };

  const limit = Math.max(1, Math.min(options?.limit ?? INTAKE_LIMIT, 10));
  const judge = options?.judge ?? judgeRelevance;
  const verdicts = await judge(
    pool.industry,
    pool.audience,
    pool.candidates.map((c) => ({ title: c.item.title, source: c.item.source, description: c.item.description })),
    dataDir,
  );
  if (!verdicts) return keywordIntake(pool, dataDir, limit);

  const applied = await applyRadarResults(pool.candidates, verdictsToResults(pool.candidates, verdicts), dataDir, { limit });
  return {
    saved: applied.saved.map((s) => s.topic),
    skippedDuplicates: applied.duplicates.length,
    qualified: applied.qualified,
    filter: "llm",
  };
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
