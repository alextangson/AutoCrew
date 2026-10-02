/**
 * 更新被硬生生打断（进程被杀、机器重启、终端关掉之前的老版本……）之后不能一声不吭（第 12 轮 P1）。
 * 更新进程开始时写一份「在途」记录，正常收尾（无论成功、退回还是要手动恢复）就删掉；
 * 下次服务启动 / 再跑 autocrew update 时，在途记录还在、更新锁却没人拿着 = 上次更新中断了：
 * 写一份「上次更新中断」的结果（页面会弹出来），附上按磁盘现状算出的恢复命令（有留着的旧依赖就用它，不需要网络）。
 */
import fs from "node:fs";
import path from "node:path";
import { files, writeResult, type UpdateResult } from "./state.js";
import { lockHeld } from "./preflight.js";
import { PREV_NAME } from "./deps-swap.js";

export interface Inflight { at: string; from: string; to: string; log: string; oldHead: string }

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

/** 按磁盘上还留着的旧依赖 / 旧前端算恢复命令：有就改名换回（不需要网络），没有才重新装 */
export function recoveryCommands(root: string, oldHead: string): string[] {
  const back: string[] = [];
  for (const rel of ["node_modules", "frontend/node_modules", "frontend/dist"]) {
    const dir = path.dirname(path.join(root, rel));
    const base = path.basename(rel);
    let prev: string[] = [];
    // 只认完整的 `.prev-<数字>`；删到一半的已经改名成 .trash-…，绝不拿来恢复（e2e 1002 P1-A）
    try { prev = fs.readdirSync(dir).filter((n) => PREV_NAME(base).test(n)).sort(); } catch { /* 目录不在 */ }
    const latest = prev[prev.length - 1];
    if (latest) back.push(`rm -rf "${rel}" && mv "${path.join(path.dirname(rel), latest).replace(/^\.\//, "")}" "${rel}"`);
  }
  const deps = back.some((c) => c.includes("node_modules")) ? back : ["npm ci", "(cd frontend && npm ci)", "npm run fe:build"];
  return [`cd "${root}"`, `git reset --hard ${oldHead}`, ...deps, "npm run restart"];
}

/** 上次更新中断了吗？是就写一份结果、清掉在途记录，返回这份结果；否则 null。更新锁有人拿着（还在跑）不算 */
export function detectInterrupted(root: string, machineDir: string): UpdateResult | null {
  const inflight = readInflight(machineDir);
  if (!inflight || lockHeld(machineDir)) return null;
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
