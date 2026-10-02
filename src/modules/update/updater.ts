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
import { fetchLaunchInfo, launcherNonce, managedBy } from "./remote.js";
import { DepsSwap, sweepOrphanPrev, sweepTrash } from "./deps-swap.js";
import { markFinishing, markRestarting } from "./abort.js";
import { clearInflight, markInflightVerified, writeInflight } from "./interrupted.js";
import { getMachineDir } from "../../storage/storage-roots.js";

export type Log = (line: string) => void;

export interface UpdateSteps {
  /** 重启前最后一道：确认没有任务在跑；等到上限还在跑就抛 QuiesceError（不重启、退回旧版本） */
  quiesce: (log: Log) => Promise<void>;
  /** 服务确实不在了（端口没人听）：更新已经停过它时，退回直接把旧版启动起来，不再问忙不忙 */
  serviceDown: () => Promise<boolean>;
  /** 第二个参数：中止信号（Ctrl-C）——装依赖、构建这种长步骤收到就结束子进程 */
  install: (log: Log, signal?: AbortSignal) => Promise<void>;
  /** 确认没人在跑、马上重启前：把新构建的前端换上（没有就跳过） */
  activate?: (log: Log) => Promise<void>;
  /** 退回时不靠网络换回旧依赖 / 旧前端；有它就不再跑 install + build（e2e P1-2） */
  restore?: (log: Log) => Promise<void>;
  /** 健康检查通过后：删掉留着的旧依赖 / 旧前端 */
  cleanup?: (log: Log) => Promise<void>;
  /** 手动恢复时换回旧依赖的命令（不需要网络） */
  manualRestore?: () => string[];
  /** 这次留旧依赖备份用的时间戳（`*.prev-<戳>`）：写进在途记录，恢复与清理只认这一戳（第 16 轮 P2-2） */
  backupStamp?: string;
  /** 取消（没重启）之后：服务本来在跑、现在却不在了（比如被人手动停了），把它起回来（第 12 轮 P2） */
  ensureUp?: (log: Log) => Promise<void>;
  build: (log: Log, signal?: AbortSignal) => Promise<void>;
  /** 第二个参数：是不是退回时调的（服务本来没开、更新也没起过它时，退回不必启动） */
  restart: (log: Log, ctx?: { rollback?: boolean }) => Promise<void>;
  health: (log: Log, ctx?: { rollback?: boolean }) => Promise<void>;
  /** 这次更新有没有把本来没开的服务起起来了（结果里要告诉用户「AutoCrew 已经启动」） */
  startedService?: () => boolean;
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
  /** 预检时看到的 HEAD：动手前再核一次，不一样就不动（Codex 审第 11 轮 P2） */
  expectHead?: string;
  /** Ctrl-C / SIGTERM：在关键步骤之间检查，收到就走正常退回（e2e P1-3） */
  signal?: AbortSignal;
}

export class QuiesceError extends Error {}

/** 搞不清停在哪了（合并出错后 HEAD 去了别处、或连 HEAD 都读不出）：不自动退回，给手动恢复步骤 */
export class UncertainStateError extends Error {}

/** 用户中止（Ctrl-C / SIGTERM）：走正常退回 */
export class AbortedError extends Error {}
export const ABORT_REASON = "你中止了更新（Ctrl-C）";

export function newLogFile(machineDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(files(machineDir).logDir, `update-${stamp}.log`);
}

function fileLogger(logFile: string): Log {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return (line) => fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
}

const GIT_STEP_WORDS: Record<string, string> = { merge: "切到新版本", reset: "退回旧版本", "rev-parse": "读当前版本", "ls-tree": "读文件清单" };

