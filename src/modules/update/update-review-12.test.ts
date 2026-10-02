/**
 * 第 12 轮评审（Claude 代 Codex）：每条一个修之前会失败的用例。git 只碰临时仓库；装 / 建 / 重启全是假的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review12-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

describe("P2 发布 tag 被重新指向", () => {
  it("用户本地留着旧 tag：检查照常成功，目标是 origin 现在指向的提交", async () => {
    const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
    g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    const commit = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", v); };
    commit("0.4.0"); g(dev, "tag", "-a", "v0.4.0", "-m", "x"); g(dev, "push", "-q", "origin", "main", "--tags");
    g(tmp, "clone", "-q", origin, user);
    commit("0.5.0"); g(dev, "tag", "-a", "v0.5.0", "-m", "first"); g(dev, "push", "-q", "origin", "main", "--tags");
    g(user, "fetch", "-q", "--tags", "origin"); // 用户已经拉过第一版 v0.5.0
    fs.writeFileSync(path.join(dev, "CHANGELOG.md"), "fixed\n"); g(dev, "add", "CHANGELOG.md"); g(dev, "commit", "-q", "-m", "fix notes");
    g(dev, "tag", "-f", "-a", "v0.5.0", "-m", "second"); g(dev, "push", "-q", "-f", "origin", "main", "--tags");
    fs.mkdirSync(machine);
    const s = await checkForUpdate(user, machine, { git: gitRunner(user) });
    expect(s.error).toBeUndefined();
    expect(s).toMatchObject({ available: true, tag: "v0.5.0", commit: g(dev, "rev-parse", "v0.5.0^{commit}") });
  });
});

import { runUpdate, type UpdateSteps } from "./updater.js";

const fakeSteps = (calls: string[] = [], over: Partial<UpdateSteps> = {}): UpdateSteps => {
  const s = (n: string) => async () => { calls.push(n); };
  return { install: s("install"), build: s("build"), quiesce: s("quiesce"), serviceDown: async () => false, restart: s("restart"), health: s("health"), ...over };
};

/** origin 上 0.4.0 → 0.5.0，edit04 / edit05 各自改文件、返回要 add 的路径 */
async function releases(edit04: (d: string) => string[], edit05: (d: string) => string[]) {
  const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
  g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
  const rel = (v: string, edit: (d: string) => string[]) => {
    fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v }));
    g(dev, "add", "-A", "package.json", ...edit(dev)); g(dev, "commit", "-q", "-m", v); g(dev, "tag", "-a", `v${v}`, "-m", v); g(dev, "push", "-q", "origin", "main", "--tags");
  };
  rel("0.4.0", edit04); g(tmp, "clone", "-q", origin, user); rel("0.5.0", edit05);
  fs.mkdirSync(machine);
  await checkForUpdate(user, machine, { git: gitRunner(user) });
  return { user, machine, old: g(user, "rev-parse", "HEAD"), commit: g(user, "rev-parse", "v0.5.0^{commit}") };
}

describe("P2 文件名只改了大小写", () => {
  const caseInsensitive = (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-case-"));
    fs.writeFileSync(path.join(d, "a"), "");
    const yes = fs.existsSync(path.join(d, "A"));
    fs.rmSync(d, { recursive: true, force: true });
    return yes;
  })();

  it.skipIf(!caseInsensitive)("Readme.md → README.md（不区分大小写的盘）：照常更新，不说会覆盖本地文件", async () => {
    const { user, machine, commit } = await releases(
      (d) => { fs.writeFileSync(path.join(d, "Readme.md"), "说明\n"); return ["Readme.md"]; },
      (d) => { g(d, "mv", "Readme.md", "README.md"); return []; },
    );
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps: fakeSteps(), logFile: path.join(machine, "u.log") });
    expect(r.message).not.toContain("不归 git 管");
    expect(r).toMatchObject({ ok: true });
    expect(g(user, "ls-files")).toContain("README.md");
  });
});

import { createVideoRunner } from "../video/runner.js";
import { createResearchRunner } from "../research/research-runner.js";
import { saveTopic } from "../../storage/local-store.js";

describe("P2 剪辑与深调研在跑算忙", () => {
  it("剪辑 runner：投递后到跑完之前 busyCount > 0", async () => {
    const runner = createVideoRunner({ dataDir: tmp, deps: {}, launchId: "t", onError: () => {} });
    expect(runner.busyCount()).toBe(0);
    runner.enqueue("content-1-a");
    expect(runner.busyCount()).toBeGreaterThan(0);
    await runner.whenIdle();
    expect(runner.busyCount()).toBe(0);
    await runner.shutdown();
  });

  it("深调研 runner：跑的时候 busyCount = 1，跑完 0", async () => {
    let release!: () => void;
    const runner = createResearchRunner({ dataDir: tmp, onError: () => {},
      runJob: async () => { await new Promise<void>((r) => { release = r; }); return { status: "succeeded", perspectives: [], briefRevision: 1 }; } });
    const topic = await saveTopic({ title: "测试选题", description: "", tags: [] }, tmp);
    expect((await runner.trigger(topic.id)).accepted).toBe(true);
    while (!release) await new Promise((r) => setTimeout(r, 5));
    expect(runner.busyCount()).toBe(1);
    release();
    await runner.idle();
    expect(runner.busyCount()).toBe(0);
    runner.stop();
  });
});

describe("P2 服务把剪辑 / 深调研的在跑数交给更新判断", () => {
  it("desktop/server.ts 的 inProcessTurns 计入两个 runner", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "desktop", "server.ts"), "utf-8");
    const line = src.split("\n").find((l) => l.includes("inProcessTurns:")) ?? "";
    expect(line).toContain("videoService?.busyCount()");
    expect(line).toContain("researchBusyCount()");
  });
});

