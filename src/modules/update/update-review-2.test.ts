/**
 * Codex 审第 2 轮的四条（P1×2 + P2×2）：每条一个修之前会失败的用例。
 * git 只碰临时仓库；装 / 建 / 重启全是假的；子进程是 node -e 的小脚本，不碰真服务。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeWorkCount, beginWork, resetActiveWork } from "./active-work.js";
import { acquireLock, busyWork, lockHeld, releaseLock, UPDATING_MESSAGE } from "./preflight.js";
import { checkForUpdate, parseLsRemoteTags } from "./check.js";
import { gitRunner } from "./git.js";
import { QuiesceError, runUpdate, type UpdateSteps } from "./updater.js";
import { spawnDetachedUpdater, type Prepared } from "./start.js";
import { readResult } from "./state.js";
import { startIdentityPortraitJob } from "../../desktop/cover-identity-handlers.js";
import { buildIpcHandlers } from "../../desktop/ipc.js";
import { startGenerateScript } from "../writing/generate-script.js";

let tmp: string;
const prev = process.env.AUTOCREW_LOCAL_DIR;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-upd-review2-")); process.env.AUTOCREW_LOCAL_DIR = tmp; resetActiveWork(); });
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  resetActiveWork();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

describe("P1 后台长任务进忙碌计数，更新中不开新的", () => {
  it("后台生图起跑即计数、跑完释放；预检据此判忙", async () => {
    const job = startIdentityPortraitJob({ _dataDir: path.join(tmp, "lib") });
    expect(activeWorkCount()).toBe(1);
    expect(busyWork(tmp, { runAlive: () => false, inProcessTurns: activeWorkCount })).toMatch(/正在跑/);
    await job.completion;
    expect(activeWorkCount()).toBe(0);
  });

  it("公众号推送等在请求里跑很久的通道：跑的时候计数，锁在手时直接拒", async () => {
    let release!: () => void;
    const handlers = buildIpcHandlers({ "publish:wechat_draft": () => new Promise((r) => { release = () => r({ ok: true }); }) });
    const pending = handlers["publish:wechat_draft"]({});
    expect(activeWorkCount()).toBe(1);
    release();
    await pending;
    expect(activeWorkCount()).toBe(0);
    expect(acquireLock(tmp, "t")).toBe(true);
    expect(await handlers["publish:wechat_draft"]({})).toEqual({ ok: false, code: "updating", error: UPDATING_MESSAGE });
    expect(beginWork("x")).toEqual({ ok: false, error: UPDATING_MESSAGE });
    releaseLock(tmp, "t");
  });

  it("锁在手：后台写稿、生图入口都回「正在更新，稍后再试」", async () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    await expect(startGenerateScript({ topic: "x", platform: "douyin" } as never, path.join(tmp, "lib"))).rejects.toThrow(UPDATING_MESSAGE);
    expect(startIdentityPortraitJob({}).response).toEqual({ ok: false, error: UPDATING_MESSAGE });
    expect(activeWorkCount()).toBe(0);
    releaseLock(tmp, "t");
  });
});

/** bare origin + 用户 clone；origin 上 0.4.0 → 0.5.0 */
function repos(tagNew = true) {
  const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u");
  g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
  const rel = (v: string, tag: boolean) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", v); if (tag) g(dev, "tag", "-a", `v${v}`, "-m", v); g(dev, "push", "-q", "origin", "main", "--tags"); };
  rel("0.4.0", true); g(tmp, "clone", "-q", origin, user); rel("0.5.0", tagNew);
  const machine = path.join(tmp, "m"); fs.mkdirSync(machine);
  return { origin, dev, user, machine };
}

describe("P1 退回路径重启前也要确认空闲", () => {
  it("安装失败要退回、但有任务在跑：代码退回，不重启，告诉你之后自己 restart", async () => {
    const { user, machine } = repos();
    await checkForUpdate(user, machine, { git: gitRunner(user) });
    const old = g(user, "rev-parse", "HEAD");
    const calls: string[] = [];
    let installs = 0;
    const steps: UpdateSteps = {
      serviceDown: async () => false,
      install: async () => { calls.push("install"); if (++installs === 1) throw new Error("npm ci 坏了"); },
      build: async () => { calls.push("build"); },
      quiesce: async () => { calls.push("quiesce"); throw new QuiesceError("有 1 个任务正在跑"); },
      restart: async () => { calls.push("restart"); },
      health: async () => { calls.push("health"); },
    };
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit: g(user, "rev-parse", "v0.5.0^{commit}"), from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(calls).toEqual(["install", "install", "build", "quiesce"]);
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(r).toMatchObject({ ok: false, outcome: "rolled_back" });
    expect(r.message).toContain("更新失败，已退回代码；服务没有重启（有任务在跑），等它们结束后运行 npm run restart");
  });
});