async function gitStep(git: GitRunner, args: string[], log: Log): Promise<string> {
  log(`$ git ${args.join(" ")}`);
  const r = await git(args, { timeoutMs: 120_000 });
  if (r.stdout.trim()) log(r.stdout.trim());
  if (r.stderr.trim()) log(r.stderr.trim());
  const verb = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "";
  if (!r.ok) throw new Error(`${GIT_STEP_WORDS[verb] ?? "读写程序版本"}${r.timedOut ? "超时了" : "没成功"}，详情见日志`);
  return r.stdout.trim();
}

/** 有留着的旧依赖就用它换回（不需要网络），没有才重新装 */
function depsCommands(restore?: string[]): string[] {
  return restore && restore.length ? restore : ["npm ci", "(cd frontend && npm ci)", "npm run fe:build"];
}

export function manualCommands(root: string, oldHead: string, restore?: string[]): string[] {
  return [`cd "${root}"`, `git reset --hard ${oldHead}`, ...depsCommands(restore), "npm run restart"];
}

/** 工作区里有别的改动时的手动步骤：先看清、另存，再退回——不替用户丢东西 */
export function dirtyManualCommands(root: string, oldHead: string, restore?: string[]): string[] {
  return [
    `cd "${root}"`,
    "git status    # 先看清哪些是你自己的改动，把要留的另存一份",
    `git reset --hard ${oldHead}    # 另存好之后再退回（这一步会丢掉未提交的改动）`,
    ...depsCommands(restore),
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

/** 还在 main、HEAD 还是预检时那个？不是就返回人话原因 */
async function branchOrHeadChanged(job: UpdateJob, head: string): Promise<string | null> {
  const b = await job.git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = firstLine(b.stdout);
  if (branch !== "main") return `预检之后切到了别的分支（${branch || "没有分支"}），只更新 main`;
  if (job.expectHead && head !== job.expectHead) return "预检之后版本被挪动过，为了安全没动手";
  return null;
}

async function trackedChanges(git: GitRunner): Promise<string> {
  const r = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (!r.ok) throw new Error(`读不出本地改动（${firstLine(r.stderr)}）`);
  return r.stdout.trim();
}

async function forward(job: UpdateJob, oldHead: string, log: Log, progress: Progress): Promise<void> {
  const checkpoint = () => { if (job.signal?.aborted) throw new AbortedError(ABORT_REASON); };
  checkpoint();
  // 预检之后到这里可能有人切了分支、挪了 HEAD（Codex 审第 11 轮 P2）：动手前再核一次
  const moved = await branchOrHeadChanged(job, oldHead);
  if (moved) throw new NotStartedError(moved);
  // 预检之后到这里可能有人改了程序文件：合并前再查一次（Codex 审第 5 轮 P1）
  const dirty = await trackedChanges(job.git);
  if (dirty) throw new NotStartedError(`程序文件刚刚有了本地改动（${firstLine(dirty)}…），自动更新会覆盖它们`);
  // 新版开始跟踪的路径，本地正好有一个被忽略 / 未跟踪的同名文件：合并会把它换掉。先列出来，不更新（Codex 审第 8 轮 P1）
  const clobber = await restoreConflicts(job, job.commit, oldHead);
  if (clobber.length) throw new NotStartedError(`新版本会覆盖这些不归 git 管的本地文件：${clobber.slice(0, 5).join("、")}${clobber.length > 5 ? ` 等 ${clobber.length} 个` : ""}，先把它们挪走再更新`);
  // --no-overwrite-ignore：万一上面没查到，git 自己也不覆盖被忽略的文件
  // 不跑用户仓库里的 git 钩子（core.hooksPath 指向空）：钩子不属于更新，慢钩子还会让合并超时（Codex 审第 10 轮 P1）
  let mergeError: unknown = null;
  try { await gitStep(job.git, ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-overwrite-ignore", job.commit], log); }
  catch (e) { mergeError = e; }
  // 合并报错不等于没动：超时、被打断时 HEAD 可能已经挪了。以真实的 HEAD 为准
  let head: string;
  try { head = await gitStep(job.git, ["rev-parse", "HEAD"], log); }
  catch (e) { if (mergeError) throw new UncertainStateError(`切到新版本出错，之后连当前版本都读不出来（${errText(e)}）`); throw e; }
  if (head === oldHead) throw new NotStartedError(mergeError ? errText(mergeError) : "合并后版本没有变化");
  if (head !== job.commit) throw new UncertainStateError(`切到新版本后，当前版本（${head.slice(0, 8)}）既不是原来的也不是要更新到的`);
  progress.movedTo = head;
  if (mergeError) throw new Error(`切到新版本时出错（${errText(mergeError)}），但版本已经换了`);
  log("== 安装依赖"); await job.steps.install(log, job.signal); checkpoint();
  log("== 构建前端"); await job.steps.build(log, job.signal); checkpoint();
  log("== 确认没有任务在跑"); await job.steps.quiesce(log); checkpoint();
  if (job.steps.activate) { log("== 换上新前端"); await job.steps.activate(log); }
  progress.touchedService = true;
  markRestarting();
  log("== 重启服务"); await job.steps.restart(log);
  log("== 健康检查"); await job.steps.health(log);
  // 新版过了检查：之后就算被打断（比如在清理旧依赖时），停在新版也算安装一致，不再叫人退回（第 15 轮 P2-1）
  try { markInflightVerified(job.machineDir); } catch (e) { log(`!! 写不了在途记录：${errText(e)}`); }
  markFinishing();
}

/**
 * 旧版本有、新版本没有的路径——reset 会把它们写回来。磁盘上已经有同名的未跟踪 / 被忽略文件（比如新版删掉、
 * 用户在更新途中又建了一个），或者某一级父路径被一个文件占着，reset 会悄悄覆盖：列出来，不退回（Codex 审第 7 轮 P1）。
 */
/**
 * 从 from 切到 to 时会被写出来、而磁盘上已经被不归 git 管（未跟踪 / 被忽略）的东西占着的路径。
 * 前进（新版开始跟踪一个本地被忽略的路径）和退回（旧版有、新版删掉的路径）都用它（Codex 审第 8 轮 P1）。
 */
async function restoreConflicts(job: UpdateJob, to: string, from: string): Promise<string[]> {
  const list = async (rev: string) => {
    const r = await job.git(["ls-tree", "-r", "--name-only", "-z", rev]);
    if (!r.ok) throw new Error(`读不出 ${rev.slice(0, 8)} 的文件清单（${firstLine(r.stderr)}）`);
    return r.stdout.split("\0").filter(Boolean);
  };
  const now = new Set(await list(from));
  // 文件 ↔ 目录互换（module ↔ module/index.ts）时，git 自己会换掉的那些不是本地数据：只拦真正不归 git 管的（Codex 审第 10 轮 P2）
  const trackedUnder = (dir: string) => { const prefix = `${dir}/`; for (const p of now) if (p.startsWith(prefix)) return true; return false; };
  const untrackedUnder = async (dir: string) => {
    const r = await job.git(["ls-files", "--others", "-z", "--", dir]);
    if (!r.ok) throw new Error(`读不出 ${dir} 里的文件（${firstLine(r.stderr)}）`);
    return r.stdout.split("\0").some(Boolean);
  };
  // 不区分大小写的文件系统（macOS 默认）：新版的 README.md 会命中本地被跟踪的 Readme.md——那是 git 自己会改名的文件，不是本地数据（第 12 轮 P2）
  const ic = await job.git(["config", "--bool", "core.ignorecase"]);
  const nowLower = firstLine(ic.stdout) === "true" ? new Set([...now].map((p) => p.toLowerCase())) : null;
  const occupied = async (rel: string): Promise<boolean> => {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(path.join(job.root, rel)); } catch { /* 不在 */ }
    if (st && nowLower?.has(rel.toLowerCase())) return false;
    if (st) return st.isDirectory() && trackedUnder(rel) ? untrackedUnder(rel) : true;
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join("/");
      let a: fs.Stats;
      try { a = fs.lstatSync(path.join(job.root, anc)); } catch { return false; }
      if (!a.isDirectory()) return !now.has(anc); // 是个被跟踪的文件：git 会把它换成目录；不被跟踪才是挡路的本地文件
    }
    return false;
  };
  const out: string[] = [];
  for (const p of await list(to)) if (!now.has(p) && await occupied(p)) out.push(p);
  return out;
}

/** 退回前发现工作区里有不是这次更新带来的改动：不 reset，给手动步骤 */
export class DirtyRollbackError extends Error {}

async function rollback(job: UpdateJob, oldHead: string, log: Log, restart: boolean, progress: Progress): Promise<"kept" | "restarted" | "not_restarted"> {
  // reset --hard 只在「这次真的把 HEAD 挪到了 movedTo、HEAD 还在那、而且相对它没有任何已跟踪改动」时才做：
  // 那时工作区里只有这次更新自己的东西，丢掉它不会丢用户的字（Codex 审第 5 轮 P1）
  const head = await gitStep(job.git, ["rev-parse", "HEAD"], log);
  if (!progress.movedTo || head !== progress.movedTo) throw new DirtyRollbackError(`当前版本不是这次更新合进来的那一版（${head.slice(0, 8)}），不自动退回`);
  const offBranch = await branchOrHeadChanged({ ...job, expectHead: undefined }, head);
  if (offBranch) throw new DirtyRollbackError(`${offBranch}，不自动退回`);
  const dirty = await trackedChanges(job.git);
  if (dirty) throw new DirtyRollbackError(`程序文件有不是这次更新带来的改动（${firstLine(dirty)}…），不自动退回，免得覆盖它们`);
  const clash = await restoreConflicts(job, oldHead, head);
  if (clash.length) throw new DirtyRollbackError(`退回会覆盖这些不归 git 管的文件：${clash.slice(0, 5).join("、")}${clash.length > 5 ? ` 等 ${clash.length} 个` : ""}，不自动退回`);
  await gitStep(job.git, ["reset", "--hard", oldHead], log);
  if (job.steps.restore) { log("== 退回：换回旧依赖与旧前端（不需要网络）"); await job.steps.restore(log); }
  else { log("== 退回：安装依赖"); await job.steps.install(log); log("== 退回：构建前端"); await job.steps.build(log); }
  // 因为有任务在跑而取消：旧服务一直没停，不重启（绝不掐断在跑的轮）
  if (!restart) {
    if (job.steps.ensureUp) await job.steps.ensureUp(log);
    else log("服务没有重启过，保持运行");
    return "kept";
  }
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
  log("== 退回：重启服务"); await job.steps.restart(log, { rollback: true });
  log("== 退回：健康检查"); await job.steps.health(log, { rollback: true });
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
  try {
    const swept = [...await sweepTrash(job.root), ...await sweepOrphanPrev(job.root, null)];
    if (swept.length) log(`清掉上次留下的垃圾目录 / 不再用得上的旧备份：${swept.join("、")}`);
  }
  catch (e) { log(`!! 清不掉上次留下的垃圾目录（不影响更新）：${errText(e)}`); }
  // 在途记录：被硬杀时下次能认出「上次更新中断了」；finish 时删掉
  try { writeInflight(job.machineDir, { at: at(), from: job.from, to: job.to, log: job.logFile, oldHead, commit: job.commit, ...(job.steps.backupStamp ? { stamp: job.steps.backupStamp } : {}) }); } catch (e) { log(`!! 写不了在途记录：${errText(e)}`); }
  const progress: Progress = { touchedService: false };
  try {
    await forward(job, oldHead, log, progress);
    if (job.steps.cleanup) await job.steps.cleanup(log).catch((e) => log(`!! 删旧依赖没删成（不影响使用，可手动删 *.prev-* 目录）：${errText(e)}`));
    return finish(job, { ok: true, outcome: "updated", at: at(), ...base, message: `已更新到 ${job.to}${job.steps.startedService?.() ? "，AutoCrew 已经启动" : ""}` }, log);
  } catch (e) {
    // 子进程被中止信号结束时，报的是「中止」而不是「装依赖失败」
    const aborted = e instanceof AbortedError || Boolean(job.signal?.aborted);
    const reason = aborted ? ABORT_REASON : errText(e);
    if (e instanceof UncertainStateError) {
      const cmds = manualCommands(job.root, oldHead, job.steps.manualRestore?.());
      log(`!! 更新中途状态不明：${reason}。请在终端手动恢复：\n${cmds.join("\n")}`);
      return finish(job, { ok: false, outcome: "stuck", at: at(), ...base, manualCommands: cmds,
        message: `更新中途状态不明（${reason}），没有自动退回。请在终端依次执行下面的命令恢复到 ${job.from}，完整记录在 ${job.logFile}` }, log);
    }
    if (e instanceof NotStartedError || !progress.movedTo) {
      log(`!! 更新没做：${reason}；没有动任何文件`);
      return finish(job, { ok: false, outcome: "not_started", at: at(), ...base,
        message: `更新没做：${reason}。没有动你的文件，仍是 ${job.from}，完整记录在 ${job.logFile}` }, log);
    }
    const busy = e instanceof QuiesceError;
    log(`!! 更新${busy ? "取消" : "失败"}：${reason}；开始退回 ${oldHead}`);
    try {
      const how = await rollback(job, oldHead, log, !busy, progress);
      // 服务本来没开、退回时把原来的版本起起来了：和成功时一样说一声（e2e 1002b N6）
      const startedNote = how === "restarted" && job.steps.startedService?.() ? "，AutoCrew 已经启动" : "";
      return finish(job, { ok: false, outcome: how !== "not_restarted" && busy ? "cancelled" : how !== "not_restarted" && aborted ? "aborted" : "rolled_back", at: at(), ...base,
        message: how === "not_restarted"
          ? `更新失败，已退回代码；服务没有重启（有任务在跑），等它们结束后运行 npm run restart。原因：${reason}，完整记录在 ${job.logFile}`
          : busy
          ? `更新取消了：${reason}。没有重启，仍是 ${job.from}，完整记录在 ${job.logFile}`
          : aborted
          ? `更新中止了：${reason}。已退回 ${job.from}${startedNote}，完整记录在 ${job.logFile}`
          : `更新失败，已退回 ${job.from}${startedNote}，原因：${reason}，完整记录在 ${job.logFile}` }, log);
    } catch (e2) {
      const restoreCmds = job.steps.manualRestore?.();
      const cmds = e2 instanceof DirtyRollbackError ? dirtyManualCommands(job.root, oldHead, restoreCmds) : manualCommands(job.root, oldHead, restoreCmds);
      log(`!! 退回也失败：${errText(e2)}。请在终端手动恢复：\n${cmds.join("\n")}`);
      return finish(job, { ok: false, outcome: "stuck", at: at(), ...base, manualCommands: cmds,
        message: `更新失败，自动退回也失败了（${errText(e2)}）。请在终端依次执行下面的命令恢复到 ${job.from}，完整记录在 ${job.logFile}` }, log);
    }
  }
}

function finish(job: UpdateJob, result: UpdateResult, log: Log): UpdateResult {
  log(result.message);
  try { writeResult(job.machineDir, result); } catch (e) { log(`!! 写不了更新结果：${errText(e)}`); }
  clearInflight(job.machineDir);
  return result;
}

/* ── 真实的四步（测试注入假的） ─────────────────────────────────────── */

/**
 * 跑一条命令。子进程放在自己的进程组：终端里的 Ctrl-C 只到更新进程，由它决定怎么收（中止就结束这一组）。
 * 失败原因只写人话（「装依赖没成功」），完整命令和输出留在日志里（e2e P3）。
 */
function runCommand(label: string, cmd: string, args: string[], cwd: string, log: Log, opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  log(`$ (${cwd}) ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new AbortedError(ABORT_REASON));
    const child = spawn(cmd, args, { cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const onAbort = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* 已经不在 */ } };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    // 装依赖、构建不许无限卡着（第 12 轮 P2）：到点结束这一组，按失败走退回
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; onAbort(); }, opts.timeoutMs) : null;
    const pipe = (chunk: Buffer) => { for (const l of chunk.toString("utf-8").split("\n")) if (l.trim()) log(l); };
    child.stdout.on("data", pipe);
    child.stderr.on("data", pipe);
    child.on("error", (e) => { log(`起不来：${e.message}`); reject(new Error(`${label}没开始（找不到要用的程序），详情见日志`)); });
    child.on("exit", (code, sig) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error(`${label}超时了（${Math.round(opts.timeoutMs! / 60_000)} 分钟没跑完），详情见日志`));
      if (code === 0) return resolve();
      if (opts.signal?.aborted) return reject(new AbortedError(ABORT_REASON));
      reject(new Error(`${label}没成功${sig ? "（被结束了）" : `（退出码 ${code}）`}，详情见日志`));
    });
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

export function realSteps(root: string, port: number, opts: { serverWasRunning: boolean; busy: () => Promise<string | null>; machineDir?: string; healthTimeoutMs?: number; npm?: string; installTimeoutMs?: number; buildTimeoutMs?: number }): UpdateSteps {
  const npm = opts.npm ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const swap = new DepsSwap(root);
  let nonceBefore: string | null = null;
  let startedForCheck = false;
  let skipRollbackStart = false;
  const installTimeout = opts.installTimeoutMs ?? 20 * 60_000;
  /** 调启动器：带上 AUTOCREW_UPDATER，启动器才知道这是更新自己在操作，不会因为更新锁拒绝 */
  const launcher = (cmd: string, label: string, log: Log) =>
    runCommand(label, process.execPath, [path.join(root, "bin", "autocrew.mjs"), cmd, "--no-open"], root, log,
      { env: { ...process.env, AUTOCREW_PORT: String(port), AUTOCREW_UPDATER: "1" } });
  return {
    activate: (log) => swap.activateDist(log),
    restore: async (log) => {
      if (swap.hasBackup) return await swap.restore(log);
      // 本来就没有依赖目录可留（全新安装）：只能重新装，尽量用本机缓存
      await swap.restore(log);
      await runCommand("重新安装依赖", npm, ["ci", "--prefer-offline", "--no-audit", "--no-fund"], root, log);
      await runCommand("重新安装前端依赖", npm, ["ci", "--prefer-offline", "--no-audit", "--no-fund"], path.join(root, "frontend"), log);
      await runCommand("重新构建前端", npm, ["run", "fe:build"], root, log);
    },
    cleanup: (log) => swap.cleanup(log),
    backupStamp: swap.stamp,
    ensureUp: async (log) => {
      if (!opts.serverWasRunning) return;
      const down = await (async () => { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }); return false; } catch { return true; } })();
      if (!down) { log("服务没有重启过，保持运行"); return; }
      log("服务这时不在了（可能被手动停了）：把原来的版本起回来");
      nonceBefore = launcherNonce(opts.machineDir ?? getMachineDir());
      await launcher("start", "启动原来的版本", log);
      await waitHealthy(`http://127.0.0.1:${port}/`, opts.healthTimeoutMs ?? 60_000, log, fetch, { port, machineDir: opts.machineDir ?? getMachineDir(), notNonce: nonceBefore });
    },
    manualRestore: () => swap.manualRestore(),
    quiesce: (log) => waitIdle(opts.busy, { timeoutMs: 120_000, intervalMs: 2_000, log }),
    serviceDown: async () => {
      try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }); return false; }
      catch { return true; }
    },
    install: async (log, signal) => {
      swap.backupDeps(log);
      await runCommand("装依赖", npm, ["ci", "--prefer-offline", "--no-audit", "--no-fund"], root, log, { signal, timeoutMs: installTimeout });
      await runCommand("装前端依赖", npm, ["ci", "--prefer-offline", "--no-audit", "--no-fund"], path.join(root, "frontend"), log, { signal, timeoutMs: installTimeout });
    },
    // 构建进 dist.next：等待期间旧进程照旧服务旧前端，确认没人在跑才换上（activate）
    build: (log, signal) => runCommand("构建前端", npm, ["run", "build", "--", "--outDir", "dist.next", "--emptyOutDir"], path.join(root, "frontend"), log, { signal, timeoutMs: opts.buildTimeoutMs ?? 10 * 60_000 }),
    restart: async (log, ctx) => {
      // 退回时：服务本来没开、更新也没起过它——代码和依赖已经换回，没有要重启的东西（第 13 轮 P2：别为了检查起一个再掐掉）
      if (ctx?.rollback && !opts.serverWasRunning && !startedForCheck) { skipRollbackStart = true; log("服务本来没在跑，退回后也不启动"); return; }
      // 记下重启前的启动标记：重启必须换出一个新的，健康检查只认新的（旧进程没停下来不能算重启成功）
      nonceBefore = launcherNonce(opts.machineDir ?? getMachineDir());
      // 服务本来没在跑：也把这一版起起来做健康检查，通过后就让它接着跑（第 13 轮 P2：起了再停会掐断启动时捡回来的剪辑 / 调研）
      // 检查用的服务还开着（上一次健康检查没过，现在是退回）：先停掉它再起旧版
      const cmd = opts.serverWasRunning || startedForCheck ? "restart" : "start";
      if (!opts.serverWasRunning) { startedForCheck = true; log("服务本来没在跑：把这一版起起来做健康检查，通过后让它接着跑"); }
      await launcher(cmd, opts.serverWasRunning ? "重启服务" : "启动服务做检查", log);
      const after = launcherNonce(opts.machineDir ?? getMachineDir());
      if (!after || after === nonceBefore) throw new Error("重启没有换出新的服务进程（旧的还在跑），详情见日志");
    },
    health: async (log, ctx) => {
      if (ctx?.rollback && skipRollbackStart) return;
      await waitHealthy(`http://127.0.0.1:${port}/`, opts.healthTimeoutMs ?? 60_000, log, fetch, { port, machineDir: opts.machineDir ?? getMachineDir(), notNonce: nonceBefore });
      if (startedForCheck) log("检查通过，AutoCrew 已经启动");
    },
    startedService: () => startedForCheck,
  };
}

/**
 * 健康检查：首页 200 还不够——端口上应答的必须是这一次启动器起的那个进程（启动标记对上，e2e P1-1），
 * 否则一个留下来没人管的旧进程（或别的程序）也能让「已更新 / 已退回」报成功。
 */
export async function waitHealthy(url: string, timeoutMs: number, log: Log, fetchImpl: typeof fetch = fetch,
  identity?: { port: number; machineDir: string; notNonce?: string | null }): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(3_000) });
      if (r.status === 200) {
        if (!identity) { log(`首页 200：${url}`); return; }
        const info = await fetchLaunchInfo(identity.port, fetchImpl);
        const fresh = !identity.notNonce || info?.nonce !== identity.notNonce;
        if (fresh && managedBy(info?.nonce, identity.machineDir)) { log(`首页 200，且是这次启动的进程：${url}`); return; }
        last = "端口上应答的不是这次启动的 AutoCrew";
      } else last = `HTTP ${r.status}`;
    } catch (e) { last = errText(e); }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`服务 ${Math.round(timeoutMs / 1000)} 秒内没回来（最后一次：${last}）`);
}
