/**
 * Outcome Store — append-only JSONL journal（PRD v3 §5 持久化约束：追加式、幂等、可冷启动重放）。
 *
 * 文件：<dataDir>/outcomes.jsonl，一行一条 PerformanceOutcome。
 * 幂等：同 outcomeKey 后写覆盖先写（读取时 latest-wins），journal 本身永不改写。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  validateOutcome,
  outcomeKey,
  normalizeTitle,
  normalizePlatform,
  type PerformanceOutcome,
} from "./outcome-schema.js";
import { lookupPlatformItem, commitBindings, type PendingBinding, type BindingVia } from "./platform-items.js";
import { parsePublishUrl } from "./publish-url.js";
import { listContents, getContent, getDataDir, type Content } from "../../storage/local-store.js";

const OUTCOMES_FILE = "outcomes.jsonl";

function outcomesPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), OUTCOMES_FILE);
}

async function readJournal(dataDir?: string): Promise<PerformanceOutcome[]> {
  let raw: string;
  try {
    raw = await fs.readFile(outcomesPath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const outcomes: PerformanceOutcome[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      outcomes.push(JSON.parse(line) as PerformanceOutcome);
    } catch {
      // 跳过损坏行：单行损坏不应清空整个读视图
    }
  }
  return outcomes;
}

/** latest-wins：同幂等键只保留 journal 中最后一条 */
export async function listOutcomes(dataDir?: string): Promise<PerformanceOutcome[]> {
  const journal = await readJournal(dataDir);
  const byKey = new Map<string, PerformanceOutcome>();
  for (const o of journal) {
    byKey.set(outcomeKey(o), o);
  }
  const deduped = Array.from(byKey.values());
  // 对账：同一平台条目（标题@发布日期）存在任何打标（contentId 非空）版本时，
  // 丢弃该条目的全部历史（contentId 为空）版本——跨数据日期也不双计（评审修订：
  // 否则 confirm_published 前的周一快照与之后的周二快照会被 baseline 当成两个作品）。
  const matchedTitleKeys = new Set(
    deduped
      .filter((o) => o.contentId !== null)
      .map((o) => outcomeKey({ ...o, contentId: null, metricDate: "" })),
  );
  return deduped.filter(
    (o) => o.contentId !== null || !matchedTitleKeys.has(outcomeKey({ ...o, metricDate: "" })),
  );
}

/**
 * 作品视角：每个作品（幂等键去掉 metricDate）只保留最新数据日期的快照。
 * 周常重复导入会让快照数（listOutcomes）按周增长，作品数不变——
 * report 的可靠性核对（matched == 本周发布数）必须看这个视图。
 */
export async function listLatestOutcomes(dataDir?: string): Promise<PerformanceOutcome[]> {
  const outcomes = await listOutcomes(dataDir);
  const latestByItem = new Map<string, PerformanceOutcome>();
  for (const o of outcomes) {
    const itemKey = outcomeKey({ ...o, metricDate: "" });
    const prev = latestByItem.get(itemKey);
    if (!prev || o.metricDate > prev.metricDate) latestByItem.set(itemKey, o);
  }
  return Array.from(latestByItem.values());
}

export async function getOutcomesForContent(
  contentId: string,
  dataDir?: string,
): Promise<PerformanceOutcome[]> {
  return (await listOutcomes(dataDir)).filter((o) => o.contentId === contentId);
}

/**
 * 进程内 outcomes 写队列（仿 local-store.ts serializeContentWrite）。
 * 逐条 recordOutcome 与批量 importPerformanceRows 共用同一条链：读全量→判幂等→append
 * 的读-改-写不互相穿插，否则并发批次会各自基于旧快照算 replaced/暴涨。
 * 只护本进程；跨进程（扩展 native-host）仍靠 O_APPEND 行级追加 + 读侧坏行跳过，
 * **不承诺崩溃原子性**：崩溃可能留半行，读侧容错吸收（spec §4.1，codex #6）。
 */
const outcomeWriteChains = new Map<string, Promise<unknown>>();

export function serializeOutcomeWrite<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = getDataDir(dataDir);
  const prev = outcomeWriteChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 前一步失败也不许卡住后一步
  const tail = next.then(() => undefined, () => undefined);
  outcomeWriteChains.set(key, tail);
  void tail.then(() => {
    if (outcomeWriteChains.get(key) === tail) outcomeWriteChains.delete(key);
  });
  return next;
}

/** 单次 append 落盘（批量入库只写一次；调用方负责已在写队列里） */
export async function appendOutcomes(outcomes: PerformanceOutcome[], dataDir?: string): Promise<void> {
  if (outcomes.length === 0) return;
  await fs.mkdir(getDataDir(dataDir), { recursive: true });
  const payload = outcomes.map((o) => JSON.stringify(o) + "\n").join("");
  await fs.appendFile(outcomesPath(dataDir), payload, "utf-8");
}

