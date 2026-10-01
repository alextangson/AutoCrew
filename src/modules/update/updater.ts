/**
 * 一键更新的执行（self-update §3-9/10）：记旧 HEAD → ff-only 到 tag → 装依赖 → 构建 → 重启 → 健康检查。
 * 任一步失败：reset --hard 回旧 HEAD（预检保证了已跟踪文件干净）→ 重装、重建、重启，结果写进本机目录让页面看见。
 * 退回本身也失败：停下，把手动恢复命令写进结果和日志。服务进程与 `autocrew update` 走的都是这一个函数。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { firstLine, type GitRunner } from "./git.js";
import { writeResult, files, type UpdateResult } from "./state.js";
import type { ReleaseNotes } from "./changelog.js";

export type Log = (line: string) => void;

export interface UpdateSteps {
  /** 重启前最后一道：确认没有任务在跑；等到上限还在跑就抛 QuiesceError（不重启、退回旧版本） */
  quiesce: (log: Log) => Promise<void>;
  /** 服务确实不在了（端口没人听）：更新已经停过它时，退回直接把旧版启动起来，不再问忙不忙 */
  serviceDown: () => Promise<boolean>;
  install: (log: Log) => Promise<void>;
  build: (log: Log) => Promise<void>;
  restart: (log: Log) => Promise<void>;
  health: (log: Log) => Promise<void>;
}

export interface UpdateJob {
  root: string;
  machineDir: string;
  tag: string;
  /** origin 公布的 tag 所指提交：只合到它 */
  commit: string;
  from: string;
  to: string;
  notes?: ReleaseNotes[];
  git: GitRunner;
  steps: UpdateSteps;
  logFile: string;
  now?: () => Date;
}

export class QuiesceError extends Error {}

export function newLogFile(machineDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(files(machineDir).logDir, `update-${stamp}.log`);
}

function fileLogger(logFile: string): Log {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return (line) => fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
}

async function gitStep(git: GitRunner, args: string[], log: Log): Promise<string> {
  log(`$ git ${args.join(" ")}`);
  const r = await git(args, { timeoutMs: 120_000 });
  if (r.stdout.trim()) log(r.stdout.trim());
  if (r.stderr.trim()) log(r.stderr.trim());
  if (!r.ok) throw new Error(`git ${args[0]} 失败：${firstLine(r.stderr) || "没有输出"}`);
  return r.stdout.trim();
}

export function manualCommands(root: string, oldHead: string): string[] {
  return [
    `cd "${root}"`,
    `git reset --hard ${oldHead}`,
    "npm ci",
    "(cd frontend && npm ci)",
    "npm run fe:build",
    "npm run restart",
  ];
}

/** 工作区里有别的改动时的手动步骤：先看清、另存，再退回——不替用户丢东西 */
export function dirtyManualCommands(root: string, oldHead: string): string[] {
  return [
    `cd "${root}"`,
    "git status    # 先看清哪些是你自己的改动，把要留的另存一份",
    `git reset --hard ${oldHead}    # 另存好之后再退回（这一步会丢掉未提交的改动）`,
    "npm ci",
    "(cd frontend && npm ci)",
    "npm run fe:build",
    "npm run restart",
  ];
}

/**
 * 这次更新做到哪了：
 * - movedTo：这次真的把 HEAD 从旧提交挪到了这里（没挪就绝不 reset，用户的东西一个字不碰）；
 * - touchedService：进了重启那一步（旧服务可能已经停了）。
 */
interface Progress { touchedService: boolean; movedTo?: string }

/** 没动手就停下的原因（合并前发现改动、合并没挪 HEAD）：不退回、不碰工作区 */
export class NotStartedError extends Error {}

async function trackedChanges(git: GitRunner): Promise<string> {
  const r = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (!r.ok) throw new Error(`读不出本地改动（${firstLine(r.stderr)}）`);
  return r.stdout.trim();
}

