/**
 * 深调研 IPC handlers（deep-research spec §8 + P1 spec §4.6）：
 * `research:deep_dive / regenerate_angles / status / brief_get / list_assets / import_asset`。
 *
 * 四条纪律：
 * 1. **投递即返回**：deep_dive 只把任务落进台账，绝不等四视角跑完（分钟级）。
 *    进度经 SSE `research` 流推回来，前端按 topicId 重读 status。
 * 2. **拒绝是拒绝，不是空成功**：搜索 key 未配 / 选题不存在 / 运行时没起来，
 *    一律 `{ok:false, error:人话}`——「点了没反应」是最坏的失败形态。
 *    （key 门在投递口 `triggerDeepResearch` 里，chat 工具与按钮共用同一句指引。）
 * 3. **「当前有效简报」只认 job.briefRevision 指针**（§2 重跑读语义）：重跑失败不回退指针，
 *    旧简报继续可读；brief_get 显式传 revision 时才绕开指针（回溯用）。
 * 4. **过期标注现算**：简报存的是生成时的 topicHash，与**当前**选题文本现算的 hash 比对——
 *    存下来的布尔会随选题被改而失真。
 */
import fs from "node:fs/promises";
import { getContent, getDataDir, getTopic, type Topic } from "../storage/local-store.js";
import { isContentId } from "../storage/entity-id.js";
import {
  loadBrief,
  type BriefAssetPick,
  type ResearchBrief,
} from "../modules/research/brief-store.js";
import {
  getResearchAsset,
  getResearchAssetFile,
  markResearchAssetImported,
  resolveAssetPath,
  type ResearchAsset,
} from "../modules/research/research-asset-store.js";
import {
  attachUploadedArticleImage,
  getArticleImageReview,
  type ArticleImageReview,
} from "../modules/publish/article-images.js";
import { getJob, topicHashOf } from "../modules/research/research-job-store.js";
import { resolveEffectiveBrief } from "../modules/research/brief-snapshot.js";
import { searchAvailable } from "../modules/research/search-provider.js";
import { emitEngineEvent } from "./event-hub.js";
import { triggerDeepResearch, triggerRegenerateAngles } from "./research-runtime.js";

type Payload = Record<string, unknown>;
type Reply = Record<string, unknown>;

const NO_BRIEF = "这条选题还没有可用简报——先点「深调研」跑一轮（四视角至少两路成功才会产简报）";

/** 简报元信息：选题卡只要这三样，全文走 brief_get */
export interface BriefMeta {
  revision: number;
  generatedAt: string;
  /** true = 简报基于旧版选题（标题/描述已改过），建议重跑（§2） */
  stale: boolean;
}

function badPayload(payload: Payload): Reply | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return null;
}

function fail(err: unknown): Reply {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** 深调研落在**当前工作区**（server 每次请求注入 _dataDir），不像收件箱那样钉死一个工作区 */
function researchDataDir(payload: Payload): string {
  return (payload._dataDir as string) || getDataDir();
}

function requireTopicId(payload: Payload): string | null {
  return typeof payload.topic_id === "string" && payload.topic_id.trim() ? payload.topic_id.trim() : null;
}

function warn(message: string): void {
  console.warn(`[research-handlers] ${message}`);
}

function briefMeta(brief: ResearchBrief, topic: Topic): BriefMeta {
  return {
    revision: brief.revision,
    generatedAt: brief.generatedAt,
    stale: brief.topicHash !== topicHashOf(topic.title, topic.description),
  };
}

/**
 * 当前有效简报。**唯一入口是 `resolveEffectiveBrief`**（P1 §3.0）：这里曾经有一份
 * 「读 job.briefRevision 再 loadBrief」的本地实现，规则同一条却是第二份代码——
 * 快照层后来加的「文件内版本与指针不符按无简报处理」这类判断就不会落到这条路上。
 */
async function currentBrief(topicId: string, dataDir: string): Promise<ResearchBrief | null> {
  const snapshot = await resolveEffectiveBrief(topicId, dataDir, warn);
  return snapshot?.brief ?? null;
}

/**
 * 投递一次深调研。透传 `TriggerResult`：
 * - `accepted:false` → `{ok:false, error:reason}`（key 未配、选题不存在/在回收站、
 *   运行时未起、**这条选题正在研究中**）
 * - `deduped:true` → 捡回了一条租约已过期的在册任务（跑它的进程死了），没有新开一轮
 */
export async function researchDeepDiveHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const topicId = requireTopicId(payload);
  if (!topicId) return { ok: false, error: "topic_id 必填" };
  try {
    const res = await triggerDeepResearch(topicId, researchDataDir(payload));
    if (!res.accepted) return { ok: false, error: res.reason };
    return {
      ok: true,
      data: {
        job: res.job,
        deduped: res.deduped,
        note: res.deduped
          ? "上一轮中断在半路，已把它捡回来重跑"
          : "已排队——四视角并行侦察，进度在选题卡上实时更新",
      },
    };
  } catch (err) {
    return fail(err);
  }
}

