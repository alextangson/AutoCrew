/**
 * 第 16 轮增量评审：P2-1 恢复步骤每次按磁盘重算、可以重复跑、三处一致；P2-2 只认这次那一戳的备份、孤儿会被清掉。
 * 临时 git 仓库 + 拷贝的启动器；不起真服务。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectInterrupted, readInflight, recoveryCommands, writeInflight, type Inflight } from "./interrupted.js";
import { prepareUpdate } from "./start.js";
import { updateView } from "./check.js";
import { readResult } from "./state.js";
import { sweepOrphanPrev } from "./deps-swap.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
let tmp: string, root: string, m: string, old: string, neu: string;
const STAMP = "222";

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review16-")));
  root = path.join(tmp, "r"); m = path.join(tmp, "m");
  fs.mkdirSync(root); fs.mkdirSync(m);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root, env: ENV, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, ".gitignore"), "bin/\nnode_modules*\nfrontend/\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.4.9" }));
  g("add", ".gitignore", "package.json"); g("commit", "-q", "-m", "old"); old = g("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.5.0" }));
  g("commit", "-q", "-am", "new"); neu = g("rev-parse", "HEAD");
  // 构建时被杀：停在新版、没验证；三份备份都留着（这次的戳 222），新依赖装了一半
  for (const d of [`node_modules.prev-${STAMP}/.bin`, `frontend/node_modules.prev-${STAMP}/.bin`, `frontend/dist.prev-${STAMP}`, "node_modules/half"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, `node_modules.prev-${STAMP}`, ".bin", "tsx"), "");
  fs.writeFileSync(path.join(root, `frontend/node_modules.prev-${STAMP}`, ".bin", "vite"), "");
  fs.mkdirSync(path.join(root, "bin"));
  fs.copyFileSync(path.join(REPO, "bin", "autocrew.mjs"), path.join(root, "bin", "autocrew.mjs"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const inflight = (over: Partial<Inflight> = {}): Inflight => ({ at: new Date(Date.now() - 60_000).toISOString(), from: "0.4.9", to: "0.5.0", log: "/l", oldHead: old, commit: neu, stamp: STAMP, ...over });
const binStart = () => spawnSync(process.execPath, [path.join(root, "bin", "autocrew.mjs"), "start", "--no-open"], { env: { ...process.env, AUTOCREW_LOCAL_DIR: m, AUTOCREW_PORT: "1" }, encoding: "utf-8", timeout: 20_000 });
/** 三处给出的步骤：页面（结果文件）、命令行（prepareUpdate 的原因）、npm start（启动器） */
async function threeWays(): Promise<string[][]> {
  const page = detectInterrupted(root, m, { trustInstall: true, processStartedAt: Date.now() - 120_000 })?.manualCommands ?? [];
  const cli = await prepareUpdate(root, m, {});
  const cliSteps = cli.ok ? [] : cli.reason.split("\n").slice(1);
  const start = binStart().stderr.trim().split("\n").slice(1);
  return [page, cliSteps, start];
}

describe("P2-1 恢复步骤：每次按磁盘重算，三处一致，可以重复跑", () => {
  it("恢复做了一半（根目录依赖已经换回）：页面、命令行、npm start 给的是同一份剩下的步骤，且页面那份重新算没看过", async () => {
    writeInflight(m, inflight());
    const [first] = await threeWays();
    expect(first.filter((l) => l.includes(".prev-"))).toHaveLength(3);
    // 用户照做了第一行换回
    fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
    fs.renameSync(path.join(root, `node_modules.prev-${STAMP}`), path.join(root, "node_modules"));
    const [page, cli, start] = await threeWays();
    expect(page.filter((l) => l.includes(".prev-"))).toHaveLength(2);
    expect(cli).toEqual(page);
    expect(start).toEqual(page);
    expect(readResult(m)?.seen).toBeFalsy();
  });

  it("换回那一行跑两遍：第二遍什么都不做，不会删掉已经换回来的依赖", () => {
    const line = recoveryCommands(root, old, { stamp: STAMP }).find((l) => l.includes(`node_modules.prev-${STAMP}"`) && !l.includes("frontend"))!;
    for (let i = 0; i < 2; i++) spawnSync("sh", ["-c", line], { cwd: root });
    expect(fs.existsSync(path.join(root, "node_modules", ".bin", "tsx"))).toBe(true);
  });

  it("恢复好了（没点过「知道了」）：页面不再显示「需要你手动恢复」", () => {
    writeInflight(m, inflight());
    detectInterrupted(root, m, { trustInstall: true, processStartedAt: Date.now() - 120_000 });
    expect(updateView(root, m, false, "0.4.9").result).not.toBeNull();
    fs.rmSync(path.join(m, "update-inflight.json")); // 新起的服务认出安装一致、清掉记录
    expect(updateView(root, m, false, "0.4.9").result).toBeNull();
  });
});