async function forward(job: UpdateJob, oldHead: string, log: Log, progress: Progress): Promise<void> {
  // 预检之后到这里可能有人改了程序文件：合并前再查一次（Codex 审第 5 轮 P1）
  const dirty = await trackedChanges(job.git);
  if (dirty) throw new NotStartedError(`程序文件刚刚有了本地改动（${firstLine(dirty)}…），自动更新会覆盖它们`);
  try { await gitStep(job.git, ["merge", "--ff-only", job.commit], log); }
  catch (e) { throw new NotStartedError(errText(e)); }
  const head = await gitStep(job.git, ["rev-parse", "HEAD"], log);
  if (head === oldHead) throw new NotStartedError("合并后版本没有变化");
  progress.movedTo = head;
  log("== 安装依赖"); await job.steps.install(log);
  log("== 构建前端"); await job.steps.build(log);
  log("== 确认没有任务在跑"); await job.steps.quiesce(log);
  progress.touchedService = true;
  log("== 重启服务"); await job.steps.restart(log);
  log("== 健康检查"); await job.steps.health(log);
}

/** 退回前发现工作区里有不是这次更新带来的改动：不 reset，给手动步骤 */
export class DirtyRollbackError extends Error {}

async function rollback(job: UpdateJob, oldHead: string, log: Log, restart: boolean, progress: Progress): Promise<"kept" | "restarted" | "not_restarted"> {
  // reset --hard 只在「这次真的把 HEAD 挪到了 movedTo、HEAD 还在那、而且相对它没有任何已跟踪改动」时才做：
  // 那时工作区里只有这次更新自己的东西，丢掉它不会丢用户的字（Codex 审第 5 轮 P1）
  const head = await gitStep(job.git, ["rev-parse", "HEAD"], log);
  if (!progress.movedTo || head !== progress.movedTo) throw new DirtyRollbackError(`当前版本不是这次更新合进来的那一版（${head.slice(0, 8)}），不自动退回`);
  const dirty = await trackedChanges(job.git);
  if (dirty) throw new DirtyRollbackError(`程序文件有不是这次更新带来的改动（${firstLine(dirty)}…），不自动退回，免得覆盖它们`);
  await gitStep(job.git, ["reset", "--hard", oldHead], log);
  log("== 退回：安装依赖"); await job.steps.install(log);
  log("== 退回：构建前端"); await job.steps.build(log);
  // 因为有任务在跑而取消：旧服务一直没停，不重启（绝不掐断在跑的轮）
  if (!restart) { log("服务没有重启过，保持运行"); return "kept"; }
  // 更新已经动过服务、而服务现在确实不在（新版没起来）：没有谁的活会被掐，直接把旧版启动（Codex 审第 3 轮 P1）
  const down = progress.touchedService && await job.steps.serviceDown().catch(() => false);
  // 否则先确认没人在跑（Codex 审第 2 轮 P1）：只有「服务在、而且说忙」才挡住重启，代码已经退回
  if (down) log("服务已经不在了：直接启动旧版本");
  else try { log("== 退回：确认没有任务在跑"); await job.steps.quiesce(log); }
  catch (e) {
    if (!(e instanceof QuiesceError)) throw e;
    log(`服务没有重启：${e.message}`);
    return "not_restarted";
  }
  log("== 退回：重启服务"); await job.steps.restart(log);
  log("== 退回：健康检查"); await job.steps.health(log);
  return "restarted";
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runUpdate(job: UpdateJob): Promise<UpdateResult> {
  const log = fileLogger(job.logFile);
  const at = () => (job.now?.() ?? new Date()).toISOString();
  const base = { from: job.from, to: job.to, log: job.logFile, ...(job.notes ? { notes: job.notes } : {}) };
  log(`AutoCrew 更新 ${job.from} → ${job.to}（${job.tag}）`);
  let oldHead: string;
  try { oldHead = await gitStep(job.git, ["rev-parse", "HEAD"], log); }
  catch (e) {
    return finish(job, { ok: false, outcome: "rolled_back", at: at(), ...base, message: `更新没开始：${errText(e)}，完整记录在 ${job.logFile}` }, log);
  }
  log(`旧版本提交：${oldHead}`);
  const progress: Progress = { touchedService: false };
  try {
    await forward(job, oldHead, log, progress);
    return finish(job, { ok: true, outcome: "updated", at: at(), ...base, message: `已更新到 ${job.to}` }, log);
  } catch (e) {
    const reason = errText(e);
    if (e instanceof NotStartedError || !progress.movedTo) {
      log(`!! 更新没做：${reason}；没有动任何文件`);
      return finish(job, { ok: false, outcome: "not_started", at: at(), ...base,
        message: `更新没做：${reason}。没有动你的文件，仍是 ${job.from}，完整记录在 ${job.logFile}` }, log);
    }
    const busy = e instanceof QuiesceError;
    log(`!! 更新${busy ? "取消" : "失败"}：${reason}；开始退回 ${oldHead}`);
    try {
      const how = await rollback(job, oldHead, log, !busy, progress);
      return finish(job, { ok: false, outcome: "rolled_back", at: at(), ...base,
        message: how === "not_restarted"
          ? `更新失败，已退回代码；服务没有重启（有任务在跑），等它们结束后运行 npm run restart。原因：${reason}，完整记录在 ${job.logFile}`
          : busy
          ? `更新取消了：${reason}。没有重启，仍是 ${job.from}，完整记录在 ${job.logFile}`
          : `更新失败，已退回 ${job.from}，原因：${reason}，完整记录在 ${job.logFile}` }, log);
    } catch (e2) {
      const cmds = e2 instanceof DirtyRollbackError ? dirtyManualCommands(job.root, oldHead) : manualCommands(job.root, oldHead);
      log(`!! 退回也失败：${errText(e2)}。请在终端手动恢复：\n${cmds.join("\n")}`);
      return finish(job, { ok: false, outcome: "stuck", at: at(), ...base, manualCommands: cmds,
        message: `更新失败，自动退回也失败了（${errText(e2)}）。请在终端依次执行下面的命令恢复到 ${job.from}，完整记录在 ${job.logFile}` }, log);
    }
  }
}

function finish(job: UpdateJob, result: UpdateResult, log: Log): UpdateResult {
  log(result.message);
  try { writeResult(job.machineDir, result); } catch (e) { log(`!! 写不了更新结果：${errText(e)}`); }
  return result;
}

/* ── 真实的四步（测试注入假的） ─────────────────────────────────────── */

function runCommand(cmd: string, args: string[], cwd: string, log: Log, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  log(`$ (${cwd}) ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const pipe = (chunk: Buffer) => { for (const l of chunk.toString("utf-8").split("\n")) if (l.trim()) log(l); };
    child.stdout.on("data", pipe);
    child.stderr.on("data", pipe);
    child.on("error", (e) => reject(new Error(`${cmd} 起不来：${e.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} 退出码 ${code}`))));
  });
}

/** 轮询到没有任务在跑；上限内一直有（或一直问不到服务）就抛 QuiesceError */
export async function waitIdle(check: () => Promise<string | null>, opts: { timeoutMs: number; intervalMs: number; log: Log; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.timeoutMs;
  let last = "";
  for (;;) {
    try { const busy = await check(); if (!busy) return; last = busy; }
    catch (e) { last = `没法确认是否空闲（${errText(e)}）`; }
    if (Date.now() >= deadline) throw new QuiesceError(`等了 ${Math.round(opts.timeoutMs / 1000)} 秒还有任务在跑：${last}`);
    opts.log(`还在等：${last}`);
    await sleep(opts.intervalMs);
  }
}

export function realSteps(root: string, port: number, opts: { serverWasRunning: boolean; busy: () => Promise<string | null> }): UpdateSteps {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return {
    quiesce: (log) => waitIdle(opts.busy, { timeoutMs: 120_000, intervalMs: 2_000, log }),
    serviceDown: async () => {
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }); return false; }
      catch { return true; }
    },
    install: async (log) => {
      await runCommand(npm, ["ci", "--no-audit", "--no-fund"], root, log);
      await runCommand(npm, ["ci", "--no-audit", "--no-fund"], path.join(root, "frontend"), log);
    },
    build: (log) => runCommand(npm, ["run", "fe:build"], root, log),
    restart: async (log) => {
      if (!opts.serverWasRunning) { log("服务本来没在跑：不启动，之后用 npm start 启动"); return; }
      await runCommand(process.execPath, [path.join(root, "bin", "autocrew.mjs"), "restart", "--no-open"], root, log,
        { ...process.env, AUTOCREW_PORT: String(port) });
    },
    health: async (log) => {
      if (!opts.serverWasRunning) return;
      await waitHealthy(`http://127.0.0.1:${port}/`, 60_000, log);
    },
  };
}

export async function waitHealthy(url: string, timeoutMs: number, log: Log, fetchImpl: typeof fetch = fetch): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
      if (r.status === 200) { log(`首页 200：${url}`); return; }
      last = `HTTP ${r.status}`;
    } catch (e) { last = errText(e); }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`服务 ${Math.round(timeoutMs / 1000)} 秒内没回来（最后一次：${last}）`);
}
