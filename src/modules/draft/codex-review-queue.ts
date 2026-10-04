/**
 * Codex 审稿任务（会审 #10/#11）：每篇稿、每个稿件指纹同一时间只有一个审稿任务，重复请求合并；
 * 每次尝试有编号，落在稿件目录的 draft-review.json；全局最多同时跑 2 个，排队上限 6 个（满了记失败、看得见）。
 * 排着和跑着的任务都经 trackWork 计入忙碌（/api/update/busy）。服务重启：跑着的标失败可重试，排着的恢复。
 * 审稿只是提示：结果不打回、不参与交接判断。
 */
import fs from "node:fs/promises";
import { trackWork } from "../update/active-work.js";
import { contentFile, isMissing } from "../../storage/content-project.js";
import { draftHash } from "../../storage/draft-hash.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { getContent, listContents } from "../../storage/local-store.js";
import { loadProfile, rulesForPlatform } from "../profile/creator-profile.js";
import { buildReviewPrompt, classifyRun, parseReview, REVIEW_TIMEOUT_MS, runCodexExec, type CodexRunner, type ReviewFailure, type ReviewResult } from "./codex-review.js";
import { DRAFT_PLATFORM } from "./draft-types.js";
import { serializeDraft } from "./draft-research.js";

export const MAX_RUNNING = 2;
export const MAX_WAITING = 6;
const REVIEW_FILE = "draft-review.json";

export interface ReviewAttempt {
  attempt: number;
  draft_hash: string;
  version: number;
  status: "queued" | "running" | "done" | "failed";
  queued_at: string;
  started_at?: string;
  ended_at?: string;
  tries?: number;
  result?: ReviewResult;
  error?: ReviewFailure;
}
interface ReviewState { attempts: ReviewAttempt[] }
interface Job { contentId: string; dataDir?: string; attempt: number; body: string; angle: string; done: () => void }

let runner: CodexRunner = runCodexExec;
const waiting: Job[] = [];
let running = 0;
/** 已占名额、还没落盘入队的（跨稿件原子占位：判断与占位之间没有 await） */
let reserved = 0;
const CAPACITY = MAX_RUNNING + MAX_WAITING;

/** 只给测试 */
export function setCodexRunner(fn: CodexRunner | null): void { runner = fn ?? runCodexExec; }
export function resetReviewQueue(): void { waiting.length = 0; running = 0; reserved = 0; }
/** 只给测试：等排着和跑着的审稿都结束（删临时目录前用） */
export async function reviewsIdle(): Promise<void> {
  for (let i = 0; i < 600 && (running || waiting.length); i++) await new Promise((r) => setTimeout(r, 5));
}

const now = () => new Date().toISOString();
const lockKey = (id: string) => `review:${id}`;

async function loadState(contentId: string, dataDir?: string): Promise<ReviewState> {
  try { return JSON.parse(await fs.readFile(contentFile(contentId, dataDir, REVIEW_FILE), "utf8")) as ReviewState; }
  catch (e) { if (isMissing(e)) return { attempts: [] }; throw e; }
}
const saveState = (contentId: string, state: ReviewState, dataDir?: string) => writeJsonAtomicMkdir(contentFile(contentId, dataDir, REVIEW_FILE), state);

async function patchAttempt(contentId: string, attempt: number, patch: Partial<ReviewAttempt>, dataDir?: string): Promise<void> {
  await serializeDraft(lockKey(contentId), async () => {
    const state = await loadState(contentId, dataDir);
    const a = state.attempts.find((x) => x.attempt === attempt);
    if (!a) return;
    Object.assign(a, patch);
    await saveState(contentId, state, dataDir);
  });
}

function angleText(angle: { main_line: string; for_whom: string; opening: string; chain: string[] } | undefined): string {
  return angle ? `主线：${angle.main_line}\n给谁看：${angle.for_whom}\n开头：${angle.opening}\n论证链：\n${angle.chain.map((c) => `- ${c}`).join("\n")}` : "";
}

function schedule(job: Omit<Job, "done">): void {
  let done!: () => void;
  trackWork(`codex-review:${job.contentId}`, new Promise<void>((resolve) => { done = resolve; }));
  waiting.push({ ...job, done });
  pump();
}

function pump(): void {
  while (running < MAX_RUNNING && waiting.length) {
    const job = waiting.shift()!;
    running++;
    void runJob(job).catch((err) => console.error(`[draft-review] ${job.contentId} 审稿任务异常：`, err))
      .finally(() => { running--; job.done(); pump(); });
  }
}

async function attemptOnce(prompt: string, body: string): Promise<{ result?: ReviewResult; error?: ReviewFailure; invalid?: string }> {
  const run = await runner(prompt, { timeoutMs: REVIEW_TIMEOUT_MS });
  const failed = classifyRun(run);
  if (failed) return { error: failed };
  const parsed = parseReview(run.stdout, body);
  return parsed.ok ? { result: parsed.result } : { invalid: parsed.error };
}

