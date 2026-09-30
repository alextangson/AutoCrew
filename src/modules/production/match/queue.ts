/**
 * 比对作业队列（1b §2，§14-13）：持久、去重、有终态、失败退避。单工人、一次一个。
 *
 * - 作业键 = (sha256, 用途, 目标稿或池版本)：同键有活作业就不再入队；终态 = 已判（done）/ 失败（failed）/ 取消（cancelled）。
 * - 优先级：有人明确要的（explicit：agent record、卡片挂载）> 自己去找的（background）。「暂停自动找原片」只停 background。
 * - 失败退避：handler 回 retry → 1 小时后再试，最多 3 次，之后停在可见的「失败」。单个作业总时限 5 分钟。
 * - 工人在干净的异步上下文里起（`outsideFileOwnership`），不继承 record 的归属锁；只有落结果时 handler 自己取锁（§3-9）。
 * - 队列文件放本机工作区缓存目录（和转写缓存一起），不进资料库；重启时「跑到一半」的作业回到排队。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { getWorkspaceCacheDir } from "../../../storage/storage-roots.js";
import { writeJsonAtomicMkdir } from "../../../storage/json-atomic.js";
import { newId } from "../../../storage/production-store.js";
import { outsideFileOwnership } from "../mutex.js";
import { matchDeps } from "./deps.js";

export const RETRY_DELAY_MS = 60 * 60_000;
export const MAX_RETRIES = 3;
export const JOB_LIMIT_MS = 5 * 60_000;
const KEEP_TERMINAL = 200;

/**
 * unavailable（Codex 审 segB6 P2）：跑的时候转写临时没就绪（重新预热等）。非终态、不计重试次数；
 * 下次有人在转写就绪时再来要这份字节（对账 tick 的发现），就重新排上。
 */
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled" | "unavailable";
export type Priority = "explicit" | "background";

export interface MatchJob {
  id: string; key: string; purpose: string; priority: Priority;
  sha256: string; path: string; size: number; mtime_ms: number;
  /** 目标稿（content_id:round）或池版本 */
  target: string;
  payload: Record<string, unknown>;
  state: JobState; attempts: number; next_at: number;
  error?: string; outcome?: string; created_at: string; updated_at: string;
}

export interface JobContext { dataDir: string; job: MatchJob; signal: AbortSignal }
export type JobResult = { state: "done" | "cancelled"; outcome: string } | { state: "retry" | "failed"; error: string } | { state: "unavailable"; reason: string };
export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export type JobSpec = Pick<MatchJob, "purpose" | "priority" | "sha256" | "path" | "size" | "mtime_ms" | "target" | "payload"> & { id?: string };

const TERMINAL: ReadonlySet<JobState> = new Set(["done", "failed", "cancelled"]);
const handlers = new Map<string, JobHandler>();
/** 作业终于失败（重试到头 / 直接 failed）时回调：把等它的事实落到看得见的终态（Codex 审 segB4 P2） */
export type FailedHook = (dataDir: string, job: MatchJob, error: string) => Promise<void>;
const failedHooks = new Map<string, FailedHook>();

export function registerMatchHandler(purpose: string, handler: JobHandler, onFailed?: FailedHook): void {
  handlers.set(purpose, handler);
  if (onFailed) failedHooks.set(purpose, onFailed);
}

// ---- 持久化（同一工作区的读改写串行） ----

interface Store { jobs: MatchJob[]; chain: Promise<unknown> }
const stores = new Map<string, Promise<Store>>();

function queueFile(dataDir: string): string {
  return path.join(getWorkspaceCacheDir(dataDir), "match-jobs.json");
}

async function loadStore(dataDir: string): Promise<Store> {
  let jobs: MatchJob[] = [];
  try {
    const raw = JSON.parse(await fs.readFile(queueFile(dataDir), "utf8")) as { jobs?: MatchJob[] };
    jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`比对作业队列读不了（${queueFile(dataDir)}）：${e instanceof Error ? e.message : String(e)}`);
  }
  // 上次进程跑到一半的作业：回到排队（重启恢复）
  for (const j of jobs) if (j.state === "running") j.state = "queued";
  return { jobs, chain: Promise.resolve() };
}

