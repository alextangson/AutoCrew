/**
 * Codex 审第 11 轮：P1 浏览器写请求统一算在跑；P2 动手前（合并、退回）再核分支与 HEAD。每条一个修之前会失败的用例。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { admitMutation } from "../../desktop/http-busy-guard.js";
import { acquireLock, releaseLock, UPDATING_MESSAGE } from "./preflight.js";
import { activeWorkCount, resetActiveWork } from "./active-work.js";
import { runUpdate, type UpdateSteps } from "./updater.js";
import { checkForUpdate } from "./check.js";
import { gitRunner, type GitRunner } from "./git.js";

let tmp: string;
const prev = process.env.AUTOCREW_LOCAL_DIR;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review11-")); process.env.AUTOCREW_LOCAL_DIR = tmp; resetActiveWork(); });
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  resetActiveWork();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P1 浏览器写请求：不在任何清单里的路由也算在跑", () => {
  let server: http.Server, base: string, release: () => void, seen: number;
  beforeEach(async () => {
    seen = -1;
    // 一个不在任何清单里的写路由（像 /api/inbox/decide → 发布检查的外网调用）
    server = http.createServer((req, res) => {
      const p = new URL(req.url!, "http://x").pathname;
      if (!admitMutation(req, res, p)) return;
      seen = activeWorkCount();
      if (p === "/api/some/new-route") { release = () => res.writeHead(200).end("{}"); return; }
      res.writeHead(200).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  it("处理中计数，响应结束释放；GET 不算", async () => {
    const pending = fetch(`${base}/api/some/new-route`, { method: "POST", body: "{}" });
    while (seen < 0) await new Promise((r) => setTimeout(r, 5));
    expect(seen).toBe(1);
    release();
    await pending;
    await new Promise((r) => setTimeout(r, 20));
    expect(activeWorkCount()).toBe(0);
    await fetch(`${base}/api/board`);
    expect(seen).toBe(0);
  });

  it("更新中：写请求回 503「正在更新，稍后再试」；更新自己的路由与读请求照常", async () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    const r = await fetch(`${base}/api/inbox/decide`, { method: "POST", body: "{}" });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, code: "updating", error: UPDATING_MESSAGE });
    expect((await fetch(`${base}/api/update/ack`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/api/session`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${base}/api/board`)).status).toBe(200);
    releaseLock(tmp, "t");
  });
});

describe("P2 动手前再核分支与 HEAD", () => {
  const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  async function setup() {
    const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
    g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    const rel = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", v); g(dev, "tag", "-a", `v${v}`, "-m", v); g(dev, "push", "-q", "origin", "main", "--tags"); };
    rel("0.4.0"); g(tmp, "clone", "-q", origin, user); rel("0.5.0");
    fs.mkdirSync(machine);
    await checkForUpdate(user, machine, { git: gitRunner(user) });
    return { user, machine, old: g(user, "rev-parse", "HEAD"), commit: g(user, "rev-parse", "v0.5.0^{commit}") };
  }
  const steps = (calls: string[], over: Partial<UpdateSteps> = {}): UpdateSteps => {
    const s = (n: string) => async () => { calls.push(n); };
    return { install: s("install"), build: s("build"), quiesce: s("quiesce"), serviceDown: async () => false, restart: s("restart"), health: s("health"), ...over };
  };

  it("预检之后切到了同一提交上的另一个分支：更新没做，那个分支不被快进", async () => {
    const { user, machine, old, commit } = await setup();
    const real = gitRunner(user);
    let switched = false;
    const git: GitRunner = async (args, o) => {
      if (!switched && args[0] === "rev-parse") { switched = true; g(user, "checkout", "-q", "-b", "my-work"); }
      return real(args, o);
    };
    const calls: string[] = [];
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, expectHead: old, from: "0.4.0", to: "0.5.0", git, steps: steps(calls), logFile: path.join(machine, "u.log") });
    expect(r).toMatchObject({ ok: false, outcome: "not_started" });
    expect(r.message).toMatch(/^更新没做：.*my-work/);
    expect(g(user, "rev-parse", "my-work")).toBe(old);
    expect(calls).toEqual([]);
  });

  it("预检时的 HEAD 和现在不一样：更新没做", async () => {
    const { user, machine, old, commit } = await setup();
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, expectHead: "f".repeat(40), from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps: steps([]), logFile: path.join(machine, "u.log") });
    expect(r).toMatchObject({ outcome: "not_started" });
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
  });

  it("退回前发现被切到了别的分支：不 reset，停下给手动步骤", async () => {
    const { user, machine, commit } = await setup();
    let n = 0;
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user),
      steps: steps([], { build: async () => { if (n++ === 0) { g(user, "checkout", "-q", "-b", "side"); throw new Error("构建坏了"); } } }), logFile: path.join(machine, "u.log") });
    expect(r).toMatchObject({ outcome: "stuck" });
    expect(g(user, "rev-parse", "side")).toBe(commit);
  });
});

describe("P1 服务真的接上了这道闸", () => {
  it("desktop/server.ts 在分发任何 /api 路由（含 /api/invoke、看板、等你拍板）之前先过 admitMutation", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "desktop", "server.ts"), "utf-8");
    const guard = src.indexOf("if (!admitMutation(req, res, p)) return;");
    expect(guard).toBeGreaterThan(0);
    for (const route of ['p === "/api/invoke"', "await board(req, res, url)", "await updateRoute(req, res, url)"]) {
      const at = src.indexOf(route);
      expect(at, route).toBeGreaterThan(guard);
    }
  });
});