const SPIKE_MIN_PEERS = 5;
const SPIKE_MULTIPLE = 20;

/** 同平台已有的 views 样本（升序），暴涨检测的对照基数 */
export function collectPeerViews(existing: PerformanceOutcome[], platform: string): number[] {
  return existing
    .filter((o) => o.platform === platform)
    .flatMap((o) => (typeof o.metrics.views === "number" ? [o.metrics.views] : []))
    .sort((a, b) => a - b);
}

/** 暴涨检测：同平台已有 ≥5 条数据时，views > 20 × 中位数 → needsReview 理由；否则 null */
export function spikeReviewReason(peerViews: number[], views: number | undefined): string | null {
  if (peerViews.length < SPIKE_MIN_PEERS || typeof views !== "number") return null;
  const median = peerViews[Math.floor(peerViews.length / 2)];
  if (median > 0 && views > median * SPIKE_MULTIPLE) {
    return `播放量 ${views} 超过平台中位数 ${median} 的 ${SPIKE_MULTIPLE} 倍，确认非读错字段`;
  }
  return null;
}

export interface RecordResult {
  ok: boolean;
  outcome?: PerformanceOutcome;
  replaced: boolean;
  error?: string;
}

export async function recordOutcome(
  input: Omit<PerformanceOutcome, "recordedAt" | "needsReview" | "reviewReasons">,
  dataDir?: string,
): Promise<RecordResult> {
  const validation = validateOutcome(input);
  if (!validation.ok) {
    return { ok: false, replaced: false, error: validation.reasons.join("；") };
  }

  return serializeOutcomeWrite(dataDir, async () => {
    const existing = await listOutcomes(dataDir);
    // 绑定先于建键：绑定表可能把归属改到另一稿，幂等键跟着归属走（键本身的构成不变）
    const binding = await resolveItemBinding({
      platform: input.platform,
      platformTitle: input.platformTitle,
      publishedAt: input.publishedAt,
      platformItemId: input.platformItemId,
      contentId: input.contentId,
      dataDir,
    });
    const key = outcomeKey({ ...input, contentId: binding.contentId });
    const replaced = existing.some((o) => outcomeKey(o) === key);

    const reviewReasons = [...validation.reasons, ...binding.reviewReasons];
    const spike = spikeReviewReason(collectPeerViews(existing, input.platform), input.metrics.views);
    if (spike) reviewReasons.push(spike);

    const outcome: PerformanceOutcome = {
      ...input,
      contentId: binding.contentId,
      recordedAt: new Date().toISOString(),
      needsReview: reviewReasons.length > 0,
      reviewReasons,
    };
    await appendOutcomes([outcome], dataDir);
    await commitResolvedBindings(binding.pending ? [binding.pending] : [], dataDir);
    return { ok: true, outcome, replaced };
  });
}