describe("P2 更新进程要真的接手锁才算开始", () => {
  const job = (): Prepared => ({ ok: true, tag: "v0.5.0", commit: "a".repeat(40), head: "b".repeat(40), from: "0.4.0", to: "0.5.0", notes: [], token: "tok" });
  /** 不管给的命令，起一个 node 小脚本代替 tsx（不跑真更新） */
  const fake = (script: string) => ((_c: string, args: readonly string[], opts: object) =>
    spawn(process.execPath, ["-e", script, ...args], opts as never)) as unknown as typeof spawn;

  it("起来就退出、没接手：放锁，写「更新没能开始」", async () => {
    expect(acquireLock(tmp, "tok")).toBe(true);
    const r = await spawnDetachedUpdater(tmp, tmp, 1, job(), fake("process.exit(3)"), 5_000);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("更新没能开始") });
    expect(lockHeld(tmp)).toBe(false);
    expect(readResult(tmp)).toMatchObject({ outcome: "not_started" });
  });

  it("接手了（锁的主人换成它）：才报开始", async () => {
    expect(acquireLock(tmp, "tok")).toBe(true);
    const lock = JSON.stringify(path.join(tmp, "update.lock"));
    const script = `const fs=require("fs");const f=${lock};const b=JSON.parse(fs.readFileSync(f,"utf8"));const n=process.argv[process.argv.indexOf("--adopt-nonce")+1];fs.writeFileSync(f,JSON.stringify({...b,pid:process.pid,adopted:n}));setTimeout(()=>{fs.rmSync(f,{force:true})},1500);`;
    const r = await spawnDetachedUpdater(tmp, tmp, 1, job(), fake(script), 5_000);
    expect(r).toMatchObject({ ok: true });
    expect(readResult(tmp)).toBeNull();
  });

  it("一直不接手：超时放锁、结束它、写「更新没能开始」", async () => {
    expect(acquireLock(tmp, "tok")).toBe(true);
    const r = await spawnDetachedUpdater(tmp, tmp, 1, job(), fake("setTimeout(()=>{},60000)"), 300);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("没接手") });
    expect(lockHeld(tmp)).toBe(false);
  });
});

describe("P2 只认 origin 上真实存在的 tag", () => {
  it("ls-remote 解析：附注 tag 用剥开后的提交", () => {
    const a = "a".repeat(40), b = "b".repeat(40);
    expect(parseLsRemoteTags(`${a}\trefs/tags/v0.5.0\n${b}\trefs/tags/v0.5.0^{}\n`).get("v0.5.0")).toBe(b);
  });

  it("本地自己打的 v99.0.0 不算发布版", async () => {
    const { user, machine } = repos(false);
    g(user, "fetch", "-q", "origin");
    g(user, "tag", "v99.0.0", "origin/main");
    const s = await checkForUpdate(user, machine, { git: gitRunner(user) });
    expect(s).toMatchObject({ available: false, reason: "up_to_date", latest: "0.4.0" });
  });

  it("origin 删掉的 tag，本地还留着：不算", async () => {
    const { dev, user, machine } = repos();
    g(user, "fetch", "-q", "--tags", "origin");
    g(dev, "push", "-q", "origin", ":refs/tags/v0.5.0");
    const s = await checkForUpdate(user, machine, { git: gitRunner(user) });
    expect(s.available).toBe(false);
  });

  it("目标钉在 origin 公布的提交上", async () => {
    const { user, machine } = repos();
    const s = await checkForUpdate(user, machine, { git: gitRunner(user) });
    expect(s).toMatchObject({ available: true, tag: "v0.5.0", commit: g(user, "rev-parse", "v0.5.0^{commit}") });
  });
});
