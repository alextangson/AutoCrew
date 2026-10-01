/**
 * Codex 审第 1 轮的五条（P1×3 + P2×2）：每条一个修之前会失败的用例。
 * git 只碰临时仓库；装 / 建 / 重启全是假的；「启动器起的」用真的 tsx 进程树验。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LAUNCH_ENV, LAUNCH_FILE, launchedByLauncher, serverBusy } from "./remote.js";
import { acquireLock, lockHeld, preflight, releaseLock, UPDATING_MESSAGE } from "./preflight.js";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";
import { QuiesceError, runUpdate, waitIdle, type UpdateSteps } from "./updater.js";
import { spawnDetachedUpdater } from "./start.js";
import { readResult } from "./state.js";
import { registerTurn, resetActiveTurns } from "../../desktop/turn-registry.js";
import { executePublish } from "../../tools/publish.js";
import { createUpdateHandler } from "../../desktop/update-route.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-upd-review-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("P1 启动器身份：tsx 拉起的 node 才是服务", () => {
  it("真 tsx 进程树：服务 pid ≠ 启动器记下的 tsx pid，但启动标记对得上", async () => {
    const nonce = "n-" + Date.now();
    fs.writeFileSync(path.join(tmp, LAUNCH_FILE), `${nonce}\n`);
    const probe = path.join(tmp, "probe.mts");
    fs.writeFileSync(probe, `import { launchedByLauncher } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src/modules/update/remote.ts")).href)};\n`
      + `console.log(JSON.stringify({ pid: process.pid, managed: launchedByLauncher(${JSON.stringify(tmp)}) }));\n`);
    const tsx = spawn(path.join(REPO, "node_modules/.bin/tsx"), [probe], { env: { ...process.env, [LAUNCH_ENV]: nonce } });
    let out = "";
    tsx.stdout.on("data", (c) => { out += c; });
    await new Promise((r) => tsx.on("exit", r));
    const seen = JSON.parse(out.trim()) as { pid: number; managed: boolean };
    expect(seen.pid).not.toBe(tsx.pid); // 旧判断「pid 文件 === process.pid」在真机上永远是 false
    expect(seen.managed).toBe(true);
  }, 30_000);

  it("没带标记（npm run serve）或标记过期：不算启动器起的", () => {
    fs.writeFileSync(path.join(tmp, LAUNCH_FILE), "new\n");
    expect(launchedByLauncher(tmp, {})).toBe(false);
    expect(launchedByLauncher(tmp, { [LAUNCH_ENV]: "old" })).toBe(false);
  });
});

describe("P1 命令行要问服务里的对话轮", () => {
  let server: http.Server, port: number, turns: number;
  beforeEach(async () => {
    turns = 0;
    process.env.AUTOCREW_TOKEN = "tok";
    const route = createUpdateHandler({
      authorize: (req) => (req.headers.authorization === "Bearer tok" ? "bearer" : null), originAllowed: () => false,
      readBody: async () => "", root: tmp, machineDir: tmp, port: 0, inProcessTurns: () => turns, runAlive: () => false,
    });
    server = http.createServer((req, res) => void route(req, res, new URL(req.url!, "http://x")).then((h) => { if (!h) res.writeHead(404).end(); }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as import("node:net").AddressInfo).port;
  });
  afterEach(async () => { delete process.env.AUTOCREW_TOKEN; await new Promise((r) => server.close(r)); });

  it("服务里有轮在跑 → 忙；空闲 → null；凭证不对 → 抛（当没法确认）", async () => {
    expect(await serverBusy(port)).toBeNull();
    turns = 1;
    expect(await serverBusy(port)).toMatch(/正在跑/);
    process.env.AUTOCREW_TOKEN = "wrong";
    await expect(serverBusy(port)).rejects.toThrow(/HTTP 403/);
  });

  it("预检：服务说忙就拒；问不到也拒并说原因", async () => {
    const origin = path.join(tmp, "o.git"), user = path.join(tmp, "u");
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g(tmp, "init", "-q", "-b", "main", user);
    fs.writeFileSync(path.join(user, "package.json"), "{}"); g(user, "add", "package.json"); g(user, "commit", "-q", "-m", "a"); g(user, "tag", "v0.5.0");
    void origin;
    const machine = path.join(tmp, "m"); fs.mkdirSync(machine);
    const base = { git: gitRunner(user), runAlive: () => false };
    expect(await preflight(user, machine, "v0.5.0", { ...base, remoteBusy: async () => "有 1 个任务正在跑" })).toMatchObject({ ok: false, code: "busy" });
    expect(await preflight(user, machine, "v0.5.0", { ...base, remoteBusy: async () => { throw new Error("问不到服务"); } })).toMatchObject({ ok: false, code: "busy_unknown", reason: expect.stringContaining("没法确认") });
    expect(await preflight(user, machine, "v0.5.0", { ...base, remoteBusy: async () => null })).toEqual({ ok: true });
  });
});

describe("P1 更新中不开新活，重启前再确认", () => {
  const prev = process.env.AUTOCREW_LOCAL_DIR;
  beforeEach(() => { process.env.AUTOCREW_LOCAL_DIR = tmp; });
  afterEach(() => { if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev; });

  it("锁在手：新对话轮（含本机 agent 轮）与发布动作都回「正在更新，稍后再试」；放锁后照常", async () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    expect(registerTurn("turn-upd-1", "c1")).toEqual({ ok: false, error: UPDATING_MESSAGE });
    expect(await executePublish({ action: "ego_lite_prepare", content_id: "content-1-a", _dataDir: tmp })).toMatchObject({ ok: false, code: "updating", error: UPDATING_MESSAGE });
    releaseLock(tmp, "t");
    expect(registerTurn("turn-upd-2", "c2")).toMatchObject({ ok: true });
    resetActiveTurns();
  });

  it("等空闲：一直忙到上限 → QuiesceError；中途空了 → 放行", async () => {
    const log = () => {};
    await expect(waitIdle(async () => "有 1 个任务正在跑", { timeoutMs: 0, intervalMs: 0, log })).rejects.toBeInstanceOf(QuiesceError);
    let n = 0;
    await expect(waitIdle(async () => (++n < 3 ? "忙" : null), { timeoutMs: 10_000, intervalMs: 0, log, sleep: async () => {} })).resolves.toBeUndefined();
  });

  it("重启前还有轮在跑：取消更新、退回旧版本、不重启、放锁后页面看得见", async () => {
    const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    const rel = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", v); g(dev, "tag", `v${v}`); g(dev, "push", "-q", "origin", "main", "--tags"); };
    rel("0.4.0"); g(tmp, "clone", "-q", origin, user); rel("0.5.0");
    const machine = path.join(tmp, "m"); fs.mkdirSync(machine);
    await checkForUpdate(user, machine, { git: gitRunner(user) });
    const old = g(user, "rev-parse", "HEAD");
    const calls: string[] = [];
    const step = (name: string, fail = false) => async () => { calls.push(name); if (fail) throw new QuiesceError("等了 120 秒还有任务在跑：有 1 个任务正在跑"); };
    const steps: UpdateSteps = { quiesce: step("quiesce", true), install: step("install"), build: step("build"), restart: step("restart"), health: step("health") };
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit: g(user, "rev-parse", "v0.5.0^{commit}"), from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(r).toMatchObject({ ok: false, outcome: "rolled_back" });
    expect(r.message).toMatch(/更新取消了.*没有重启，仍是 0\.4\.0/);
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(calls).toEqual(["install", "build", "quiesce", "install", "build"]);
    expect(calls).not.toContain("restart");
  });
});

describe("P2 更新进程起不来要如实报", () => {
  it("tsx 不在：等到 error 才回答，放锁，写「更新没能开始」给页面", async () => {
    expect(acquireLock(tmp, "tok")).toBe(true);
    const r = await spawnDetachedUpdater(tmp, tmp, 1, { ok: true, tag: "v0.5.0", commit: "a".repeat(40), from: "0.4.0", to: "0.5.0", notes: [], token: "tok" });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("更新没能开始") });
    expect(lockHeld(tmp)).toBe(false);
    expect(readResult(tmp)).toMatchObject({ ok: false, outcome: "not_started", message: expect.stringContaining("更新没能开始") });
  });
});
