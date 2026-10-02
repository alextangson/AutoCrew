/**
 * Codex 审第 10 轮（P1×2 + P2）：每条一个修之前会失败的用例。git 只碰临时仓库；装 / 建 / 重启全是假的；
 * 重启那条用真的 bin/autocrew.mjs + 假服务脚本（不起真服务）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { realSteps, runUpdate, type UpdateSteps } from "./updater.js";
import { checkForUpdate } from "./check.js";
import { gitRunner, type GitRunner } from "./git.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string;
const prev = process.env.AUTOCREW_LOCAL_DIR;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review10-")); });
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

/** origin 上 0.4.0 → 0.5.0；edit 在两个版本上各自改动文件 */
async function repos(edit04: (d: string) => string[], edit05: (d: string) => string[]) {
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
const fakeSteps = (calls: string[], over: Partial<UpdateSteps> = {}): UpdateSteps => {
  const s = (n: string) => async () => { calls.push(n); };
  return { install: s("install"), build: s("build"), quiesce: s("quiesce"), serviceDown: async () => false, restart: s("restart"), health: s("health"), ...over };
};

describe("P1 合并报错但 HEAD 已经挪了", () => {
  it("合并超时（其实已经切过去了）：按真实 HEAD 走正常退回，不说「没有动你的文件」", async () => {
    const { user, machine, old, commit } = await repos(() => [], () => []);
    const real = gitRunner(user);
    // 合并真的做了，但报超时（慢钩子跑过了时限的样子）
    const git: GitRunner = async (args, o) => {
      const r = await real(args, o);
      return args.includes("merge") ? { ...r, ok: false, timedOut: true } : r;
    };
    const calls: string[] = [];
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git, steps: fakeSteps(calls), logFile: path.join(machine, "u.log") });
    expect(r.outcome).toBe("rolled_back");
    expect(r.message).not.toContain("没有动你的文件");
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
  });

  it("合并时不跑用户仓库的钩子：慢的 post-merge 钩子不拖住更新", async () => {
    const { user, machine, commit } = await repos(() => [], () => []);
    const marker = path.join(tmp, "hook-ran");
    fs.writeFileSync(path.join(user, ".git", "hooks", "post-merge"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const calls: string[] = [];
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps: fakeSteps(calls), logFile: path.join(machine, "u.log") });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

/** 前进时构建失败一次，退回时的构建照常 */
const failOnce = () => { let n = 0; return async () => { if (n++ === 0) throw new Error("构建坏了"); }; };

describe("P2 文件 ↔ 目录互换不算本地数据冲突", () => {
  const fileThenDir = () => repos(
    (d) => { fs.writeFileSync(path.join(d, "module"), "单文件\n"); return ["module"]; },
    (d) => { fs.rmSync(path.join(d, "module")); fs.mkdirSync(path.join(d, "module")); fs.writeFileSync(path.join(d, "module/index.ts"), "export {}\n"); return ["module"]; },
  );
  it("前进：module 文件 → module/index.ts，正常更新", async () => {
    const { user, machine, commit } = await fileThenDir();
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps: fakeSteps([]), logFile: path.join(machine, "u.log") });
    expect(r).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(user, "module/index.ts"))).toBe(true);
  });

  it("退回：module/index.ts → module 文件，正常退回", async () => {
    const { user, machine, old, commit } = await fileThenDir();
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user),
      steps: fakeSteps([], { build: failOnce() }), logFile: path.join(machine, "u.log") });
    expect(r).toMatchObject({ ok: false, outcome: "rolled_back" });
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(fs.readFileSync(path.join(user, "module"), "utf-8")).toBe("单文件\n");
  });

  it("目录里有用户自己放的未跟踪文件：照样拦住，不覆盖", async () => {
    const { user, machine, commit } = await fileThenDir();
    const r1 = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user),
      steps: fakeSteps([], { install: async () => { fs.writeFileSync(path.join(user, "module/notes.md"), "我的\n"); }, build: failOnce() }),
      logFile: path.join(machine, "u.log") });
    expect(r1).toMatchObject({ outcome: "stuck" });
    expect(fs.readFileSync(path.join(user, "module/notes.md"), "utf-8")).toBe("我的\n");
  });
});

describe("P1 重启没换出新进程不算成功", () => {
  it("旧服务的进程记录丢了、停不下来：重启失败，健康检查不认旧标记", async () => {
    const port = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
    process.env.AUTOCREW_LOCAL_DIR = tmp;
    const fake = path.join(tmp, "fake-server.mjs");
    fs.writeFileSync(fake, `import http from "node:http";
http.createServer((req, res) => {
  if (req.url === "/__autocrew/launch") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, nonce: process.env.AUTOCREW_LAUNCH_NONCE, via: "launcher" }));
  res.writeHead(200).end("ok");
}).listen(Number(process.env.AUTOCREW_PORT), "127.0.0.1", () => console.log("http://127.0.0.1:" + process.env.AUTOCREW_PORT + "/?token=ab12"));
setInterval(() => {}, 1000);
`);
    const env = { ...process.env, AUTOCREW_LOCAL_DIR: tmp, AUTOCREW_PORT: String(port), AUTOCREW_SERVER_SCRIPT: fake };
    const launcher = (cmd: string) => spawnSync(process.execPath, [path.join(REPO, "bin", "autocrew.mjs"), cmd, "--no-open"], { env, encoding: "utf-8", timeout: 30_000 });
    expect(launcher("start").status).toBe(0);
    const pid = Number(fs.readFileSync(path.join(tmp, "autocrew.pid"), "utf-8"));
    fs.rmSync(path.join(tmp, "autocrew.pid")); // 进程记录丢了
    try {
      const steps = realSteps(REPO, port, { serverWasRunning: true, busy: async () => null, machineDir: tmp, healthTimeoutMs: 3_000 });
      let ok = false;
      try { await steps.restart(() => {}); await steps.health(() => {}); ok = true; } catch { /* 应该失败 */ }
      expect(ok).toBe(false);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* 已经不在 */ } }
    }
  }, 40_000);
});