async function runJob(job: Job): Promise<void> {
  await patchAttempt(job.contentId, job.attempt, { status: "running", started_at: now() }, job.dataDir);
  try {
    const profile = await loadProfile(job.dataDir);
    const rules = profile ? rulesForPlatform(profile, DRAFT_PLATFORM).map((r) => r.rule) : [];
    const prompt = await buildReviewPrompt(job.body, rules, job.angle);
    let out = await attemptOnce(prompt, job.body);
    let tries = 1;
    if (out.invalid) {
      tries = 2;
      out = await attemptOnce(`${prompt}\n\n上一次的输出不合格：${out.invalid}。这次只输出合格的 JSON。`, job.body);
    }
    const error = out.error ?? (out.invalid ? { code: "codex_invalid_output", message: `Codex 两次输出都不合格：${out.invalid}` } : undefined);
    await patchAttempt(job.contentId, job.attempt, error
      ? { status: "failed", error, tries, ended_at: now() }
      : { status: "done", result: out.result, tries, ended_at: now() }, job.dataDir);
  } catch (err) {
    await patchAttempt(job.contentId, job.attempt, { status: "failed", error: { code: "review_crashed", message: err instanceof Error ? err.message : String(err) }, ended_at: now() }, job.dataDir);
  }
}

export interface EnqueueResult { attempt: ReviewAttempt; coalesced: boolean }

/** 排一次审稿（审当前版）。同篇同指纹已在排或在跑 → 合并，返回那一次 */
export async function enqueueReview(contentId: string, dataDir?: string): Promise<EnqueueResult> {
  return serializeDraft(lockKey(contentId), async () => {
    const content = await getContent(contentId, dataDir);
    if (!content) throw new Error(`稿件不存在：${contentId}`);
    const hash = draftHash(content);
    const state = await loadState(contentId, dataDir);
    const active = state.attempts.find((a) => a.draft_hash === hash && (a.status === "queued" || a.status === "running"));
    if (active) return { attempt: active, coalesced: true };
    const attempt: ReviewAttempt = { attempt: (state.attempts.at(-1)?.attempt ?? 0) + 1, draft_hash: hash, version: content.versions?.length ?? 1, status: "queued", queued_at: now() };
    const full = running + waiting.length + reserved >= CAPACITY;
    if (full) {
      Object.assign(attempt, { status: "failed", ended_at: now(), error: { code: "queue_full", message: `审稿排队已满（同时 ${MAX_RUNNING} 篇在审、${MAX_WAITING} 篇在等），稍后点「再审」` } });
    } else reserved++;
    state.attempts.push(attempt);
    try { await saveState(contentId, state, dataDir); }
    finally { if (!full) reserved--; }
    if (!full) schedule({ contentId, dataDir, attempt: attempt.attempt, body: content.body, angle: angleText(content.draftPath?.angle) });
    return { attempt, coalesced: false };
  });
}

/** review 动作与工作台看的那一份：最近一次尝试；审的不是当前版就标出来 */
export async function reviewView(contentId: string, dataDir?: string): Promise<Record<string, unknown>> {
  const [state, content] = await Promise.all([loadState(contentId, dataDir), getContent(contentId, dataDir)]);
  const last = state.attempts.at(-1);
  if (!last) return { status: "none", note: "还没审过" };
  const current = content ? last.draft_hash === draftHash(content) : false;
  return {
    status: last.status, attempt: last.attempt, version: last.version, current,
    note: current ? `审的是当前版（第 ${last.version} 版）` : `审的是第 ${last.version} 版，之后稿子又改过`,
    ...(last.result ? { result: last.result } : {}),
    ...(last.error ? { error: last.error } : {}),
  };
}

/** 服务启动：跑着的标失败（可重审），排着的按当前正文恢复；排队后稿子改过的标失败 */
export async function recoverReviews(dataDir?: string): Promise<{ failed: number; requeued: number }> {
  let failed = 0, requeued = 0;
  for (const c of (await listContents(dataDir)).filter((x) => x.draftPath)) {
    await serializeDraft(lockKey(c.id), async () => {
      const state = await loadState(c.id, dataDir);
      let dirty = false;
      for (const a of state.attempts) {
        if (a.status === "running" || (a.status === "queued" && a.draft_hash !== draftHash(c))) {
          Object.assign(a, { status: "failed", ended_at: now(), error: a.status === "running"
            ? { code: "interrupted", message: "服务重启时这次审稿还没跑完，点「再审」重来" }
            : { code: "stale_in_queue", message: "排队时稿子改过，这次没审；点「再审」审新版" } });
          dirty = true; failed++;
        } else if (a.status === "queued") {
          schedule({ contentId: c.id, dataDir, attempt: a.attempt, body: c.body, angle: angleText(c.draftPath?.angle) });
          requeued++;
        }
      }
      if (dirty) await saveState(c.id, state, dataDir);
    });
  }
  return { failed, requeued };
}
