/**
 * 侦察员工作档案的引擎侧（S2.6）— 热榜源清单 + 缓存状态 + 手动刷新。
 * 源 url 不外露给 renderer（无展示需求即不出境）。
 */
import { loadTopicCache, refreshTopicRadar } from "../modules/radar/topic-radar.js";
import { intakeRadarTopics } from "../modules/radar/radar-intake.js";
import sourcesJson from "../data/topic-sources.json";

interface RadarSourceMeta {
  id: string;
  name: string;
  tracks: string[];
}

function publicSources(): RadarSourceMeta[] {
  return (sourcesJson as { sources: Array<RadarSourceMeta & { url: string }> }).sources.map(
    ({ id, name, tracks }) => ({ id, name, tracks }),
  );
}

export async function getRadarStatus(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const cache = await loadTopicCache((payload._dataDir as string) || undefined);
    return {
      ok: true,
      data: {
        sources: publicSources(),
        fetchedAt: cache?.fetchedAt ?? null,
        itemCount: cache?.items.length ?? 0,
      },
    };
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
