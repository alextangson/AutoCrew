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
/** 锁外在途的一次读页（P6 §3.7）：锁内已预扣额度，合并时按它认领；进程崩了留下的由过期清掉 */
export interface HostPageRead {
  id: string;
  perspective: string;
  url: string;
  /** 规范化 URL：同一页同时只许一次在途，后到的等它入账后直接命中缓存 */
  key: string;
  pid: number;
  at: string;
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
  /** 锁外在途的读页（同选题至多 4 个）；入账或失败时移除 */
  pageReads?: HostPageRead[];
  /** 分视角认领（选题会规则 2）：每个视角各自一份令牌，主会话可以把视角派给并行的子代理 */
  perspectiveClaims?: Partial<Record<PerspectiveName, PerspectiveClaim>>;
  /** 失败/超时放弃的视角：明摆在回执里，可单独重领重跑，不静默跳过 */
  perspectiveFailures?: Partial<Record<PerspectiveName, { reason: string; at: string; by: string }>>;
  /** 第五路「账号数据」视角：由排期会简报确定性生成，不调模型 */
  accountData?: AccountDataPerspective;
  /** 持有者闲置超 30 分钟被接管的记录：旧持有者的迟到写入据此回 lease_lost */
  takeovers?: Array<{ from: string; to: string; at: string }>;
}

export interface PerspectiveClaim { token: string; host: string; claimedAt: string; touchedAt: string }
export interface AccountDataPerspective { status: "ok" | "failed"; summary?: string; reason?: string; builtAt: string }

export class HostResearchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 随错误一起回给宿主的机读字段（retry_after_seconds、holder…） */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
/** 活着的持有者只让后来者稍等：读页的锁内两段都是毫秒级，等不到才回 task_busy */
const LOCK_WAIT_MS = 1_500;
const BUSY = { retry_after_seconds: 2 };
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
/** 持有进程是否还活着（租约与在途读页共用；查不到权限的进程按活着算，绝不误抢） */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type Lease = { pid: number; token: string; at: string };
type Acquired = { handle: Awaited<ReturnType<typeof fs.open>>; recoveryFile?: string };

async function acquireLease(dir: string, file: string, lease: Lease): Promise<Acquired> {
  try {
    return { handle: await fs.open(file, "wx") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    // 持有者恰好在 EEXIST 与读取之间放了锁：不是故障，下一轮重试就能拿到
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HostResearchError("task_busy", "研究租约刚刚释放，请重试", BUSY);
    throw err;
  }
  let previous: { pid: number; token: string };
  try {
    previous = JSON.parse(raw);
  } catch {
    throw new HostResearchError("task_busy", "研究任务正在取得租约，请稍后重试", BUSY);
  }
  if (processAlive(previous.pid))
    throw new HostResearchError("task_busy", "同选题另一次研究操作尚未完成，请稍后重试同一调用", BUSY);
  // Serialize stale-owner recovery too: two recoverers must never rename a fresh live lease.
  const recoveryFile = path.join(dir, "lease-recovery.json");
  let recovery: Awaited<ReturnType<typeof fs.open>>;
  try {
    recovery = await fs.open(recoveryFile, "wx");
  } catch {
    throw new HostResearchError(
      "task_busy",
      "研究租约正在恢复；如恢复进程也已中断，需检查lease-recovery记录后再恢复，不能强抢活跃调用",
      BUSY,
    );
  }
  try {
    await recovery.writeFile(JSON.stringify(lease));
    await recovery.close();
    const latest = await json<{ pid: number; token: string }>(file);
    if (latest?.token !== previous.token || processAlive(latest.pid))
      throw new HostResearchError("task_busy", "研究租约已由另一进程恢复，请稍后重试", BUSY);
    await fs.rm(file);
    return { handle: await fs.open(file, "wx"), recoveryFile };
  } catch (error) {
    await recovery.close().catch(() => undefined);
    await fs.rm(recoveryFile, { force: true });
    throw error;
  }
}

/** 撞上活租约不立刻失败：退避重试到 LOCK_WAIT_MS，仍拿不到才把 task_busy 交回宿主 */
async function acquireWithin(dir: string, file: string, lease: Lease): Promise<Acquired> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let delay = 10; ; delay = Math.min(delay * 2, 120)) {
    try {
      return await acquireLease(dir, file, lease);
    } catch (err) {
      const busy = err instanceof HostResearchError && err.code === "task_busy";
      if (!busy || Date.now() + delay > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * delay));
    }
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
  const { handle, recoveryFile } = await acquireWithin(dir, file, lease);
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
