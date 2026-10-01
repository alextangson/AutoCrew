/**
 * 版本检查（self-update §2）：fetch tags → origin/main 上最高的 vX.Y.Z → 与 package.json 比 →
 * 本地 HEAD 必须是目标 tag 的祖先才算「有更新」（本地更新或分叉的机器不提示）。
 * 只读公开仓库，不上传任何东西。失败只落在状态里（设置页显示），不上看板。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstLine, gitRunner, type GitRunner } from "./git.js";
import { highestTag, isNewer } from "./semver.js";
import { notesBetween, parseChangelog, shortDate, type ReleaseNotes } from "./changelog.js";
import { readResult, readSettings, readStatus, writeStatus, type UpdateResult, type UpdateSettings, type UpdateStatus } from "./state.js";

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
  const r = await git(["fetch", "--tags", "origin"], { timeoutMs: FETCH_TIMEOUT_MS });
  if (r.ok) return null;
  if (r.timedOut) return "连 GitHub 超过 30 秒没回应，稍后再查";
  return `连不上 GitHub（${firstLine(r.stderr) || "git fetch 失败"}）`;
}

export async function readNotesAt(git: GitRunner, tag: string, from: string, to: string): Promise<ReleaseNotes[]> {
  const r = await git(["show", `${tag}:CHANGELOG.md`]);
  return r.ok ? notesBetween(parseChangelog(r.stdout), from, to) : [];
}

export async function checkForUpdate(root: string, machineDir: string, deps: CheckDeps = {}): Promise<UpdateStatus> {
  const git = deps.git ?? gitRunner(root);
  const current = localVersion(root);
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const fail = (error: string): UpdateStatus => {
    const s: UpdateStatus = { checkedAt, current, available: false, error };
    writeStatus(machineDir, s);
    return s;
  };
  if (!(await isGitInstall(root, git))) return fail(NOT_GIT);
  const fetchError = await fetchTags(git);
  if (fetchError) return fail(fetchError);
  const tags = await git(["tag", "--merged", "refs/remotes/origin/main", "--list", "v*"]);
  if (!tags.ok) return fail(`读不出 GitHub 上的发布版本（${firstLine(tags.stderr)}）`);
  const best = highestTag(tags.stdout.split("\n"));
  const base = { checkedAt, current, ...(best ? { latest: best.version, tag: best.tag } : {}) };
  if (!best || !isNewer(best.version, current)) {
    const s: UpdateStatus = { ...base, available: false, reason: "up_to_date" };
    writeStatus(machineDir, s);
    return s;
  }
  const ancestor = await git(["merge-base", "--is-ancestor", "HEAD", `${best.tag}^{commit}`]);
  if (!ancestor.ok) {
    const s: UpdateStatus = { ...base, available: false, reason: "local_ahead" };
    writeStatus(machineDir, s);
    return s;
  }
  const s: UpdateStatus = { ...base, available: true, notes: await readNotesAt(git, best.tag, current, best.version) };
  writeStatus(machineDir, s);
  return s;
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
}

export function currentDate(root: string, version: string): string | null {
  try {
    const hit = parseChangelog(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf-8")).find((n) => n.version === version);
    return hit ? shortDate(hit.date) : null;
  } catch { return null; }
}

export function updateView(root: string, machineDir: string, running: boolean): UpdateView {
  const current = localVersion(root);
  const settings = readSettings(machineDir);
  const status = readStatus(machineDir);
  const result = readResult(machineDir);
  return {
    current, currentDate: currentDate(root, current), settings, status,
    banner: bannerFor(status, settings, current), running,
    result: result && !result.seen ? result : null,
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