describe("P2-2 只认这次那一戳的备份；孤儿会被清掉", () => {
  it("别的戳留下的旧备份不进恢复步骤；下次更新 / 启动时被清掉，这一戳的不碰", async () => {
    fs.mkdirSync(path.join(root, "node_modules.prev-111"));
    expect(recoveryCommands(root, old, { stamp: STAMP }).join("\n")).not.toContain("prev-111");
    const removed = await sweepOrphanPrev(root, STAMP);
    expect(removed).toEqual(["node_modules.prev-111"]);
    expect(fs.existsSync(path.join(root, `node_modules.prev-${STAMP}`))).toBe(true);
  });

  it("用户自己 git pull 往前走了：启动器删掉这一戳的旧备份再清记录，不留孤儿", () => {
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "pulled"], { cwd: root, env: ENV });
    writeInflight(m, inflight());
    const r = binStart();
    expect(r.stderr).toContain("不再提示恢复");
    expect(readInflight(m)).toBeNull();
    expect(fs.readdirSync(root).filter((n) => /\.prev-\d+$/.test(n))).toEqual([]);
  });

  it("安装一致（新版过了检查）：先删这一戳的备份，再清记录", () => {
    for (const d of ["node_modules/.bin", "frontend/node_modules/.bin"]) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/.bin/tsx"), "");
    fs.writeFileSync(path.join(root, "frontend/node_modules/.bin/vite"), "");
    writeInflight(m, inflight({ verified: true }));
    expect(detectInterrupted(root, m, { trustInstall: true })).toBeNull();
    expect(fs.readdirSync(root).filter((n) => /\.prev-\d+$/.test(n))).toEqual([]);
    expect(readInflight(m)).toBeNull();
  });
});

describe("P3 中断状态下 npm run restart", () => {
  it("先拒绝、不先停掉服务", () => {
    writeInflight(m, inflight());
    const r = spawnSync(process.execPath, [path.join(root, "bin", "autocrew.mjs"), "restart", "--no-open"], { env: { ...process.env, AUTOCREW_LOCAL_DIR: m, AUTOCREW_PORT: "1" }, encoding: "utf-8", timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("上次一键更新中断了");
    expect(`${r.stdout}${r.stderr}`).not.toContain("当前未由快速启动器运行"); // stop() 的输出：没走到停服务那一步
  });
});

import { checkForUpdate } from "./check.js";
import { readStatus, writeStatus } from "./state.js";
import { acquireLock, releaseLock } from "./preflight.js";
import { createAbortHandle, markRestarting, resetFinishing } from "./abort.js";
import { gitRunner } from "./git.js";

describe("P3 R3 更新进行中不检查", () => {
  it("更新锁在手：检查不跑、不改写状态（坏版在健康检查期间起的定时检查不能把自己写成「当前」）", async () => {
    writeStatus(m, { checkedAt: "2026-10-02T00:00:00Z", current: "0.4.9", latest: "0.5.0", tag: "v0.5.0", commit: neu, available: true });
    expect(acquireLock(m, "t")).toBe(true);
    try {
      await checkForUpdate(root, m, { git: gitRunner(root) });
      expect(readStatus(m)).toMatchObject({ checkedAt: "2026-10-02T00:00:00Z", current: "0.4.9", available: true });
    } finally { releaseLock(m, "t"); }
  });
});

describe("P3 R1 Ctrl-C 按更新走到哪一步来说", () => {
  it("新版正在启动和检查：说这一步不打断，不请求中止", () => {
    const said: string[] = [];
    markRestarting();
    try {
      const h = createAbortHandle((x) => said.push(x));
      h.onSignal(); h.onSignal();
      expect(said.every((x) => x.includes("新版正在启动和检查"))).toBe(true);
      expect(h.signal.aborted).toBe(false);
    } finally { resetFinishing(); }
  });

  it("前台不自己编「正在退回」：第二次 Ctrl-C 也只转给更新进程，由它来说", () => {
    const src = fs.readFileSync(path.join(REPO, "bin", "autocrew.mjs"), "utf-8");
    const fn = src.slice(src.indexOf("async function runDetachedUpdate"), src.indexOf("/** 进程启动时刻"));
    expect(fn).not.toContain("正在退回，请稍等");
  });
});

import { protectedStamps } from "./interrupted.js";
import { writeResult } from "./state.js";
import { DepsSwap } from "./deps-swap.js";
import { markRollingBack } from "./abort.js";

describe("第 17 轮 P3-1：自动退回也失败（stuck）之后，这次的备份还是恢复来源", () => {
  it("在途记录已清、结果里记着这一戳：孤儿清理不删它；手动恢复命令可以重复跑", async () => {
    // 结果文件：自动退回失败，记着这次的戳；在途记录已经被收尾清掉
    writeResult(m, { ok: false, outcome: "stuck", from: "0.4.9", to: "0.5.0", at: new Date().toISOString(), log: "/l", backupStamp: STAMP, message: "x" });
    const keep = protectedStamps(m);
    expect(keep).toEqual([STAMP]);
    await sweepOrphanPrev(root, keep!);
    expect(fs.existsSync(path.join(root, `node_modules.prev-${STAMP}`))).toBe(true);
    // 手动恢复命令那一行跑两遍：不会删掉已经换回来的依赖
    const swap = new DepsSwap(path.join(tmp, "x"), "5");
    fs.mkdirSync(path.join(tmp, "x", "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "x", "node_modules", ".bin", "tsx"), "");
    swap.backupDeps(() => {});
    fs.mkdirSync(path.join(tmp, "x", "node_modules"));
    const line = swap.manualRestore()[0]!;
    for (let i = 0; i < 2; i++) spawnSync("sh", ["-c", line], { cwd: path.join(tmp, "x") });
    expect(fs.existsSync(path.join(tmp, "x", "node_modules", ".bin", "tsx"))).toBe(true);
  });
});

describe("第 17 轮 P3-3：退回开始之后 Ctrl-C 说「正在退回」", () => {
  it("健康检查失败、开始退回：不再说新版在启动", () => {
    const said: string[] = [];
    markRestarting();
    markRollingBack();
    try {
      const h = createAbortHandle((x) => said.push(x));
      h.onSignal();
      expect(said[0]).toBe("正在退回，请稍等");
    } finally { resetFinishing(); }
  });
});
