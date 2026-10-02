/**
 * 更新被硬生生打断（进程被杀、机器重启、终端关掉之前的老版本……）之后不能一声不吭（第 12 轮 P1）。
 * 更新进程开始时写一份「在途」记录，正常收尾（无论成功、退回还是要手动恢复）就删掉；
 * 下次服务启动 / 再跑 autocrew update 时，在途记录还在、更新锁却没人拿着 = 上次更新中断了：
 * 写一份「上次更新中断」的结果（页面会弹出来），附上按磁盘现状算出的恢复命令（有留着的旧依赖就用它，不需要网络）。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { files, writeResult, type UpdateResult } from "./state.js";
import { lockHeld } from "./preflight.js";
import { PREV_NAME } from "./deps-swap.js";

export interface Inflight { at: string; from: string; to: string; log: string; oldHead: string; /** 要更新到的提交 */ commit?: string }

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

/**
 * 安装是一致的吗：当前版本就是更新前或要更新到的那一版，两份依赖都在（e2e 1002 P2-B）。
 * 是的话，上次虽然中断，现在这份安装能用——不用恢复，也不该叫人去动它。
 */
export function installConsistent(root: string, inflight: Inflight): boolean {
  const head = headOf(root);
  const known = head !== null && (head === inflight.oldHead || (inflight.commit !== undefined && head === inflight.commit));
  return known && depsComplete(root, "node_modules") && depsComplete(root, "frontend/node_modules");
}

/**
 * 按磁盘现状算恢复命令（第 12 轮 P1、e2e 1002 P2-B）：
 * - 有完整的 `.prev-<数字>`：改名换回（不需要网络）；删到一半的已经改名成 .trash-…，绝不拿来恢复；
 * - 没有备份、但现在的依赖是完整的：不动它（绝不叫人删掉 / 重装一份能用的依赖）；
 * - 两样都没有：才需要联网重装。
 */
export function recoveryCommands(root: string, oldHead: string): string[] {
  const steps: string[] = [];
  for (const rel of ["node_modules", "frontend/node_modules", "frontend/dist"]) {
    const dir = path.dirname(path.join(root, rel));
    const base = path.basename(rel);
    let prev: string[] = [];
    try { prev = fs.readdirSync(dir).filter((n) => PREV_NAME(base).test(n)).sort(); } catch { /* 目录不在 */ }
    const latest = prev[prev.length - 1];
    if (latest) { steps.push(`rm -rf "${rel}" && mv "${path.join(path.dirname(rel), latest).replace(/^\.\//, "")}" "${rel}"`); continue; }
    if (rel === "frontend/dist") continue;
    if (!depsComplete(root, rel)) steps.push(rel === "node_modules" ? "npm ci" : "(cd frontend && npm ci)");
  }
  if (!steps.some((c) => c.includes("frontend/dist"))) steps.push("npm run fe:build");
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
  if (opts.trustInstall && startedAfter && installConsistent(root, inflight)) {
    clearInflight(machineDir);
    fs.rmSync(files(machineDir).lock, { force: true });
    return null;
  }
  const cmds = recoveryCommands(root, inflight.oldHead);
  const result: UpdateResult = {
    ok: false, outcome: "stuck", from: inflight.from, to: inflight.to, at: new Date().toISOString(), log: inflight.log, manualCommands: cmds,
    message: `上次更新中断了（更新进程被关掉或机器重启了），没有跑完也没有自动退回。请在终端依次执行下面的命令恢复到 ${inflight.from}，记录在 ${inflight.log}`,
  };
  writeResult(machineDir, result);
  clearInflight(machineDir);
  fs.rmSync(files(machineDir).lock, { force: true }); // 锁的主人已经不在，留着的死锁一并清掉
  return result;
}
