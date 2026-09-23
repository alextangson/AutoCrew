/** Durable host-authored research. No model execution; every mutation is fenced by task and lease. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isTopicId } from "../../storage/entity-id.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import type { CreatorProfile } from "../profile/creator-profile.js";
import type { CreativeTask } from "../writing/creative-task.js";
import type { PerspectiveOutput, ResearchBrief } from "./brief-store.js";
import type { OwnMaterial } from "./own-material.js";
import type { ResearchBrokerSnapshot } from "./research-broker.js";
import type { PerspectiveName } from "./research-job-store.js";

export interface HostOfflineClaim {
  id: string;
  claim: string;
  quote: string;
  reason: string;
  source: "user_claim";
  at: string;
}
export interface HostCitation {
  id: string;
  sourceId: string;
  claim: string;
  quote: string;
  sourceUrl: string;
  fetchedAt: string;
  source: "verified_quote";
}
export interface HostResearchTask {
  version: 1;
  taskId: string;
  host: string;
  topicId: string;
  topicHash: string;
  topic: { title: string; description: string };
  creativeTask: CreativeTask;
  status: "researching" | "needs_angles" | "ready";
  createdAt: string;
  updatedAt: string;
  broker: ResearchBrokerSnapshot;
  profile: CreatorProfile | null;
  ownMaterial: OwnMaterial;
  perspectives: Partial<Record<PerspectiveName, PerspectiveOutput>>;
  citations: HostCitation[];
  offlineClaims: HostOfflineClaim[];
  submissionHashes: Record<string, string>;
  /** Saved before publishing; permits crash recovery without allocating another revision. */
  brief?: ResearchBrief;
  briefRevision?: number;
}

export class HostResearchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const TASK_ID = /^rt-[a-f0-9-]{36}$/;
function directory(topicId: string, dataDir: string): string {
  if (!isTopicId(topicId)) throw new HostResearchError("invalid_topic", "topic_id 格式无效");
  return path.join(dataDir, "research", "host-tasks", topicId);
}
async function json<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
export async function inspectHostResearchTask(topicId: string, dataDir: string): Promise<HostResearchTask | null> {
  const dir = directory(topicId, dataDir);
  const pointer = await json<{ taskId: string }>(path.join(dir, "current.json"));
  if (!pointer) return null;
  if (!TASK_ID.test(pointer.taskId)) throw new HostResearchError("task_corrupt", "研究任务指针损坏，未忽略来源记录");
  const task = await json<HostResearchTask>(path.join(dir, `${pointer.taskId}.json`));
  if (!task || task.version !== 1 || task.taskId !== pointer.taskId || task.topicId !== topicId)
    throw new HostResearchError("task_corrupt", "研究任务快照损坏或缺失，不能冒充空任务重新开始");
  return task;
}
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** One topic lease across processes. A live owner is never expired merely for being slow. */
export async function withHostResearchLock<T>(
  topicId: string,
  dataDir: string,
  work: (task: HostResearchTask | null, save: (task: HostResearchTask) => Promise<void>) => Promise<T>,
): Promise<T> {
  const dir = directory(topicId, dataDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "lease.json");
  const token = crypto.randomUUID();
  const lease = { pid: process.pid, token, at: new Date().toISOString() };
  let recoveryFile: string | undefined;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const raw = await fs.readFile(file, "utf-8");
    let previous: { pid: number; token: string };
    try {
      previous = JSON.parse(raw);
    } catch {
      throw new HostResearchError("task_busy", "研究任务正在取得租约，请稍后重试");
    }
    if (processAlive(previous.pid))
      throw new HostResearchError("task_busy", "同选题另一次研究操作尚未完成，请稍后重试同一调用");
    // Serialize stale-owner recovery too: two recoverers must never rename a fresh live lease.
    recoveryFile = path.join(dir, "lease-recovery.json");
    let recovery: Awaited<ReturnType<typeof fs.open>>;
    try {
      recovery = await fs.open(recoveryFile, "wx");
    } catch {
      throw new HostResearchError(
        "task_busy",
        "研究租约正在恢复；如恢复进程也已中断，需检查lease-recovery记录后再恢复，不能强抢活跃调用",
      );
    }
    try {
      await recovery.writeFile(JSON.stringify(lease));
      await recovery.close();
      const latest = await json<{ pid: number; token: string }>(file);
      if (latest?.token !== previous.token || processAlive(latest.pid))
        throw new HostResearchError("task_busy", "研究租约已由另一进程恢复，请稍后重试");
      await fs.rm(file);
      handle = await fs.open(file, "wx");
    } catch (error) {
      await recovery.close().catch(() => undefined);
      await fs.rm(recoveryFile, { force: true });
      throw error;
    }
  }
  try {
    await handle.writeFile(JSON.stringify(lease));
    await handle.sync();
    await handle.close();
    if (recoveryFile) await fs.rm(recoveryFile, { force: true });
    const save = async (task: HostResearchTask) => {
      if (!TASK_ID.test(task.taskId) || task.topicId !== topicId)
        throw new HostResearchError("invalid_task", "任务身份不匹配");
      const owner = await json<{ token: string }>(file);
      if (owner?.token !== token) throw new HostResearchError("lease_lost", "研究操作的租约已失效，迟到结果未写入");
      task.updatedAt = new Date().toISOString();
      await writeJsonAtomic(path.join(dir, `${task.taskId}.json`), task);
      await writeJsonAtomic(path.join(dir, "current.json"), { taskId: task.taskId });
    };
    return await work(await inspectHostResearchTask(topicId, dataDir), save);
  } finally {
    await handle.close().catch(() => undefined);
    const owner = await json<{ token: string }>(file).catch(() => null);
    if (owner?.token === token) await fs.rm(file, { force: true });
  }
}