function storeOf(dataDir: string): Promise<Store> {
  let s = stores.get(dataDir);
  if (!s) { s = loadStore(dataDir); stores.set(dataDir, s); s.catch(() => stores.delete(dataDir)); }
  return s;
}

/**
 * 只裁「已判 / 取消」的展示历史。失败的记录是去重凭据（Codex 审 segB2 P2）：裁掉它，还在原处的坏文件会被当新作业重排、
 * 退避次数归零。失败记录留到文件内容变了（sha 变 → 新键）或有人明确要重试（显式入队顶掉它）。
 */
function prune(jobs: MatchJob[]): MatchJob[] {
  const done = jobs.filter((j) => j.state === "done" || j.state === "cancelled").sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, KEEP_TERMINAL);
  const keep = new Set(done.map((j) => j.id));
  return jobs.filter((j) => j.state === "failed" || !TERMINAL.has(j.state) || keep.has(j.id));
}

async function mutate<T>(dataDir: string, fn: (jobs: MatchJob[]) => T): Promise<T> {
  const store = await storeOf(dataDir);
  // 改在副本上、写盘成功才换进内存（Codex 审 segB11 P2）：写失败时内存不能先变成「跑到一半」，不然盘好了也再没人认领
  const run = store.chain.catch(() => undefined).then(async () => {
    const draft = structuredClone(store.jobs);
    const value = fn(draft);
    const next = prune(draft);
    await writeJsonAtomicMkdir(queueFile(dataDir), { version: 1, jobs: next });
    store.jobs = next;
    return value;
  });
  store.chain = run.catch(() => undefined);
  return run;
}

const iso = () => new Date(matchDeps().now()).toISOString();

// ---- 入队 ----

export function jobKey(spec: Pick<JobSpec, "sha256" | "purpose" | "target">): string {
  return `${spec.sha256}|${spec.purpose}|${spec.target}`;
}

function fresh(spec: JobSpec, key: string): MatchJob {
  const at = iso();
  return { id: spec.id ?? newId("mjob"), key, purpose: spec.purpose, priority: spec.priority, sha256: spec.sha256, path: spec.path, size: spec.size, mtime_ms: spec.mtime_ms,
    target: spec.target, payload: spec.payload, state: "queued", attempts: 0, next_at: 0, created_at: at, updated_at: at };
}

/**
 * 同键有活作业 → 返回它（带了新作业代号的明确请求会顶掉旧的：旧代号已经没有事实在等它）。
 * 同键已到终态：明确请求重新排；自己去找的不再排（失败停在可见的失败态，已判的不重转）。
 */
/** 旧路径上还是同一份字节（大小、修改时间都没变）= 这是另一份拷贝，不是搬走了 */
async function stillHolds(job: MatchJob | undefined): Promise<boolean> {
  if (!job) return false;
  const st = await fs.stat(job.path).catch(() => null);
  return Boolean(st && st.size === job.size && Math.trunc(st.mtimeMs) === job.mtime_ms);
}

export async function enqueueMatchJob(dataDir: string, spec: JobSpec): Promise<MatchJob> {
  const key = jobKey(spec);
  const before = (await storeOf(dataDir)).jobs.find((j) => j.key === key);
  // 同一份字节同时在收件箱和监视文件夹：交替看到两条路径不算搬走，不清退避、不重计次（Codex 审 segB4 P2）
  const copy = before && before.path !== spec.path ? await stillHolds(before) : false;
  const job = await mutate(dataDir, (jobs) => {
    const i = jobs.findIndex((j) => j.key === key);
    const existing = i >= 0 ? jobs[i] : null;
    const live = existing && !TERMINAL.has(existing.state);
    // 同一份字节换了位置（改名 / 从监视文件夹挪进收件箱）：改指新路径；因旧路径没了在退避或失败的，重新排上（Codex 审 segB3 P2）
    // 转写临时没就绪而停下的：调用方此刻已核过转写就绪，重新排上（不计次）
    if (existing && existing.state === "unavailable") {
      Object.assign(existing, { state: "queued", next_at: 0, error: undefined, path: spec.path, size: spec.size, mtime_ms: spec.mtime_ms, updated_at: iso() });
      return existing;
    }
    const moved = existing && existing.path !== spec.path;
    if (existing && moved) Object.assign(existing, { path: spec.path, size: spec.size, mtime_ms: spec.mtime_ms, updated_at: iso() });
    if (existing && moved && !copy && existing.state !== "running" && (existing.state === "failed" || existing.attempts > 0)) {
      Object.assign(existing, { state: "queued", attempts: 0, next_at: 0, error: undefined });
      return existing;
    }
    if (existing && live && (!spec.id || spec.id === existing.id)) return existing;
    if (existing && !live && spec.priority === "background") return existing;
    const next = fresh(spec, key);
    if (i >= 0) jobs.splice(i, 1);
    jobs.push(next);
    return next;
  });
  kickMatchWorker(dataDir);
  return job;
}

