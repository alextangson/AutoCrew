/**
 * 更新被硬生生打断（进程被杀、机器重启、终端关掉之前的老版本……）之后不能一声不吭（第 12 轮 P1）。
 * 更新进程开始时写一份「在途」记录，正常收尾（无论成功、退回还是要手动恢复）就删掉；
 * 下次服务启动 / 再跑 autocrew update 时，在途记录还在、更新锁却没人拿着 = 上次更新中断了：
 * 写一份「上次更新中断」的结果（页面会弹出来），附上按磁盘现状算出的恢复命令（有留着的旧依赖就用它，不需要网络）。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { files, readResult, writeResult, type UpdateResult } from "./state.js";
import { lockHeld } from "./preflight.js";
import { discardSoon, PREV_NAME, PREV_TARGETS } from "./deps-swap.js";

export interface Inflight {
  at: string; from: string; to: string; log: string; oldHead: string;
  /** 要更新到的提交 */ commit?: string;
  /** 新版已经过了健康检查（第 15 轮 P2-1） */ verified?: boolean;
  /** 这次留旧依赖备份用的时间戳：只认 `*.prev-<戳>`，别的戳都是孤儿（第 16 轮 P2-2） */ stamp?: string;
}

/** 这次在途记录对应的备份名（有戳只认那一戳；老记录没戳就认任意 `.prev-<数字>`） */
function prevMatcher(inflight: Pick<Inflight, "stamp">, base: string): (n: string) => boolean {
  return inflight.stamp ? (n) => n === `${base}.prev-${inflight.stamp}` : (n) => PREV_NAME(base).test(n);
}

/** 这次留下、还在的完整备份：[相对目标路径, 相对备份路径] */
function prevDirs(root: string, inflight: Pick<Inflight, "stamp">): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rel of PREV_TARGETS) {
    const dir = path.dirname(path.join(root, rel));
    const base = path.basename(rel);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter(prevMatcher(inflight, base)).sort(); } catch { continue; }
    const latest = names[names.length - 1];
    if (latest) out.push([rel, path.join(path.dirname(rel), latest).replace(/^\.\//, "")]);
  }
  return out;
}

const inflightFile = (machineDir: string) => path.join(machineDir, "update-inflight.json");

export function writeInflight(machineDir: string, body: Inflight): void {
  fs.mkdirSync(machineDir, { recursive: true });
  const f = inflightFile(machineDir);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(body));
  fs.renameSync(`${f}.tmp`, f);
}

export function clearInflight(machineDir: string): void {
  fs.rmSync(inflightFile(machineDir), { force: true });
}

export function readInflight(machineDir: string): Inflight | null {
  try { return JSON.parse(fs.readFileSync(inflightFile(machineDir), "utf-8")) as Inflight; } catch { return null; }
}

/** 依赖目录看着是完整、能用的吗（以 .bin 里的关键命令为准：根目录 tsx、前端 vite） */
const DEP_MARKERS: Record<string, string> = { "node_modules": "node_modules/.bin/tsx", "frontend/node_modules": "frontend/node_modules/.bin/vite" };
export function depsComplete(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, DEP_MARKERS[rel] ?? rel));
}

function headOf(root: string): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

function hasCompletePrev(root: string, inflight: Pick<Inflight, "stamp">): boolean {
  return prevDirs(root, inflight).length > 0;
}

function trackedClean(root: string): boolean {
  try { return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() === ""; } catch { return false; }
}

export type InstallState = "consistent" | "moved_on" | "inconsistent";

/**
 * 上次中断之后，这份安装是什么状态（第 15 轮 P2-1）：
 * - consistent：要么已经在新版、而且新版过了健康检查（在途记录标了 verified）；要么还在旧版、没有留着的完整旧依赖、程序文件没改动，
 *   两份依赖都在——能用，不用恢复；
 * - moved_on：版本既不是旧的也不是新的、工作区干净——用户自己 git pull 换了版本，不再管这次中断；
 * - inconsistent：其余一律要恢复（比如在新版但没验证过、或在旧版却还留着完整的旧依赖备份没换回来）。
 */
export function installState(root: string, inflight: Inflight): InstallState {
  const head = headOf(root);
  if (head === null) return "inconsistent";
  const depsOk = depsComplete(root, "node_modules") && depsComplete(root, "frontend/node_modules");
  if (inflight.commit !== undefined && head === inflight.commit) return inflight.verified && depsOk ? "consistent" : "inconsistent";
  if (head === inflight.oldHead) return depsOk && !hasCompletePrev(root, inflight) && trackedClean(root) ? "consistent" : "inconsistent";
  return trackedClean(root) ? "moved_on" : "inconsistent";
}

export function installConsistent(root: string, inflight: Inflight): boolean {
  return installState(root, inflight) === "consistent";
}

