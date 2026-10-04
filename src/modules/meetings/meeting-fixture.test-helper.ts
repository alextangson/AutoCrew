/** 选题会测试的临时资料库：项目布局齐（发布计划要靠它定位），全在 tmp，不碰真实资料库 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { initializeProjectLayout, resolveContentProject } from "../../storage/content-project.js";
import { acquireLibraryLock } from "../../storage/library-lock.js";
import { getContent, saveContent, saveTopic, type Content, type ContentStatus } from "../../storage/local-store.js";
import { commitProjectContent } from "../../storage/project-commit.js";
import type { PerformanceOutcome } from "../flywheel/outcome-schema.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

export interface Fixture { temp: string; data: string; release: () => void }

export async function makeFixture(): Promise<Fixture> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-meeting-"));
  const machine = path.join(temp, "machine");
  const lib = path.join(temp, "library");
  const data = path.join(lib, "workspaces/default");
  vi.stubEnv("AUTOCREW_LOCAL_DIR", machine);
  await fs.mkdir(machine, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(machine, "storage.json"), JSON.stringify({ version: 1, id: "lib-deadbeef", root: lib }));
  await fs.writeFile(path.join(lib, "autocrew-library.json"), JSON.stringify({ version: 1, id: "lib-deadbeef" }));
  const release = acquireLibraryLock(lib);
  await initializeProjectLayout(data, "lib-deadbeef", "default");
  return { temp, data, release };
}

export async function dropFixture(f: Fixture): Promise<void> {
  f.release();
  vi.unstubAllEnvs();
  await fs.rm(f.temp, { recursive: true, force: true });
}

export async function makeContent(data: string, title: string, patch: Partial<Content> = {}, status: ContentStatus = "published"): Promise<Content> {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title, body: `${title} 正文`, platform: "douyin", status: "drafting", tags: [] }, data);
  const next = { ...(await getContent(c.id, data))!, status, ...patch };
  await commitProjectContent(next, data);
  return next;
}

export async function writePlan(data: string, contentId: string, platforms: Array<{ platform: string; title: string; scheduled_at: string }>): Promise<void> {
  const root = resolveContentProject(contentId, data)!.project_root;
  await fs.mkdir(path.join(root, "06-publish"), { recursive: true });
  await fs.writeFile(path.join(root, "06-publish/publish-plan.json"), JSON.stringify({ platforms }));
}

export async function makeTopic(data: string, title: string) {
  return saveTopic({ title, description: `${title} 描述`, tags: [] }, data);
}

export const row = (patch: Partial<PerformanceOutcome>): PerformanceOutcome => ({
  contentId: null, platform: "douyin", platformTitle: "作品", publishedAt: "2026-08-01T20:00:00+08:00", metricDate: "2026-09-26",
  metrics: { views: 1000 }, source: "csv", recordedAt: "2026-09-26T00:00:00Z", needsReview: false, reviewReasons: [], ...patch,
});

export async function writePull(data: string, platforms: Record<string, { enabled: boolean; lastSuccessAt: string | null }>): Promise<void> {
  const base = { lastAttemptAt: null, nextEligibleAt: null, failureCount: 0, failureDate: null, lastStatus: "never", autoAttemptDate: null, autoAttemptCount: 0 };
  const all = Object.fromEntries(["douyin", "wechat_video", "xiaohongshu"].map((p) => [p, { ...base, ...(platforms[p] ?? { enabled: false, lastSuccessAt: null }) }]));
  await fs.writeFile(path.join(data, "metrics-pull.json"), JSON.stringify({ schemaVersion: 1, platforms: all }));
}