export async function listMatchJobs(dataDir: string): Promise<MatchJob[]> {
  return structuredClone((await storeOf(dataDir)).jobs);
}

/** 把一个已判的作业重新排上（调用方已确认它当初的产出不在了）；不重置失败次数。成功回 true */
export async function requeueMatchJob(dataDir: string, id: string): Promise<boolean> {
  const ok = await mutate(dataDir, (jobs) => {
    const j = jobs.find((x) => x.id === id);
    if (!j || j.state !== "done") return false;
    Object.assign(j, { state: "queued", next_at: 0, outcome: undefined, updated_at: iso() });
    return true;
  });
  if (ok) kickMatchWorker(dataDir);
  return ok;
}

/** 取消一个作业（事实已被创始人定了 / 稿被删）：它还没跑就不跑了；在跑的，结果落地时锁内复核会作废 */
export async function cancelMatchJob(dataDir: string, id: string, why: string): Promise<void> {
  await mutate(dataDir, (jobs) => {
    const j = jobs.find((x) => x.id === id);
    if (j && j.state === "queued") Object.assign(j, { state: "cancelled", outcome: why, updated_at: iso() });
  });
}

// ---- 工人 ----

interface Worker { run: Promise<void> | null; again: boolean; timer?: NodeJS.Timeout; error?: string }
const workers = new Map<string, Worker>();

function workerOf(dataDir: string): Worker {
  let w = workers.get(dataDir);
  if (!w) { w = { run: null, again: false }; workers.set(dataDir, w); }
  return w;
}

async function isPaused(dataDir: string): Promise<boolean> {
  // 设置读坏了：自己去找的先停（显式请求照常），不当成「没暂停」硬跑
  return matchDeps().paused(dataDir).catch(() => true);
}

async function claimNext(dataDir: string): Promise<MatchJob | null> {
  const paused = await isPaused(dataDir);
  const now = matchDeps().now();
  return mutate(dataDir, (jobs) => {
    const ready = jobs.filter((j) => j.state === "queued" && j.next_at <= now && (j.priority === "explicit" || !paused));
    ready.sort((a, b) => (a.priority === b.priority ? a.created_at.localeCompare(b.created_at) : a.priority === "explicit" ? -1 : 1));
    const job = ready[0];
    if (!job) return null;
    Object.assign(job, { state: "running", updated_at: iso() });
    return structuredClone(job);
  });
}

/** 把结果写进队列；终于失败时回那份作业（要送给失败回调），否则 null */
async function settle(dataDir: string, id: string, r: JobResult): Promise<MatchJob | null> {
  return mutate(dataDir, (jobs): MatchJob | null => {
    const j = jobs.find((x) => x.id === id);
    if (!j || j.state !== "running") return null;
    j.updated_at = iso();
    if ("reason" in r) { Object.assign(j, { state: "unavailable", error: r.reason }); return null; }
    if ("outcome" in r) { Object.assign(j, { state: r.state, outcome: r.outcome }); return null; }
    j.attempts += 1;
    j.error = r.error;
    if (r.state === "failed" || j.attempts > MAX_RETRIES) { j.state = "failed"; return structuredClone(j); }
    Object.assign(j, { state: "queued", next_at: matchDeps().now() + RETRY_DELAY_MS });
    return null;
  });
}

/**
 * 跑完了、结果没写上盘的作业（写盘失败）：结果留在内存等补写。工人每次醒来（对账 tick 也会叫醒）先补写它们，
 * 不重跑；写上之前队列错误一直在。进程在补写前重启 → 加载时「跑到一半」回排队重跑，处理器靠作业代号幂等落结果。
 */