/** 删掉这次留着的完整旧依赖 / 旧前端：同步改名成垃圾名（返回时原名已不在），垃圾稍后异步删。只在它们不再是恢复来源时调 */
export function discardPrevDirs(root: string, inflight: Pick<Inflight, "stamp">): void {
  for (const [, prev] of prevDirs(root, inflight)) discardSoon(path.join(root, prev));
}

/** 这份结果是「上次更新中断」吗：是的话只在还中断着时显示（恢复好了就不显示，不管点没点过「知道了」，第 16 轮 P2-1） */
export function stillInterrupted(machineDir: string): boolean {
  const r = readResult(machineDir), inflight = readInflight(machineDir);
  return Boolean(r?.interruptedAt && inflight && r.interruptedAt === inflight.at);
}

/** 新版过了健康检查：在途记录标上 verified——之后再被打断，停在新版也算安装一致 */
export function markInflightVerified(machineDir: string): void {
  const cur = readInflight(machineDir);
  if (cur) writeInflight(machineDir, { ...cur, verified: true });
}

/**
 * 按磁盘现状算恢复命令（第 12 轮 P1、e2e 1002 P2-B、第 16 轮 P2-1/P2-2）：
 * - 这次留着的完整备份 `.prev-<戳>`：改名换回（不需要网络）。这一行可以重复跑：备份已经换回去了就什么都不做；
 * - 没有备份、但现在的依赖是完整的：不动它（绝不叫人删掉 / 重装一份能用的依赖）；
 * - 两样都没有：才需要联网重装。
 * bin/autocrew.mjs 的纯 JS 版逐字同一套输出（启动器、命令行、页面给出的步骤必须一样）。
 */
export function recoveryCommands(root: string, oldHead: string, inflight: Pick<Inflight, "stamp"> = {}): string[] {
  const steps: string[] = [];
  const backups = new Map(prevDirs(root, inflight));
  for (const rel of PREV_TARGETS) {
    const prev = backups.get(rel);
    if (prev) { steps.push(`[ -d "${prev}" ] && { rm -rf "${rel}" && mv "${prev}" "${rel}"; }`); continue; }
    if (rel === "frontend/dist") continue;
    if (!depsComplete(root, rel)) steps.push(rel === "node_modules" ? "npm ci" : "(cd frontend && npm ci)");
  }
  if (!backups.has("frontend/dist")) steps.push("npm run fe:build");
  return [`cd "${root}"`, `git reset --hard ${oldHead}`, ...steps, "npm run restart"];
}

/**
 * 上次更新中断了吗（在途记录还在、更新锁没人拿着）：
 * - trustInstall（新起的服务 / 命令行，能判断磁盘上的安装）且安装一致：上次虽然断了，现在能用——清掉记录，不报；
 * - 否则写一份「上次更新中断」结果、清掉记录，返回它。
 * 还在跑的旧服务（在中断之前就起来的）不能拿「安装看着一致」当没事：它跑的是旧代码（e2e 1002 P2-C）。
 */
export function detectInterrupted(root: string, machineDir: string, opts: { trustInstall?: boolean; processStartedAt?: number } = {}): UpdateResult | null {
  const inflight = readInflight(machineDir);
  if (!inflight || lockHeld(machineDir)) return null;
  const startedAfter = opts.processStartedAt === undefined || opts.processStartedAt > Date.parse(inflight.at);
  const state = opts.trustInstall && startedAfter ? installState(root, inflight) : "inconsistent";
  fs.rmSync(files(machineDir).lock, { force: true }); // 锁的主人已经不在，留着的死锁一并清掉
  if (state !== "inconsistent") {
    if (state === "moved_on") console.error("[update] 上次一键更新中断后，程序已经换成别的版本（像是自己 git pull 过），不再提示恢复");
    // 安装已经一致：这次留着的旧依赖 / 旧前端不再是恢复来源了，先删（改名走）再清记录，不留孤儿（e2e 1002b N7、第 16 轮 P2-2）
    try { discardPrevDirs(root, inflight); } catch (err) { console.error("[update] 删留着的旧依赖失败:", err instanceof Error ? err.message : err); }
    clearInflight(machineDir);
    return null;
  }
  // 在途记录留着，直到真的恢复好（e2e 1002b N2）。步骤每次按磁盘现状重算：恢复做了一半，给的就是剩下的那几步（第 16 轮 P2-1）
  const cmds = recoveryCommands(root, inflight.oldHead, inflight);
  const existing = readResult(machineDir);
  if (existing?.interruptedAt === inflight.at && JSON.stringify(existing.manualCommands) === JSON.stringify(cmds)) return existing;
  const result: UpdateResult = {
    ok: false, outcome: "stuck", from: inflight.from, to: inflight.to, at: new Date().toISOString(), log: inflight.log, manualCommands: cmds,
    interruptedAt: inflight.at,
    message: `上次更新中断了（更新进程被关掉或机器重启了），没有跑完也没有自动退回。请在终端依次执行下面的命令恢复到 ${inflight.from}，记录在 ${inflight.log}`,
  };
  writeResult(machineDir, result);
  return result;
}
