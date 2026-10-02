/**
 * Codex 审第 8 轮：P1 合并覆盖本地被忽略的文件；P2 长通道清单漏项；P2 三方抢死锁。每条一个修之前会失败的用例。
 * git 只碰临时仓库；装 / 建 / 重启全是假的；抢锁用真进程。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runUpdate, type UpdateSteps } from "./updater.js";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review8-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

describe("P1 合并不许覆盖本地被忽略的文件", () => {
  it("新版开始跟踪本地被忽略的 config/local.json：不更新，列出文件，文件原样", async () => {
    const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
    g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    fs.writeFileSync(path.join(dev, ".gitignore"), "config/local.json\n");
    fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: "0.4.0" }));
    g(dev, "add", ".gitignore", "package.json"); g(dev, "commit", "-q", "-m", "0.4.0"); g(dev, "tag", "-a", "v0.4.0", "-m", "x"); g(dev, "push", "-q", "origin", "main", "--tags");
    g(tmp, "clone", "-q", origin, user);
    fs.mkdirSync(path.join(user, "config"));
    fs.writeFileSync(path.join(user, "config/local.json"), "{\"mine\":true}\n");
    fs.writeFileSync(path.join(dev, ".gitignore"), "");
    fs.mkdirSync(path.join(dev, "config"));
    fs.writeFileSync(path.join(dev, "config/local.json"), "{\"release\":true}\n");
    fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: "0.5.0" }));
    g(dev, "add", ".gitignore", "package.json", "config/local.json"); g(dev, "commit", "-q", "-m", "0.5.0"); g(dev, "tag", "-a", "v0.5.0", "-m", "x"); g(dev, "push", "-q", "origin", "main", "--tags");
    fs.mkdirSync(machine);
    await checkForUpdate(user, machine, { git: gitRunner(user) });
    const old = g(user, "rev-parse", "HEAD");
    const calls: string[] = [];
    const s = (n: string) => async () => { calls.push(n); };
    const steps: UpdateSteps = { install: s("install"), build: s("build"), quiesce: s("quiesce"), serviceDown: async () => false, restart: s("restart"), health: s("health") };
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit: g(user, "rev-parse", "v0.5.0^{commit}"), from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(fs.readFileSync(path.join(user, "config/local.json"), "utf-8")).toBe("{\"mine\":true}\n");
    expect(g(user, "rev-parse", "HEAD")).toBe(old);
    expect(r).toMatchObject({ ok: false, outcome: "not_started" });
    expect(r.message).toContain("config/local.json");
    expect(calls).toEqual([]);
  });
});
