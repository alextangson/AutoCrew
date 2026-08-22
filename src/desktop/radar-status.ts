/**
 * 侦察员情报源的引擎侧（S2.6 → IA v4.2 §A1 可配置化）— 源清单读写 + 缓存状态 + 手动刷新。
 * 源清单用户级可配置（radar-sources.json），url 出境给管理 UI 编辑用（本地单用户）。
 */
import { loadTopicCache, refreshTopicRadar, refreshTopicRadarIfStale, loadRadarSources, saveRadarSources, type RadarSource } from "../modules/radar/topic-radar.js";
import { intakeRadarTopics, rescoreExistingTopics } from "../modules/radar/radar-intake.js";

export async function getRadarStatus(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const [cache, sources] = await Promise.all([loadTopicCache(dataDir), loadRadarSources(dataDir)]);
    return {
      ok: true,
      data: {
        sources,
        fetchedAt: cache?.fetchedAt ?? null,
        itemCount: cache?.items.length ?? 0,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 保存用户源清单（IA v4.2 §A1）。保存后不自动扫榜——扫榜是显式动作,UI 提示即可 */
export async function setRadarSources(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  if (!Array.isArray(payload.sources)) {
    return { ok: false, error: "sources 必须是数组" };
  }
  try {
    const saved = await saveRadarSources(payload.sources as RadarSource[], (payload._dataDir as string) || undefined);
    return { ok: true, data: { sources: saved } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function doRadarRefresh(
  payload: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const result = await refreshTopicRadar(dataDir, fetchImpl ?? globalThis.fetch);
    if (!result.ok) {
      return { ok: false, error: "全部热榜源拉取失败（网络或源不可用），稍后再试" };
    }
    // 刷新后立即入库（IA v4.2 §A1）——intake 尽力而为，失败不拖垮扫榜本身
    let intakeCount = 0;
    try {
      intakeCount = (await intakeRadarTopics(dataDir)).saved.length;
    } catch { /* best-effort */ }
    return {
      ok: true,
      data: { itemCount: result.itemCount, failedSources: result.failedSources, intakeCount },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 看板「再找一批」：刷新源后只从从未看过的候选继续取，已删除项也不会回流。 */
export async function collectMoreRadarTopics(
  payload: Record<string, unknown>,
  fetchImpl?: typeof fetch,
  deps?: {
    refreshImpl?: typeof refreshTopicRadar;
    /** 枯竭时的强制真刷新(绕开 TTL 门) */
    forceRefreshImpl?: typeof refreshTopicRadar;
    intakeImpl?: typeof intakeRadarTopics;
  },
): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const dataDir = (payload._dataDir as string) || undefined;
  const limit = Math.max(1, Math.min(Number(payload.limit) || 5, 10));
  const fetcher = fetchImpl ?? globalThis.fetch;
  const intakeOnce = () => (deps?.intakeImpl ?? intakeRadarTopics)(dataDir, { limit, poolSize: 24 });
  try {
    let refresh: (Awaited<ReturnType<typeof refreshTopicRadar>> & { skippedFresh?: boolean }) | null = null;
    if (payload.refresh !== false) {
      // TTL 门:缓存新鲜就不打源(付费 X 按请求计费)——「再找一批」的增量本来就来自缓存里的未看候选
      refresh = await (deps?.refreshImpl ?? refreshTopicRadarIfStale)(dataDir, fetcher);
    }
    let intake = await intakeOnce();
    // 缓存内候选被 7 天落选记忆吃干净时,这个按钮点了永远 0 结果,用户只会以为雷达坏了。
    // 缓存没变(skippedFresh)且这轮零产出 → 绕开 TTL 真打一次源:多烧的付费额度是用户
    // 显式点击换来的,按钮必须有真语义。
    if (refresh?.skippedFresh && intake.saved.length === 0 && intake.qualified === 0) {
      refresh = { ...(await (deps?.forceRefreshImpl ?? refreshTopicRadar)(dataDir, fetcher)), skippedFresh: false };
      intake = await intakeOnce();
    }
    return {
      ok: true,
      data: {
        topics: intake.saved,
        savedCount: intake.saved.length,
        qualified: intake.qualified,
        skippedDuplicates: intake.skippedDuplicates,
        filter: intake.filter,
        refreshedItems: refresh?.itemCount ?? null,
        failedSources: refresh?.failedSources ?? [],
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 给当前英文/旧格式选题补中文标题、100 分制评分、摘要和可写角度。 */
export async function rescoreRadarTopics(
  payload: Record<string, unknown>,
  deps?: { rescoreImpl?: typeof rescoreExistingTopics },
): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const result = await (deps?.rescoreImpl ?? rescoreExistingTopics)((payload._dataDir as string) || undefined);
    return { ok: true, data: { topics: result.updated, updatedCount: result.updated.length, examined: result.examined } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
