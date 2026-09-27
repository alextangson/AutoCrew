/**
 * 「成片待审」卡（P6 §13.4-F 成片第 3 步）：成片在剪映里审，网页不播，只给创始人核对这几样——
 * 文件名、时长、导出时间、剪映草稿名、指纹前 8 位。挪进项目之后同一张卡照样用（那时页面可播）。
 *
 * 读卡不重算哈希（GB 级成片每 15 秒刷一次看板）：只比 report 时记下的大小和修改时间，
 * 不一致就标「导出文件变了」。批准那一下服务端才当场重算 sha256（founder-review.ts）。
 * 时长走可注入的 ffprobe（测试换假的）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { probeMedia } from "../ingest.js";
import { finalCutArtifact } from "./gate-state.js";
import { resolveReportedFile } from "./jianying-root.js";
import type { ArtifactEntry, StoredExecution } from "./execution-index.js";

export type DurationProbe = (file: string) => Promise<number | null>;
const ffprobeDuration: DurationProbe = async (file) => {
  const probed = await probeMedia(file);
  return probed.ok && probed.probe.durationMs > 0 ? probed.probe.durationMs : null;
};
let probe: DurationProbe = ffprobeDuration;
/** 测试专用：换掉 ffprobe；传 null 复位 */
export function setFinalCutProbe(fn: DurationProbe | null): void { probe = fn ?? ffprobeDuration; }

export interface FinalCutCard {
  path: string; name: string; sha256: string; sha8: string; role: string;
  /** 项目外 = 还在剪映导出目录，页面不播 */
  external: boolean;
  duration_ms: number | null; exported_at: string | null; jianying_draft: string | null;
  /** 文件不见了（挪走了还没 report 新位置 / 被删了） */
  missing: boolean;
  /** 大小或修改时间和 report 时不一致：导出被覆盖过 */
  changed: boolean;
}

function changedSince(entry: ArtifactEntry, st: { size: number; mtimeMs: number }): boolean {
  if (entry.size === undefined || entry.mtime_ms === undefined) return false;
  return st.size !== entry.size || Math.trunc(st.mtimeMs) !== entry.mtime_ms;
}

export async function finalCutCard(execution: StoredExecution | null, projectRoot: string, dataDir: string): Promise<FinalCutCard | null> {
  const entry = finalCutArtifact(execution?.artifacts ?? [], execution?.generation);
  if (!entry) return null;
  const base = { path: entry.path, name: path.basename(entry.path), sha256: entry.sha256, sha8: entry.sha256.slice(0, 8), role: entry.role,
    external: entry.external === "jianying", jianying_draft: execution?.jianying_draft ?? null };
  const at = await resolveReportedFile(entry.path, projectRoot, entry.role, dataDir);
  const st = at.ok ? await fs.stat(at.value.file).catch(() => null) : null;
  if (!at.ok || !st) return { ...base, duration_ms: null, exported_at: null, missing: true, changed: false };
  return { ...base, duration_ms: await probe(at.value.file).catch(() => null), exported_at: st.mtime.toISOString(), missing: false, changed: changedSince(entry, st) };
}
