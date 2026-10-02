/**
 * 「先不配」持久化（spec §2.1，O1）：存本机目录，刷新、重启都不再弹。
 * 读不到 / 读不懂 = 没点过（引导会再出现一次，比把人永远挡在外面安全）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getHostStateDir } from "../../storage/storage-roots.js";

const FILE = "onboarding.json";

export function onboardingFile(dataDir?: string): string {
  return path.join(getHostStateDir(dataDir), FILE);
}

export function readOnboardingSkipped(dataDir?: string): boolean {
  try {
    return Boolean((JSON.parse(readFileSync(onboardingFile(dataDir), "utf-8")) as { skippedAt?: unknown }).skippedAt);
  } catch {
    return false;
  }
}

/** 原子写；失败抛给调用方变成可见状态 */
export function writeOnboardingSkipped(skipped: boolean, dataDir?: string, now = new Date()): void {
  const file = onboardingFile(dataDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(skipped ? { skippedAt: now.toISOString() } : {})}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
