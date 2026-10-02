/** 第 13 轮增量评审：每条一个修之前会失败的用例。git 只碰临时仓库；不起真服务。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asrWarmupCount, effectiveAsrStatus, warmupAsr } from "../video/asr.js";
import { fakeUvSpawn, routedSpawn } from "../video/testkit.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review13-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("P2 ASR 预热被更新重启打断", () => {
  const statusFile = () => path.join(tmp, "video", "asr-status.json");
  const leftWarming = () => {
    fs.mkdirSync(path.join(tmp, "video"), { recursive: true });
    fs.writeFileSync(statusFile(), JSON.stringify({ status: "warming", detail: "正在下载", updatedAt: "2026-10-01T00:00:00Z" }));
  };

  it("盘上是「预热中」、本进程没在预热、模型没到：写成失败，叫人再点一次（不再永远「预热中」）", async () => {
    leftWarming();
    const st = await effectiveAsrStatus(tmp, { ...process.env, MODELSCOPE_CACHE: path.join(tmp, "empty-cache") }, { recoverInterrupted: true });
    expect(st.status).toBe("failed");
    expect(st.detail).toContain("再点一次");
    expect(JSON.parse(fs.readFileSync(statusFile(), "utf-8")).status).toBe("failed");
  });

  it("模型其实已经下好了：算就绪", async () => {
    leftWarming();
    const cache = path.join(tmp, "cache");
    for (const repo of ["iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", "iic/punc_ct-transformer_cn-en-common-vocab471067-large"]) {
      fs.mkdirSync(path.join(cache, "hub", "models", repo), { recursive: true });
    }
    const st = await effectiveAsrStatus(tmp, { ...process.env, MODELSCOPE_CACHE: cache }, { recoverInterrupted: true });
    expect(st.status).toBe("ready");
  });

  it("本进程里正在预热：计入忙碌；预热完释放", async () => {
    const r = await warmupAsr(tmp, { spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok") }) });
    expect(r.status).toBe("warming");
    expect(asrWarmupCount()).toBe(1);
    await expect.poll(() => asrWarmupCount(), { timeout: 3000 }).toBe(0);
  });
});

describe("P2 服务把 ASR 预热计入忙碌", () => {
  it("desktop/server.ts 的 inProcessTurns 计入 asrWarmupCount()", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "desktop", "server.ts"), "utf-8");
    expect(src.split("\n").find((l) => l.includes("inProcessTurns:"))).toContain("asrWarmupCount()");
  });
});

import { execFileSync } from "node:child_process";
import { realSteps, runUpdate, type UpdateSteps } from "./updater.js";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
async function releases() {
  const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
  g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
  const rel = (v: string) => { fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: v })); g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", v); g(dev, "tag", "-a", `v${v}`, "-m", v); g(dev, "push", "-q", "origin", "main", "--tags"); };
  rel("0.4.0"); g(tmp, "clone", "-q", origin, user); rel("0.5.0");
  fs.mkdirSync(machine);
  await checkForUpdate(user, machine, { git: gitRunner(user) });
  return { user, machine, old: g(user, "rev-parse", "HEAD"), commit: g(user, "rev-parse", "v0.5.0^{commit}") };
}

describe("P2 服务本来没开：检查用的服务不再起了又掐，退回也不凭空起服务", () => {
  it("装依赖失败要退回、服务本来没开、更新也没起过它：退回不启动（真实步骤，临时仓库里根本没有启动器）", async () => {
    const { user, machine, old, commit } = await releases();
    fs.mkdirSync(path.join(user, "node_modules")); // 有旧依赖可留：退回靠改名换回，不需要再装
    const npm = path.join(tmp, "bad-npm.sh");
    fs.writeFileSync(npm, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user),
      steps: realSteps(user, 1, { serverWasRunning: false, busy: async () => null, npm }), logFile: path.join(machine, "u.log") });
    expect(r).toMatchObject({ ok: false, outcome: "rolled_back" });
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(fs.readFileSync(path.join(machine, "u.log"), "utf-8")).toContain("退回后也不启动");
  });

  it("检查通过、服务是这次起的：结果里说「AutoCrew 已经启动」", async () => {
    const { user, machine, commit } = await releases();
    const s = async () => {};
    const steps: UpdateSteps = { install: s, build: s, quiesce: s, serviceDown: async () => false, restart: s, health: s, startedService: () => true };
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(r.message).toBe("已更新到 0.5.0，AutoCrew 已经启动");
  });
});
