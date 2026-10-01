/**
 * Codex 审第 5 轮的三条（P1×2 + P2）：每条一个修之前会失败的用例。
 * git 只碰临时仓库；装 / 建 / 重启全是假的；封面执行体换成假的（不调付费生图）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let coverGate: Promise<void> = Promise.resolve();
vi.mock("../../tools/cover-review.js", async (importActual) => ({
  ...(await importActual<typeof import("../../tools/cover-review.js")>()),
  executeCoverReview: async () => { await coverGate; return { ok: true }; },
}));

import { runUpdate, type UpdateSteps } from "./updater.js";
import { checkForUpdate } from "./check.js";
import { gitRunner, type GitRunner } from "./git.js";
import { acquireLock, releaseLock, UPDATING_MESSAGE } from "./preflight.js";
import { activeWorkCount, resetActiveWork } from "./active-work.js";
import { isLongRunningTool } from "./long-running.js";
import { handleMcpRequest } from "../../../mcp/server.js";
import { startGenerateScript } from "../writing/generate-script.js";
import { startCoverJob } from "../../desktop/cover-handlers.js";

let tmp: string;
const prev = process.env.AUTOCREW_LOCAL_DIR;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-upd-review5-")); process.env.AUTOCREW_LOCAL_DIR = tmp; resetActiveWork(); });
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  resetActiveWork();
  fs.rmSync(tmp, { recursive: true, force: true });
});

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

function fakeSteps(calls: string[], over: Partial<UpdateSteps> = {}): UpdateSteps {
  const s = (n: string) => async () => { calls.push(n); };
  return { install: s("install"), build: s("build"), quiesce: s("quiesce"), serviceDown: async () => false, restart: s("restart"), health: s("health"), ...over };
}

describe("P1 用户的改动绝不能被退回冲掉", () => {
  it("预检之后、合并之前改了程序文件：更新没做，改动原样留着", async () => {
    const { user, machine, old, commit } = await setup();
    const real = gitRunner(user);
    let edited = false;
    // 预检已过，runUpdate 开头读 HEAD 的那一刻用户改了 package.json
    const git: GitRunner = async (args, o) => {
      if (!edited && args[0] === "rev-parse") { edited = true; fs.writeFileSync(path.join(user, "package.json"), "用户刚改的\n"); }
      return real(args, o);
    };
    const calls: string[] = [];
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git, steps: fakeSteps(calls), logFile: path.join(machine, "u.log") });
    expect(fs.readFileSync(path.join(user, "package.json"), "utf-8")).toBe("用户刚改的\n");
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(r).toMatchObject({ ok: false, outcome: "not_started" });
    expect(r.message).toMatch(/^更新没做：/);
    expect(calls).toEqual([]);
  });

  it("合并没挪动 HEAD：更新没做，不 reset", async () => {
    const { user, machine, old } = await setup();
    const calls: string[] = [];
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.4.0", commit: old, from: "0.4.0", to: "0.4.0", git: gitRunner(user), steps: fakeSteps(calls), logFile: path.join(machine, "u.log") });
    expect(r).toMatchObject({ outcome: "not_started" });
    expect(calls).toEqual([]);
  });

  it("要退回时工作区里有别的改动：不 reset，停下给手动步骤，改动留着", async () => {
    const { user, machine, commit } = await setup();
    const calls: string[] = [];
    const steps = fakeSteps(calls, {
      install: async () => { calls.push("install"); fs.writeFileSync(path.join(user, "package.json"), "装依赖时用户又改了\n"); },
      build: async () => { calls.push("build"); throw new Error("构建坏了"); },
    });
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(fs.readFileSync(path.join(user, "package.json"), "utf-8")).toBe("装依赖时用户又改了\n");
    expect(g(user, "rev-parse", "HEAD")).toBe(commit);
    expect(r).toMatchObject({ ok: false, outcome: "stuck" });
    expect(r.manualCommands?.[1]).toContain("git status");
  });
});

describe("P1 封面 draft_ratios 等付费动作要挡住", () => {
  it("在清单里；更新中经 /mcp 调被拒", async () => {
    expect(isLongRunningTool("autocrew_cover_review", "draft_ratios")).toBe(true);
    expect(acquireLock(tmp, "t")).toBe(true);
    const r = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "autocrew_cover_review", arguments: { action: "draft_ratios", content_id: "content-1-a" } } } as never, undefined, path.join(tmp, "lib"));
    expect((r as { result: { structuredContent?: unknown } }).result.structuredContent).toMatchObject({ code: "updating", error: UPDATING_MESSAGE });
    releaseLock(tmp, "t");
  });

  it("经 /mcp 跑的时候算在跑，跑完释放", async () => {
    let open!: () => void;
    coverGate = new Promise<void>((r) => { open = r; });
    const pending = handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "autocrew_cover_review", arguments: { action: "draft_ratios", content_id: "content-1-a" } } } as never, undefined, path.join(tmp, "lib"));
    await new Promise((r) => setTimeout(r, 50));
    expect(activeWorkCount()).toBe(1);
    open();
    await pending;
    expect(activeWorkCount()).toBe(0);
    coverGate = Promise.resolve();
  });
});

describe("P2 查锁与登记之间不留缝", () => {
  it("后台写稿：一调用（第一个 await 之前）就已登记；之后才拿锁也挡不住它被计数", async () => {
    const started = startGenerateScript({ topic: "x", platform: "douyin" } as never, path.join(tmp, "lib"));
    expect(activeWorkCount()).toBe(1);
    expect(acquireLock(tmp, "t")).toBe(true);
    await started.then((s) => s.completion, () => undefined);
    expect(activeWorkCount()).toBe(0);
    releaseLock(tmp, "t");
  });

  it("封面任务：一调用就已登记；准备失败或任务结束时释放", async () => {
    const job = startCoverJob({ content_id: "content-1-a", _dataDir: path.join(tmp, "lib") }, "create_candidates", { work: "w", done: "d" });
    expect(activeWorkCount()).toBe(1);
    await (await job).completion;
    expect(activeWorkCount()).toBe(0);
  });
});