/**
 * 重新立意（P1 spec §3.5/§4.6）：在当前生效简报上只重跑立意 pass，落一版只换角度卡的新简报。
 * 回执形状与 deep_dive 一致（同一条投递语义，前端一套处理）；不出网，所以没有搜索 key 门。
 */
export async function researchRegenerateAnglesHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const topicId = requireTopicId(payload);
  if (!topicId) return { ok: false, error: "topic_id 必填" };
  try {
    const res = await triggerRegenerateAngles(topicId, researchDataDir(payload));
    if (!res.accepted) return { ok: false, error: res.reason };
    return {
      ok: true,
      data: {
        job: res.job,
        deduped: res.deduped,
        note: res.deduped
          ? "上一轮中断在半路，已把它捡回来重跑"
          : "已排队——只重跑立意，出新角度卡后会落一版新简报（事实不变）",
      },
    };
  } catch (err) {
    return fail(err);
  }
}

/**
 * 选题卡的状态读口：job 全量 + 搜索配置态（按钮禁用用）+ 当前有效简报元信息。
 * 选题不存在 → 拒（卡片本来就不该在，静默空态会让人以为「还没调研过」）。
 */
export async function researchStatusHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const topicId = requireTopicId(payload);
  if (!topicId) return { ok: false, error: "topic_id 必填" };
  try {
    const dataDir = researchDataDir(payload);
    const topic = await getTopic(topicId, dataDir);
    if (!topic) return { ok: false, error: `选题不存在：${topicId}` };
    const job = await getJob(topicId, dataDir);
    const brief = await currentBrief(topicId, dataDir);
    return {
      ok: true,
      data: {
        job,
        searchConfigured: await searchAvailable(dataDir),
        currentBrief: brief ? briefMeta(brief, topic) : null,
      },
    };
  } catch (err) {
    return fail(err);
  }
}

/** revision 只认正整数：字符串/小数/负数一律当没传，落回指针 */
function explicitRevision(payload: Payload): number | null {
  const v = payload.revision;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * 读一份完整简报。缺省取 `job.briefRevision`（当前有效那版）；
 * 显式传 revision 走不可变版本文件，供「这篇稿子当初用的哪版」回溯。
 */
export async function researchBriefGetHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const topicId = requireTopicId(payload);
  if (!topicId) return { ok: false, error: "topic_id 必填" };
  try {
    const dataDir = researchDataDir(payload);
    const job = await getJob(topicId, dataDir);
    const revision = explicitRevision(payload) ?? job?.briefRevision;
    if (revision === undefined || revision === null) return { ok: false, error: NO_BRIEF };
    const brief = await loadBrief(topicId, revision, dataDir, warn);
    if (!brief) return { ok: false, error: `简报 v${revision} 读不到（文件缺失或已损坏）——重跑一轮深调研` };
    const topic = await getTopic(topicId, dataDir);
    return { ok: true, data: { brief, ...(topic ? briefMeta(brief, topic) : {}) } };
  } catch (err) {
    return fail(err);
  }
}

/** 简报里的一条候选 + 落盘态；stored=false 的那些只有链接与降级原因 */
export interface ResearchAssetView extends BriefAssetPick {
  /** 有 assetId **且**文件确实在盘上——索引说有、文件没了就不算 stored */
  stored: boolean;
  width?: number;
  height?: number;
  /** 给前端取图的地址（只对 stored 的给） */
  fileUrl?: string;
}

/** 文件在不在要现查：索引是 append-only 的历史，磁盘才是当下 */
async function assetFileExists(asset: ResearchAsset, dataDir: string): Promise<boolean> {
  try {
    await fs.access(resolveAssetPath(asset.file, dataDir));
    return true;
  } catch {
    // 路径越界会抛（索引被污染）——同样按「这张不可用」处理，但不带走整个列表
    return false;
  }
}

async function toAssetView(pick: BriefAssetPick, dataDir: string): Promise<ResearchAssetView> {
  if (!pick.assetId) return { ...pick, stored: false };
  const asset = await getResearchAsset(pick.assetId, dataDir);
  if (!asset || !(await assetFileExists(asset, dataDir))) {
    return { ...pick, stored: false, downloadError: pick.downloadError ?? "素材文件已丢失，只剩链接" };
  }
  return {
    ...pick,
    stored: true,
    width: asset.width,
    height: asset.height,
    fileUrl: `/api/research-asset?asset_id=${encodeURIComponent(pick.assetId)}`,
  };
}

