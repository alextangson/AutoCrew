/**
 * 深调研 IPC handlers（deep-research spec §8）：
 * `research:deep_dive / status / brief_get / list_assets`。
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
import { getDataDir, getTopic, type Topic } from "../storage/local-store.js";
import {
  loadBrief,
  type BriefAssetPick,
  type ResearchBrief,
} from "../modules/research/brief-store.js";
import { getJob, topicHashOf, type ResearchJob } from "../modules/research/research-job-store.js";
import { searchAvailable } from "../modules/research/search-provider.js";
import { triggerDeepResearch } from "./research-runtime.js";

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

/** 当前有效简报 = job.briefRevision 指向的那一份；没有 job / 没有指针 / 文件坏了都算「没有」 */
async function loadCurrentBrief(job: ResearchJob | null, dataDir: string): Promise<ResearchBrief | null> {
  if (!job || job.briefRevision === undefined) return null;
  return loadBrief(job.topicId, job.briefRevision, dataDir, warn);
}

/**
 * 投递一次深调研。透传 `TriggerResult`：
 * - `accepted:false` → `{ok:false, error:reason}`（key 未配、选题不存在/在回收站、运行时未起）
 * - `deduped:true` → 已有任务在跑，返回的是**进行中那个** job，不重复排队
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
          ? "这条选题已有调研在跑，本次合并到进行中的任务"
          : "已排队——四视角并行侦察，进度在选题卡上实时更新",
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
    const brief = await loadCurrentBrief(job, dataDir);
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

/**
 * 当前简报里的素材候选（R1a 只到链接级：不下载，给 URL + 来源页 + caption）。
 * 硬闸在别处：candidate 素材绝不自动进正文（§7）。
 */
export async function researchListAssetsHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const topicId = requireTopicId(payload);
  if (!topicId) return { ok: false, error: "topic_id 必填" };
  try {
    const dataDir = researchDataDir(payload);
    const job = await getJob(topicId, dataDir);
    const brief = await loadCurrentBrief(job, dataDir);
    if (!brief) return { ok: false, error: NO_BRIEF };
    const assets: BriefAssetPick[] = brief.assetPicks ?? [];
    return { ok: true, data: { revision: brief.revision, assets, total: assets.length } };
  } catch (err) {
    return fail(err);
  }
}
