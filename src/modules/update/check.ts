/**
 * 版本检查（self-update §2）：fetch tags → origin/main 上最高的 vX.Y.Z → 与 package.json 比 →
 * 本地 HEAD 必须是目标 tag 的祖先才算「有更新」（本地更新或分叉的机器不提示）。
 * 只读公开仓库，不上传任何东西。失败只落在状态里（设置页显示），不上看板。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstLine, gitRunner, type GitRunner } from "./git.js";
import { compareSemver, formatSemver, isNewer, parseSemver } from "./semver.js";
import { notesBetween, parseChangelog, shortDate, type ReleaseNotes } from "./changelog.js";
import { stillInterrupted } from "./interrupted.js";
import { lockHeld } from "./preflight.js";
import { files, readResult, readSettings, readStatus, writeStatus, type UpdateResult, type UpdateSettings, type UpdateStatus } from "./state.js";

export const FETCH_TIMEOUT_MS = 30_000;
export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

export interface CheckDeps { git?: GitRunner; now?: () => Date }

export function localVersion(root: string): string {
  try {
    const v = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch { return "0.0.0"; }
}

/** 程序根目录（本文件在 src/modules/update 下） */
export function programRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export const NOT_GIT = "这份 AutoCrew 不是用 git 装的，没法自动更新；请按 README 手动更新";

/** 是 git 安装吗：仓库根就是 git 工作区的顶层（装在别的仓库子目录里的不算） */
export async function isGitInstall(root: string, git: GitRunner): Promise<boolean> {
  const r = await git(["rev-parse", "--show-toplevel"]);
  if (!r.ok) return false;
  try { return fs.realpathSync(firstLine(r.stdout)) === fs.realpathSync(root); } catch { return false; }
}

async function fetchTags(git: GitRunner): Promise<string | null> {
  // --force：发布 tag 被重新指向（重打 tag 再强推）时，普通 fetch 会因「会覆盖已有 tag」整体失败；目标只认 ls-remote 给的提交，本地 tag 跟着 origin 走就行（第 12 轮 P2）
  const r = await git(["fetch", "--force", "--tags", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
  if (r.ok) return null;
  if (r.timedOut) return "连 GitHub 超过 30 秒没回应，稍后再查";
  return `连不上 GitHub（${firstLine(r.stderr) || "git fetch 失败"}）`;
}

export async function readNotesAt(git: GitRunner, tag: string, from: string, to: string): Promise<ReleaseNotes[]> {
  const r = await git(["show", `${tag}:CHANGELOG.md`]);
  return r.ok ? notesBetween(parseChangelog(r.stdout), from, to) : [];
}

export async function checkForUpdate(root: string, machineDir: string, deps: CheckDeps = {}): Promise<UpdateStatus> {
  // 更新正在跑：不检查。新版在健康检查那 60 秒里起的定时检查会把自己的版本写成「当前」，退回之后设置页就误报「已经是最新版」（第 16 轮 R3）
  const prevStatus = readStatus(machineDir);
  if (lockHeld(machineDir)) return prevStatus ?? { checkedAt: new Date().toISOString(), current: localVersion(root), available: false };
  const git = deps.git ?? gitRunner(root);
  const current = localVersion(root);
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const fail = (error: string): UpdateStatus => {
    // 检查失败不抹掉已知的新版本（规格 S2）：看板上的提示留着，失败原因只写在设置页
    const prev = readStatus(machineDir);
    const keep = prev?.available && prev.latest && isNewer(prev.latest, current)
      ? { available: true, latest: prev.latest, ...(prev.tag ? { tag: prev.tag } : {}), ...(prev.commit ? { commit: prev.commit } : {}), ...(prev.notes ? { notes: prev.notes } : {}) }
      : { available: false };
    const s: UpdateStatus = { checkedAt, current, ...keep, error };
    writeStatus(machineDir, s);
    return s;
  };
  if (!(await isGitInstall(root, git))) return fail(NOT_GIT);
  const fetchError = await fetchTags(git);
  if (fetchError) return fail(fetchError);
  const remote = await originReleases(git);
  if ("error" in remote) return fail(remote.error);
  const best = remote.best;
  const base = { checkedAt, current, ...(best ? { latest: best.version, tag: best.tag, commit: best.commit } : {}) };
  if (!best || !isNewer(best.version, current)) {
    const s: UpdateStatus = { ...base, available: false, reason: "up_to_date" };
    writeStatus(machineDir, s);
    return s;
  }
  const ancestor = await git(["merge-base", "--is-ancestor", "HEAD", best.commit]);
  if (!ancestor.ok) {
    // 发布版是本地的祖先 = 本地比它新；两边都不是对方的祖先 = 分叉（本地有发布版里没有的提交，又落后于发布版）
    const ahead = await git(["merge-base", "--is-ancestor", best.commit, "HEAD"]);
    const s: UpdateStatus = { ...base, available: false, reason: ahead.ok ? "local_ahead" : "diverged" };
    writeStatus(machineDir, s);
    return s;
  }
  const s: UpdateStatus = { ...base, available: true, notes: await readNotesAt(git, best.commit, current, best.version) };
  writeStatus(machineDir, s);
  return s;
}

/** `git ls-remote --tags` 的输出 → tag 名 → 提交（附注 tag 取 `^{}` 剥开后的提交） */
export function parseLsRemoteTags(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{40,64})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    if (m[3] || !map.has(m[2])) map.set(m[2], m[1]);
  }
  return map;
}

