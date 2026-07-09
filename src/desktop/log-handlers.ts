/**
 * 工作日志频道 handlers(V5.6 可观测性):运行日志列表/单 run 明细/团队技能一览。
 */
import { listRuns, readRun } from "../runtime/run-log.js";
import { listSkills } from "./skills-reader.js";

type Payload = Record<string, unknown>;

function badPayload(payload: Payload): { ok: false; error: string } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return null;
}

export async function logsListHandler(payload: Payload): Promise<Record<string, unknown>> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    const limit = typeof payload.limit === "number" && payload.limit > 0 ? Math.min(payload.limit, 200) : 50;
    const runs = await listRuns((payload._dataDir as string) || undefined, limit);
    return { ok: true, data: { runs } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function logsGetRunHandler(payload: Payload): Promise<Record<string, unknown>> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const runId = payload.run_id;
  if (typeof runId !== "string" || !runId.trim()) return { ok: false, error: "run_id is required" };
  try {
    const records = await readRun((payload._dataDir as string) || undefined, runId);
    return { ok: true, data: { records } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function skillsListHandler(payload: Payload): Promise<Record<string, unknown>> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    return { ok: true, data: { skills: await listSkills() } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
