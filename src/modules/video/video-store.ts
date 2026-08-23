/**
 * 视频生产线存储层（设计 spec §2.1 / §2.3 / §2.6 / §3）。
 *
 * 落点：
 *   contents/<contentId>/video/
 *     state.json                 全量构建状态（原子写 + 逐 content 串行队列）
 *     transcript.v<N>.json       不可变 ASR 事实
 *     cut.v<M>.json              剪辑决策
 *     timeline.v<K>.json         组装结果
 *     render-manifest.v<K>.json  渲染冻结点
 *     assets.json                素材清单
 *     assets/                    本线生成物（AI 镜头、程序化画面等）
 *   video/jobs.jsonl             append-only 任务台账
 *
 * 三条纪律：
 * 1. **视频状态不进 Content**（§2.1）：`updateContent` 非原子读改写会互相覆盖，
 *    worker / 人工确认 / 旧渲染回调并发写必丢更新。本模块自持状态并自己保证原子。
 * 2. **版本化产物不可变**：`writeVersioned` 目标已存在直接拒绝——旧 revision 是审计凭证，
 *    「改稿两轮」的链路一致性全靠它，覆盖一次就再也说不清成片是按哪版剪的。
 * 3. **dataDir 由调用方传入**：runner 绑定的是某个工作区，不跟随「当前工作区」。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isContentId, isSafeFilename } from "../../storage/entity-id.js";
import { readJson, writeJsonAtomic } from "../../storage/json-atomic.js";
import { getAsset } from "../../storage/library-store.js";
import { assertTransition, type VideoStateRef } from "./state-machine.js";
import type { AssetRef, VideoAssetEntry, VideoEditUnits, VideoJob, VideoState } from "./types.js";

/** lease 10 分钟；心跳 60 秒续租（§3）。过期即可回收，避免跨进程重复渲染 */
export const VIDEO_LEASE_MS = 10 * 60_000;
export const VIDEO_HEARTBEAT_MS = 60_000;

/** 未开工时的隐含起点：没有 state.json 等价于站在 ingest/idle */
const GENESIS: VideoStateRef = { phase: "ingest", state: "idle" };

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function contentRoot(dataDir: string, contentId: string): string {
  if (!isContentId(contentId)) throw new Error(`非法 contentId：${String(contentId)}`);
  return path.join(dataDir, "contents", contentId);
}

export function videoDir(dataDir: string, contentId: string): string {
  return path.join(contentRoot(dataDir, contentId), "video");
}

/** 本线生成物落这里（AI 镜头 / 程序化画面），与稿件既有 assets/ 分开 */
export function videoAssetsDir(dataDir: string, contentId: string): string {
  return path.join(videoDir(dataDir, contentId), "assets");
}

export function videoJobsPath(dataDir: string): string {
  return path.join(dataDir, "video", "jobs.jsonl");
}

// ---------------------------------------------------------------------------
// 逐 content 串行队列（§2.1）
// ---------------------------------------------------------------------------

const writeQueues = new Map<string, Promise<unknown>>();

/**
 * 同一个 content 的写入排队执行，跨 content 并行。管线各步骤共用这一把锁，
 * 「读-改-写」才不会被另一个写入者插队（chat-persist 同款链式队列）。
 *
 * 前一步失败不许卡住后一步：链上挂 then(task, task)。
 */
export function serializeVideoWrite<T>(contentId: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(contentId) ?? Promise.resolve();
  const next = prev.then(task, task);
  writeQueues.set(contentId, next);
  // 链尾清理，防 Map 无界增长；用 then(cleanup, cleanup) 而非 finally()——
  // finally 会派生一个新 promise 并重新抛出 next 的 reason，没人接就是 unhandledRejection
  const cleanup = () => {
    if (writeQueues.get(contentId) === next) writeQueues.delete(contentId);
  };
  next.then(cleanup, cleanup);
  return next;
}

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

/** 读结果：损坏/未来版本一律「视为无状态 + 带可见告警」，绝不崩掉整条管线 */
export interface VideoStateRead {
  state: VideoState | null;
  warning?: string;
}

function stateFile(dataDir: string, contentId: string): string {
  return path.join(videoDir(dataDir, contentId), "state.json");
}