/**
 * origin 上真实存在、且在 origin/main 历史上的最高发布版（Codex 审第 2 轮 P2）。
 * 不看本地 tag：本地自己打的、或 origin 已经删掉的 tag 都不算发布版；目标钉在 origin 公布的那个提交上。
 */
async function originReleases(git: GitRunner): Promise<{ best: { tag: string; version: string; commit: string } | null } | { error: string }> {
  const r = await git(["ls-remote", "--tags", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
  if (!r.ok) return { error: r.timedOut ? "连 GitHub 超过 30 秒没回应，稍后再查" : `读不出 GitHub 上的发布版本（${firstLine(r.stderr)}）` };
  const tags = parseLsRemoteTags(r.stdout);
  const ordered = [...tags.keys()]
    .map((tag) => ({ tag, v: tag.startsWith("v") ? parseSemver(tag) : null }))
    .filter((x): x is { tag: string; v: NonNullable<ReturnType<typeof parseSemver>> } => x.v !== null)
    .sort((a, b) => compareSemver(b.v, a.v));
  for (const { tag, v } of ordered) {
    const commit = tags.get(tag)!;
    const onMain = await git(["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]);
    if (onMain.ok) return { best: { tag, version: formatSemver(v), commit } };
  }
  return { best: null };
}

/** 看板横幅：有更新、比本地新（更新完 package.json 变了自然消失）、不是「先不更新」的那一版 */
export function bannerFor(status: UpdateStatus | null, settings: UpdateSettings, current: string): { version: string; notes: ReleaseNotes[] } | null {
  if (!status?.available || !status.latest || !isNewer(status.latest, current)) return null;
  if (settings.skipVersion === status.latest) return null;
  return { version: status.latest, notes: status.notes ?? [] };
}

export interface UpdateView {
  current: string;
  currentDate: string | null;
  settings: UpdateSettings;
  status: UpdateStatus | null;
  banner: { version: string; notes: ReleaseNotes[] } | null;
  running: boolean;
  result: UpdateResult | null;
  /** 更新记录所在的目录：页面卡住时给人看（刷新过页面就不知道这一次的日志文件名了） */
  logDir: string;
}

export function currentDate(root: string, version: string): string | null {
  try {
    const hit = parseChangelog(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf-8")).find((n) => n.version === version);
    return hit ? shortDate(hit.date) : null;
  } catch { return null; }
}

/**
 * runningVersion：正在跑的这个进程启动时的版本（e2e 1002 P2-C）。磁盘上的 package.json 可能已经被一次没跑完的更新换成新的，
 * 设置页要显示的是真正在跑的那一版。
 */
export function updateView(root: string, machineDir: string, running: boolean, runningVersion?: string): UpdateView {
  const onDisk = localVersion(root);
  const current = runningVersion ?? onDisk;
  const settings = readSettings(machineDir);
  const status = readStatus(machineDir);
  const result = readResult(machineDir);
  return {
    current, currentDate: currentDate(root, current), settings, status,
    // 磁盘上已经是那一版（没跑完的更新留下的）：不再提示「有新版本」，点了也只会回「已经是最新版」——显示中断的结果（e2e 1002b N5）
    banner: (() => { const b = bannerFor(status, settings, current); return b && isNewer(b.version, onDisk) && !stillInterrupted(machineDir) ? b : null; })(),
    running,
    // 「上次更新中断」在恢复好之前一直显示：点过「知道了」也不消失（e2e 1002b N2）
    // 「上次更新中断」只在还中断着时显示（恢复好了就收起，不管点没点「知道了」，第 16 轮 P2-1）；别的结果按看没看过
    result: result && (result.interruptedAt ? stillInterrupted(machineDir) : !result.seen) ? result : null,
    logDir: files(machineDir).logDir,
  };
}

/** SessionStart 晨报的一句；没有可提示的更新就是 null */
export function briefLine(root: string, machineDir: string): string | null {
  const b = bannerFor(readStatus(machineDir), readSettings(machineDir), localVersion(root));
  return b ? `有新版本 ${b.version}，看板顶上点「更新」` : null;
}

/** 定时检查的一拍：自动检查关了就什么都不做（手动检查不走这里） */
export async function scheduledTick(root: string, machineDir: string, deps: CheckDeps = {}): Promise<UpdateStatus | "skipped"> {
  if (!readSettings(machineDir).autoCheck) return "skipped";
  return checkForUpdate(root, machineDir, deps);
}

/** 启动 1 分钟后查一次，之后每 24 小时一次；返回停止函数 */
export function startUpdateScheduler(root: string, machineDir: string, log: (msg: string) => void = console.error): () => void {
  let interval: NodeJS.Timeout | null = null;
  const tick = () => void scheduledTick(root, machineDir)
    .then((s) => { if (s !== "skipped" && s.error) log(`[update] 检查更新失败：${s.error}`); })
    .catch((err) => log(`[update] 检查更新失败：${err instanceof Error ? err.message : String(err)}`));
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, CHECK_INTERVAL_MS);
    interval.unref();
  }, FIRST_CHECK_DELAY_MS);
  first.unref();
  return () => { clearTimeout(first); if (interval) clearInterval(interval); };
}