import net from "node:net";
import { spawnSync } from "node:child_process";
import { realSteps } from "./updater.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
/** 假服务：报启动暗号、打印启动链接；broken=true 就一起来就退出 */
function fakeServer(broken: boolean): string {
  const f = path.join(tmp, broken ? "broken-server.mjs" : "fake-server.mjs");
  fs.writeFileSync(f, broken ? "process.exit(3);\n" : `import http from "node:http";
http.createServer((req, res) => {
  if (req.url === "/__autocrew/launch") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, nonce: process.env.AUTOCREW_LAUNCH_NONCE, via: "launcher" }));
  res.writeHead(200).end("ok");
}).listen(Number(process.env.AUTOCREW_PORT), "127.0.0.1", () => console.log("http://127.0.0.1:" + process.env.AUTOCREW_PORT + "/?token=ab12"));
setInterval(() => {}, 1000);
`);
  return f;
}

describe("P2 服务本来没开：也要起一次新版做健康检查", () => {
  const prevLocal = process.env.AUTOCREW_LOCAL_DIR, prevScript = process.env.AUTOCREW_SERVER_SCRIPT, prevTimeout = process.env.AUTOCREW_LAUNCH_TIMEOUT_MS;
  afterEach(() => {
    for (const [k, v] of [["AUTOCREW_LOCAL_DIR", prevLocal], ["AUTOCREW_SERVER_SCRIPT", prevScript], ["AUTOCREW_LAUNCH_TIMEOUT_MS", prevTimeout]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const answers = async (port: number) => { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }); return true; } catch { return false; } };

  it("新版能起来：起一次、检查通过、再停掉（和更新前一样不在运行）", async () => {
    const port = await freePort();
    Object.assign(process.env, { AUTOCREW_LOCAL_DIR: tmp, AUTOCREW_SERVER_SCRIPT: fakeServer(false) });
    const lines: string[] = [];
    const steps = realSteps(REPO, port, { serverWasRunning: false, busy: async () => null, machineDir: tmp, healthTimeoutMs: 10_000 });
    await steps.restart((l) => lines.push(l));
    await steps.health((l) => lines.push(l));
    expect(lines.join("\n")).toContain("检查通过，已停掉");
    expect(await answers(port)).toBe(false);
  }, 40_000);

  it("新版起不来：重启 / 健康检查失败（交给退回），不报成功", async () => {
    const port = await freePort();
    Object.assign(process.env, { AUTOCREW_LOCAL_DIR: tmp, AUTOCREW_SERVER_SCRIPT: fakeServer(true), AUTOCREW_LAUNCH_TIMEOUT_MS: "2000" });
    const steps = realSteps(REPO, port, { serverWasRunning: false, busy: async () => null, machineDir: tmp, healthTimeoutMs: 2_000 });
    let ok = false;
    try { await steps.restart(() => {}); await steps.health(() => {}); ok = true; } catch { /* 应该失败 */ }
    expect(ok).toBe(false);
    spawnSync(process.execPath, [path.join(REPO, "bin", "autocrew.mjs"), "stop"], { env: { ...process.env, AUTOCREW_PORT: String(port) } });
  }, 40_000);
});

import { startEpoch } from "./process-start.js";
import { QuiesceError } from "./updater.js";

describe("P2 更新进行中，启动器不许启动 / 停止 / 重启", () => {
  it("活的更新锁在：start 拒绝并说人话；更新自己调（AUTOCREW_UPDATER=1）不受限", async () => {
    const port = await freePort();
    fs.writeFileSync(path.join(tmp, "update.lock"), JSON.stringify({ pid: process.pid, token: "t", at: "", start: startEpoch(process.pid) }));
    const env = { ...process.env, AUTOCREW_LOCAL_DIR: tmp, AUTOCREW_PORT: String(port), AUTOCREW_SERVER_SCRIPT: fakeServer(false) };
    const run = (cmd: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(REPO, "bin", "autocrew.mjs"), cmd, "--no-open"], { env: { ...env, ...extra }, encoding: "utf-8", timeout: 30_000 });
    for (const cmd of ["start", "restart", "stop"]) {
      const r = run(cmd);
      expect(r.status, cmd).toBe(1);
      expect(r.stderr, cmd).toContain("正在更新");
    }
    expect(run("start", { AUTOCREW_UPDATER: "1" }).status).toBe(0);
    expect(run("stop", { AUTOCREW_UPDATER: "1" }).status).toBe(0);
  }, 60_000);
});

describe("P2 取消（没重启）之后服务却不在了：把原来的版本起回来", () => {
  it("等不到空闲而取消、此时服务被人停了：调 ensureUp", async () => {
    const { user, machine, commit } = await releases(() => [], () => []);
    const calls: string[] = [];
    const steps = fakeSteps(calls, {
      quiesce: async () => { calls.push("quiesce"); throw new QuiesceError("有 1 个任务正在跑"); },
      ensureUp: async () => { calls.push("ensureUp"); },
    });
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(r.outcome).toBe("cancelled");
    expect(calls).toContain("ensureUp");
    expect(calls).not.toContain("restart");
  });
});

describe("P2 装依赖 / 构建有时限", () => {
  it("npm ci 卡住：到点结束、报超时（交给退回）", async () => {
    const npm = path.join(tmp, "slow-npm.sh");
    fs.writeFileSync(npm, "#!/bin/sh\nsleep 20\n", { mode: 0o755 });
    const err = await realSteps(tmp, 1, { serverWasRunning: false, busy: async () => null, npm, installTimeoutMs: 500 }).install(() => {}).catch((e: Error) => e);
    expect((err as Error).message).toContain("超时");
  }, 10_000);
});