/**
 * 「结果写上盘」与「失败回调送达」分开记（Codex 审 segB12 P2）：作业已落成 failed、但回调（把事实转候选 / failed）抛错时，
 * 条目留着、错误留着，每次叫醒只重试回调；两步都成了才删。
 */
interface Unsettled { r: JobResult; written: boolean; failed: MatchJob | null }
const unsettled = new Map<string, Map<string, Unsettled>>();

async function settleOrKeep(dataDir: string, id: string, r: JobResult): Promise<void> {
  const map = unsettled.get(dataDir) ?? new Map<string, Unsettled>();
  unsettled.set(dataDir, map);
  const entry = map.get(id) ?? { r, written: false, failed: null };
  map.set(id, entry);
  if (!entry.written) { entry.failed = await settle(dataDir, id, entry.r); entry.written = true; }
  const hook = entry.failed ? failedHooks.get(entry.failed.purpose) : undefined;
  if (entry.failed && hook) await hook(dataDir, entry.failed, entry.failed.error ?? "核对失败");
  map.delete(id);
}

async function flushUnsettled(dataDir: string): Promise<void> {
  for (const [id, e] of [...(unsettled.get(dataDir) ?? new Map<string, Unsettled>())]) await settleOrKeep(dataDir, id, e.r);
}

async function runJob(dataDir: string, job: MatchJob): Promise<void> {
  const handler = handlers.get(job.purpose);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), JOB_LIMIT_MS).unref();
  let r: JobResult;
  try {
    r = handler ? await handler({ dataDir, job, signal: ctl.signal }) : { state: "failed", error: `没有处理 ${job.purpose} 的比对器` };
  } catch (e) {
    r = { state: "retry", error: e instanceof Error ? e.message : String(e) };
  } finally { clearTimeout(timer); }
  if (ctl.signal.aborted && r.state === "retry") r = { state: "retry", error: `比对超过 ${JOB_LIMIT_MS / 60_000} 分钟：${r.error}` };
  await settleOrKeep(dataDir, job.id, r);
}

/** 下一个退避到期的作业：到点再叫醒工人（不挡进程退出） */
async function armTimer(dataDir: string, w: Worker): Promise<void> {
  const now = matchDeps().now();
  const next = (await storeOf(dataDir)).jobs.filter((j) => j.state === "queued" && j.next_at > now).map((j) => j.next_at).sort((a, b) => a - b)[0];
  clearTimeout(w.timer);
  if (next !== undefined) w.timer = setTimeout(() => kickMatchWorker(dataDir), next - now).unref();
}

async function drain(dataDir: string, w: Worker): Promise<void> {
  // 先补写上次没落盘的结果；补写失败就抛出去（错误保留），不认领新活
  if (unsettled.get(dataDir)?.size) { await flushUnsettled(dataDir); delete w.error; }
  do {
    w.again = false;
    for (let job = await claimNext(dataDir); job; job = await claimNext(dataDir)) {
      await runJob(dataDir, job);
      // 真跑完一个作业（认领与落结果都写上盘了）才算从队列错误里恢复；空转一轮不清错误
      delete w.error;
    }
  } while (w.again);
  await armTimer(dataDir, w);
}

/** 叫醒工人。总在锁外的干净异步上下文里起（§3-9）；已经在跑就让它跑完再看一遍 */
export function kickMatchWorker(dataDir: string): void {
  const w = workerOf(dataDir);
  if (w.run) { w.again = true; return; }
  outsideFileOwnership(() => {
    w.run = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => drain(dataDir, w))
      .catch((e: unknown) => { w.error = e instanceof Error ? e.message : String(e); })
      .finally(() => { w.run = null; });
  });
}

/** 工人自己出错（队列文件读写不了）：摘要 / 对账警告里要看得见，不静默 */
export function matchWorkerError(dataDir: string): string | null {
  return workers.get(dataDir)?.error ?? null;
}

/** 等工人把当前能跑的都跑完（测试、关停用） */
export async function matchWorkerIdle(dataDir: string): Promise<void> {
  for (let w = workers.get(dataDir); w?.run; w = workers.get(dataDir)) await w.run;
}

/** 测试 / 重新挂载资料库：忘掉内存里的队列与工人（盘上的队列文件留着） */
export function resetMatchQueue(): void {
  for (const w of workers.values()) clearTimeout(w.timer);
  workers.clear();
  stores.clear();
  unsettled.clear();
}