/**
 * 当前简报里的素材候选。R1b-B 起分两类：下载入库的（stored，可显缩略图、可导入配图）
 * 与降级为仅链接的（带 downloadError 说明为什么）。
 * 硬闸不变：素材绝不自动进正文，导入永远是人点出来的（§7）。
 */
export async function researchListAssetsHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const topicId = requireTopicId(payload);
  if (!topicId) return { ok: false, error: "topic_id 必填" };
  try {
    const dataDir = researchDataDir(payload);
    const brief = await currentBrief(topicId, dataDir);
    if (!brief) return { ok: false, error: NO_BRIEF };
    const picks: BriefAssetPick[] = brief.assetPicks ?? [];
    const assets = await Promise.all(picks.map((pick) => toAssetView(pick, dataDir)));
    return {
      ok: true,
      data: {
        revision: brief.revision,
        assets,
        total: assets.length,
        storedCount: assets.filter((a) => a.stored).length,
      },
    };
  } catch (err) {
    return fail(err);
  }
}

// ─── 配图导入（§7「放置即导入」）────────────────────────────────────────────

/** 没给 index 时的落点：第一个还没图的插图位。全满就报错，绝不替人挑一个覆盖掉 */
function resolveSlotIndex(payload: Payload, review: ArticleImageReview): number | string {
  const raw = payload.index;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return review.entries.some((e) => e.index === raw) ? raw : `正文配图 ${raw + 1} 不存在`;
  }
  if (review.entries.length === 0) return "这篇稿子还没有插图位——先在「正文配图」里加一个位置";
  const empty = review.entries.find((e) => e.status !== "ready");
  return empty ? empty.index : "所有插图位都已有图——点某一位的「研究素材」来指定要替换哪一张";
}

/**
 * 把一张研究素材导入为该稿件的正文配图。
 *
 * 三条纪律：
 * 1. **走既有承接口**：字节交给 `attachUploadedArticleImage`（与「用自己的图」同一条路），
 *    5MB / png-jpg 魔数 / 生成中不许顶这些校验一条不绕——webp 素材会在这里被如实拒绝。
 * 2. **幂等按「这一槽已经是这张图」判**：同一素材重复导同一位置 → 返回既有结果、不churn
 *    revision。**跨 content / 跨槽位不算重复**：一张图进两篇稿子是正当需求，不是误操作。
 * 3. **素材不属于这条选题就拒**：assetId 是全局的，topic_id 是调用方的断言，对不上说明
 *    界面串了选题——这时候静默照做会把别的选题的图塞进来。
 */
export async function researchImportAssetHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const topicId = requireTopicId(payload);
  if (!topicId) return { ok: false, error: "topic_id 必填" };
  const assetId = typeof payload.asset_id === "string" ? payload.asset_id.trim() : "";
  const contentId = typeof payload.content_id === "string" ? payload.content_id : "";
  if (!assetId) return { ok: false, error: "asset_id 必填" };
  if (!isContentId(contentId)) return { ok: false, error: "需要合法 content_id" };

  try {
    const dataDir = researchDataDir(payload);
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, error: `稿件不存在：${contentId}` };
    const asset = await getResearchAsset(assetId, dataDir);
    if (!asset) return { ok: false, error: `研究素材不存在：${assetId}` };
    if (asset.topicId !== topicId) {
      return { ok: false, error: "这张素材不属于该选题——刷新一下再试" };
    }
    return await importAssetToSlot(asset, contentId, payload, dataDir);
  } catch (err) {
    return fail(err);
  }
}

async function importAssetToSlot(
  asset: ResearchAsset,
  contentId: string,
  payload: Payload,
  dataDir: string,
): Promise<Reply> {
  const review = await getArticleImageReview(contentId, dataDir);
  const slot = resolveSlotIndex(payload, review);
  if (typeof slot === "string") return { ok: false, error: slot };

  const current = review.entries.find((e) => e.index === slot);
  if (current?.status === "ready" && current.sourceAssetId === asset.assetId) {
    return { ok: true, data: { review, index: slot, deduped: true, note: "这一位已经是这张素材了" } };
  }

  const file = await getResearchAssetFile(asset.assetId, dataDir);
  if (!file) return { ok: false, error: `研究素材文件不存在：${asset.assetId}` };
  const bytes = await fs.readFile(file).catch(() => null);
  if (!bytes) return { ok: false, error: "研究素材文件读不到（可能已被删除），请重跑深调研" };

  const updated = await attachUploadedArticleImage(contentId, slot, bytes, dataDir, {
    origin: "research",
    sourceAssetId: asset.assetId,
  });
  await markResearchAssetImported(asset.assetId, dataDir);
  void emitEngineEvent(
    { role: "publisher", kind: "work", label: `配图 ${slot + 1} 已换成深调研素材（来源需自查授权）`, contentId },
    dataDir,
  ).catch(() => {});
  return { ok: true, data: { review: updated, index: slot, deduped: false } };
}
