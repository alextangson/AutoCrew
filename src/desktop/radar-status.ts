/**
 * 侦察员情报源的引擎侧（S2.6 → IA v4.2 §A1 可配置化）— 源清单读写 + 缓存状态 + 手动刷新。
 * 源清单用户级可配置（radar-sources.json），url 出境给管理 UI 编辑用（本地单用户）。
 */
import { loadTopicCache, refreshTopicRadar, loadRadarSources, saveRadarSources, type RadarSource } from "../modules/radar/topic-radar.js";
import { intakeRadarTopics } from "../modules/radar/radar-intake.js";

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