function stateRef(state: VideoState): VideoStateRef {
  return { phase: state.phase, state: state.state };
}

export async function readVideoState(dataDir: string, contentId: string): Promise<VideoStateRead> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile(dataDir, contentId), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { state: null };
    return { state: null, warning: `视频状态读取失败：${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: null, warning: "视频状态文件已损坏（JSON 解析失败），已按「尚未开始」处理" };
  }
  return interpretState(parsed);
}

function interpretState(parsed: unknown): VideoStateRead {
  if (typeof parsed !== "object" || parsed === null) {
    return { state: null, warning: "视频状态文件内容不是对象，已按「尚未开始」处理" };
  }
  const candidate = parsed as Partial<VideoState>;
  if (candidate.schemaVersion !== 1) {
    return {
      state: null,
      warning: `视频状态文件的 schemaVersion=${String(candidate.schemaVersion)} 本版本不认识（当前只支持 1），已按「尚未开始」处理`,
    };
  }
  if (typeof candidate.phase !== "string" || typeof candidate.state !== "string") {
    return { state: null, warning: "视频状态文件缺少 phase/state 字段，已按「尚未开始」处理" };
  }
  return { state: { ...(candidate as VideoState), revisions: candidate.revisions ?? {} } };
}

async function writeStateUnlocked(dataDir: string, contentId: string, next: VideoState): Promise<void> {
  const dir = videoDir(dataDir, contentId);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "state.json"), next);
}

/** 迁移闸门：当前无状态时按 ingest/idle 起算——凭空跳到管线中段也会被拦下 */
async function guardedWrite(dataDir: string, contentId: string, next: VideoState): Promise<VideoState> {
  const { state: current } = await readVideoState(dataDir, contentId);
  assertTransition(current ? stateRef(current) : GENESIS, stateRef(next));
  await writeStateUnlocked(dataDir, contentId, next);
  return next;
}

/**
 * 直写（调用方自备完整状态与 updatedAt）。仍然过迁移闸门与串行队列——
 * 没有「绕过校验的快捷写法」这种东西。
 */
export function writeVideoState(
  dataDir: string,
  contentId: string,
  next: VideoState,
): Promise<VideoState> {
  return serializeVideoWrite(contentId, () => guardedWrite(dataDir, contentId, next));
}

/**
 * 管线用的高层入口：读-改-写在同一个临界区里完成，mutator 拿到的一定是最新状态。
 * `updatedAt` 由本函数盖，调用方不用管（也盖不准——它不知道自己排队排了多久）。
 */
export function transitionVideoState(
  dataDir: string,
  contentId: string,
  mutator: (current: VideoState | null) => VideoState,
): Promise<VideoState> {
  return serializeVideoWrite(contentId, async () => {
    const { state: current } = await readVideoState(dataDir, contentId);
    const next: VideoState = { ...mutator(current), updatedAt: new Date().toISOString() };
    assertTransition(current ? stateRef(current) : GENESIS, stateRef(next));
    await writeStateUnlocked(dataDir, contentId, next);
    return next;
  });
}

export interface VideoTransitionWithEffect {
  next: VideoState;
  /** 状态提交前必须完成的副作用；失败时 state.json 保持原样 */
  beforeCommit: () => Promise<void>;
}

/**
 * 把「校验当前状态 → 完成产物落位 → 提交新状态」放进同一条 content 写队列。
 * 产物落位失败时绝不推进 state.json；跨进程旧 worker 仍由 runner 的 lease/CAS 拦截。
 */
export function transitionVideoStateWithEffect(
  dataDir: string,
  contentId: string,
  prepare: (current: VideoState | null) => VideoTransitionWithEffect,
): Promise<VideoState> {
  return serializeVideoWrite(contentId, async () => {
    const { state: current } = await readVideoState(dataDir, contentId);
    const prepared = prepare(current);
    const next: VideoState = { ...prepared.next, updatedAt: new Date().toISOString() };
    assertTransition(current ? stateRef(current) : GENESIS, stateRef(next));
    await prepared.beforeCommit();
    await writeStateUnlocked(dataDir, contentId, next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// 版本化不可变产物
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function versionedName(base: string, revision: number): string {
  return `${base}.v${revision}.json`;
}

/**
 * 写一版不可变产物。目标已存在 → 拒绝（不是覆盖，也不是静默成功）。
 *
 * 用 `link` 而不是 `rename` 落位：rename 会无声覆盖，link 遇到已存在直接 EEXIST，
 * 「不可覆盖」这条纪律因此是原子的，两个进程同时写同一 revision 也只有一个能赢。
 */
export async function writeVersioned(
  dir: string,
  base: string,
  revision: number,
  data: unknown,
): Promise<string> {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`revision 必须是 ≥1 的整数，当前是 ${String(revision)}`);
  }
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, versionedName(base, revision));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  try {
    await fs.link(tmp, target);
  } catch (err) {
    if ((err as { code?: string }).code === "EEXIST") {
      throw new Error(`${versionedName(base, revision)} 已存在：版本化产物不可覆盖，请写下一个 revision`);
    }
    throw err;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return target;
}

export function readVersioned<T>(dir: string, base: string, revision: number): Promise<T | null> {
  return readJson<T>(path.join(dir, versionedName(base, revision)));
}

/**
 * 剪辑单元表（粗剪 spec §4），与 cut 同版本号。**消费方一律经这里读**：
 * 拿不到（V0a 时期的老产物）就回落 `transcript.segments`，回落逻辑写在各消费点。
 */
export function readEditUnits(dir: string, cutRevision: number): Promise<VideoEditUnits | null> {
  return readVersioned<VideoEditUnits>(dir, "edit-units", cutRevision);
}

function stagingName(base: string, jobId: string): string {
  return `${base}.${jobId}.staging.json`;
}

/**
 * 先落 staging，settle 的 CAS 通过后才定版本（粗剪 spec §3.3）。
 *
 * 修的是一个真实的崩溃窗口：产物在 CAS 之前写盘时，「写出 cut.v2 → 崩 → 回收重跑 →
 * 按 state 里的 cut v1 再写 cut.v2 → 撞上不可覆盖文件 → 永久失败」。staging 以 jobId
 * 命名且**可安全覆盖**：同一条 job 重跑就是覆盖自己上一次的半成品，撞不着任何审计凭证。
 */
export async function writeStaging(dir: string, base: string, jobId: string, data: unknown): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, stagingName(base, jobId));
  await writeJsonAtomic(target, data);
  return target;
}

/**
 * staging → 正式 revision。用 `rename` 而不是 `link`：CAS 刚刚证明了这个 revision 号没被人
 * 占走，而万一存在「CAS 已过、rename 前崩溃」留下的同名残片，link 的 EEXIST 会把这条
 * content 永久钉死——那正是 §3.3 要消灭的失败模式。
 */
export async function promoteStaging(dir: string, base: string, jobId: string, revision: number): Promise<string> {
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`revision 必须是 ≥1 的整数，当前是 ${String(revision)}`);
  }
  const target = path.join(dir, versionedName(base, revision));
  await fs.rename(path.join(dir, stagingName(base, jobId)), target);
  return target;
}

/** 扫目录取最大 revision；目录不存在或一版都没有 → null */
export async function latestRevision(dir: string, base: string): Promise<number | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const re = new RegExp(`^${escapeRegExp(base)}\\.v(\\d+)\\.json$`);
  let latest: number | null = null;
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const rev = Number(m[1]);
    if (latest === null || rev > latest) latest = rev;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// 素材清单（§2.6）
// ---------------------------------------------------------------------------

/** 不存在/损坏都返回空清单——素材清单缺失是「还没登记素材」，不是故障 */
export async function readVideoAssets(dataDir: string, contentId: string): Promise<VideoAssetEntry[]> {
  const list = await readJson<VideoAssetEntry[]>(path.join(videoDir(dataDir, contentId), "assets.json"));
  return Array.isArray(list) ? list : [];
}

export function writeVideoAssets(
  dataDir: string,
  contentId: string,
  entries: VideoAssetEntry[],
): Promise<void> {
  return serializeVideoWrite(contentId, async () => {
    const dir = videoDir(dataDir, contentId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "assets.json"), entries);
  });
}

/**
 * AssetRef → 绝对路径。三种引用各有归宿（§2.6）；解析不出来一律抛人话错误，
 * 不返回 null——拿着 null 去拼路径只会把问题推到更远的地方炸。
 *
 * 只解析路径，不检查文件是否存在（存在性与指纹复检是 fingerprint 的活）。
 */
export async function resolveAssetRef(
  dataDir: string,
  contentId: string,
  ref: AssetRef,
): Promise<string> {
  if (ref.kind === "library") {
    const asset = await getAsset(ref.id, dataDir);
    if (!asset) throw new Error(`素材库里找不到 ${ref.id}（可能已被移出素材库）`);
    return path.resolve(asset.path);
  }
  if (ref.kind === "content") {
    if (!isSafeFilename(ref.filename)) throw new Error(`非法素材文件名：${String(ref.filename)}`);
    return path.join(contentRoot(dataDir, contentId), "assets", ref.filename);
  }
  if (!isSafeFilename(ref.file)) throw new Error(`非法素材文件名：${String(ref.file)}`);
  return path.join(videoAssetsDir(dataDir, contentId), ref.file);
}

// ---------------------------------------------------------------------------
// jobs.jsonl（§3）
// ---------------------------------------------------------------------------

/** 新任务：jobId/status/attempts 有默认值，其余由投递方填 */
export type NewVideoJob = Omit<VideoJob, "jobId" | "status" | "attempts"> &
  Partial<Pick<VideoJob, "jobId" | "status" | "attempts">>;

/**
 * append + fsync。台账是恢复语义的地基（重启回收、CAS 校验都读它），
 * 停在页缓存里的一行崩溃后就等于这次投递从未发生。
 */
export async function appendVideoJob(dataDir: string, input: NewVideoJob): Promise<VideoJob> {
  const job: VideoJob = {
    ...input,
    jobId: input.jobId ?? `vjob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: input.status ?? "queued",
    attempts: input.attempts ?? 0,
  };
  const file = videoJobsPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, "a");
  try {
    await fh.writeFile(JSON.stringify(job) + "\n", "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  return job;
}

/** 按写入顺序读全量；单行损坏（崩在写一半）跳过，不清空整个读视图 */
export async function readVideoJobs(dataDir: string): Promise<VideoJob[]> {
  let raw: string;
  try {
    raw = await fs.readFile(videoJobsPath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const jobs: VideoJob[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as VideoJob;
      if (parsed && typeof parsed.jobId === "string" && typeof parsed.contentId === "string") {
        jobs.push(parsed);
      }
    } catch {
      /* 跳过损坏行 */
    }
  }
  return jobs;
}

/** 读视图的键：同一份输入的重复投递自动合并，不同输入各自成队（codex #6） */
export function jobKey(job: Pick<VideoJob, "contentId" | "phase" | "inputKey">): string {
  return `${job.contentId}|${job.phase}|${job.inputKey}`;
}

/** latest-wins；顺序按各键**首次出现**的先后，读视图因此稳定可比对 */
export function latestJobsView(jobs: VideoJob[]): VideoJob[] {
  const byKey = new Map<string, VideoJob>();
  for (const job of jobs) byKey.set(jobKey(job), job);
  return [...byKey.values()];
}

function lastAliveMs(job: VideoJob): number | null {
  const stamp = job.heartbeatAt ?? job.claimedAt ?? job.startedAt;
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 心跳过期的 running 任务清单（启动回收用）。**只判定不写盘**——
 * 回收要伴随状态迁移与 attempts 递增，那是 runner 的事务，不是读函数的副作用。
 *
 * 没有任何时间戳（或时间戳不可解析）的 running 视为可回收：它永远等不到续租，
 * 留着只会让这条 content 卡死在「有人在跑」的假象里。
 */
export function recoverExpiredJobs(
  jobs: VideoJob[],
  nowMs: number,
  leaseMs: number = VIDEO_LEASE_MS,
): VideoJob[] {
  return latestJobsView(jobs).filter((job) => {
    if (job.status !== "running") return false;
    const alive = lastAliveMs(job);
    return alive === null || nowMs - alive > leaseMs;
  });
}