/** bigram Dice 系数，0-1 */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };
  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of aB) {
    overlap += Math.min(count, bB.get(bg) || 0);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

const FUZZY_THRESHOLD = 0.6;
const STRICT_THRESHOLD = 0.8;
const TIME_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * draft↔outcome 双因子匹配（PRD §6 verify）：
 * 归一化标题精确命中 → 直接匹配；
 * 模糊命中（dice ≥ 0.6）→ 需发布时间窗 ±48h 佐证；双方任一缺发布时间则要求 dice ≥ 0.8。
 */
export async function matchDraft(
  platform: string,
  platformTitle: string,
  publishedAt: string | null,
  dataDir?: string,
): Promise<Content | null> {
  const contents = await listContents(dataDir);
  const targetPlatform = normalizePlatform(platform);
  const candidates = contents.filter(
    (c) => c.status === "published" && c.platform && normalizePlatform(c.platform) === targetPlatform,
  );
  const target = normalizeTitle(platformTitle);
  if (!target) return null; // 标题归一化后为空：没有匹配依据

  let best: { content: Content; score: number } | null = null;
  for (const c of candidates) {
    const normalized = normalizeTitle(c.title);
    if (normalized === target) return c;
    const score = diceSimilarity(normalized, target);
    if (!best || score > best.score) best = { content: c, score };
  }
  if (!best || best.score < FUZZY_THRESHOLD) return null;

  // 不可解析的时间视同缺失，落入 strict 分支而非永远 fail 时间窗
  const draftTimeRaw = best.content.publishedAt ? Date.parse(best.content.publishedAt) : NaN;
  const itemTimeRaw = publishedAt ? Date.parse(publishedAt) : NaN;
  const draftTime = Number.isNaN(draftTimeRaw) ? null : draftTimeRaw;
  const itemTime = Number.isNaN(itemTimeRaw) ? null : itemTimeRaw;
  if (draftTime !== null && itemTime !== null) {
    return Math.abs(draftTime - itemTime) <= TIME_WINDOW_MS ? best.content : null;
  }
  return best.score >= STRICT_THRESHOLD ? best.content : null;
}

export interface BindingRequest {
  platform: string;
  platformTitle: string;
  publishedAt: string | null;
  /** 行携带的平台作品 id；没有就退回纯标题匹配 */
  platformItemId?: string;
  /**
   * 调用方已定的 contentId（逐条 recordOutcome 路径，null = 明确的历史行）。
   * 传 undefined = 批量导入路径，由 matchDraft 现算。
   */
  contentId?: string | null;
  dataDir?: string;
}

export interface BindingResolution {
  /** 最终归属：绑定表命中优先于 matchDraft（spec §5.1） */
  contentId: string | null;
  /** 对账发现的分歧，进 outcome.reviewReasons */
  reviewReasons: string[];
  /** 够格登记的新绑定；调用方**落盘成功后**再提交 */
  pending: PendingBinding | null;
}

/**
 * 登记证据：链接解析出的 id 相等（url）> 归一化标题精确相等（title）。
 * dice 模糊命中一律不登记——置信不够的绑定一旦写进表就会被后续行当成精确事实，
 * 错误会自我固化（spec §5.1，codex #11）。
 */
function bindingEvidence(draft: Content, platformTitle: string, platform: string, itemId: string): BindingVia | null {
  // 带 platform 解析：链接自称的平台与本行平台不符时 parsePublishUrl 直接 null，不会张冠李戴
  const parsed = draft.publishUrl ? parsePublishUrl(draft.publishUrl, platform) : null;
  if (parsed && parsed.itemId === itemId) return "url";
  const target = normalizeTitle(platformTitle);
  if (target && normalizeTitle(draft.title) === target) return "title";
  return null;
}

/**
 * 归属裁决：批量导入与逐条回填共用的唯一一套绑定逻辑（spec §5.1）。
 *
 * ① 绑定表命中 → 直接用映射的 contentId（标题改过也照样认得出）；
 * ② 未命中 → 用 matchDraft（或调用方给的 id）；证据够格（url/精确标题）才登记，自愈从此开始；
 * ③ 绑定表与 matchDraft 各指一稿 → **以绑定表为准**并标 needsReview，让人来裁，不自动改判。
 */
export async function resolveItemBinding(req: BindingRequest): Promise<BindingResolution> {
  const itemId = (req.platformItemId ?? "").trim();
  const matched =
    req.contentId === undefined
      ? await matchDraft(req.platform, req.platformTitle, req.publishedAt, req.dataDir)
      : null;
  const contentId = req.contentId !== undefined ? req.contentId : matched?.id ?? null;
  if (!itemId) return { contentId, reviewReasons: [], pending: null };

  const bound = await lookupPlatformItem(req.platform, itemId, req.dataDir);
  if (bound) {
    const conflict = contentId && contentId !== bound.contentId;
    return {
      contentId: bound.contentId,
      reviewReasons: conflict
        ? [
            `平台作品 ${normalizePlatform(req.platform)}:${itemId} 已绑定稿件 ${bound.contentId}，` +
              `本行按标题匹配到 ${contentId}——已按绑定归属，确认是不是标题被改过或绑错了`,
          ]
        : [],
      pending: null,
    };
  }

  // 逐条路径没走 matchDraft，取稿只为看证据（链接/标题）——绑定表已命中时这一步根本不发生
  const draft = matched ?? (req.contentId ? await getContent(req.contentId, req.dataDir) : null);
  const via = draft && contentId === draft.id ? bindingEvidence(draft, req.platformTitle, req.platform, itemId) : null;
  return {
    contentId,
    reviewReasons: [],
    pending: via && contentId ? { platform: req.platform, itemId, contentId, via } : null,
  };
}

/**
 * 落盘后提交绑定。绑定表是缓存不是账本：写失败只 warn，不回滚已入库的 outcomes——
 * 下一次导入会重新走同样的证据再登记一次（自愈路径本身就是幂等的）。
 */
export async function commitResolvedBindings(pending: PendingBinding[], dataDir?: string): Promise<void> {
  if (pending.length === 0) return;
  try {
    await commitBindings(pending, dataDir);
  } catch (err) {
    console.warn(`[flywheel] 平台作品绑定写入失败(不影响本批入库)：${(err as Error).message}`);
  }
}
