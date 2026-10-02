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

import { IPC_CHANNELS } from "../../desktop/channels.js";
import { BACKGROUND_TRACKED_CHANNELS, isLongRunningTool, LONG_RUNNING_CHANNELS, LONG_RUNNING_TOOL_ACTIONS, RECOVERABLE_CHANNELS, SHORT_CHANNELS, SHORT_TOOLS } from "./long-running.js";
import { acquireLock, releaseLock, UPDATING_MESSAGE } from "./preflight.js";
import { buildIpcHandlers } from "../../desktop/ipc.js";

describe("P2 长调用清单不许悄悄漏项", () => {
  it("topic:create（想法蒸馏）与 draft:adopt_revision（文风蒸馏）算长调用，更新中被拒", async () => {
    expect(LONG_RUNNING_CHANNELS.has("topic:create")).toBe(true);
    expect(LONG_RUNNING_CHANNELS.has("draft:adopt_revision")).toBe(true);
    const prev = process.env.AUTOCREW_LOCAL_DIR;
    process.env.AUTOCREW_LOCAL_DIR = tmp;
    try {
      expect(acquireLock(tmp, "t")).toBe(true);
      const h = buildIpcHandlers();
      for (const ch of ["topic:create", "draft:adopt_revision"] as const) {
        expect(await h[ch]({ title: "x".repeat(40) }), ch).toEqual({ ok: false, code: "updating", error: UPDATING_MESSAGE });
      }
      releaseLock(tmp, "t");
    } finally { if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev; }
  });

  it("每个 IPC 通道都归了类，而且只归一类", () => {
    const tables = [LONG_RUNNING_CHANNELS, BACKGROUND_TRACKED_CHANNELS, RECOVERABLE_CHANNELS, SHORT_CHANNELS];
    const unclassified = IPC_CHANNELS.filter((ch) => !tables.some((t) => t.has(ch)));
    const twice = IPC_CHANNELS.filter((ch) => tables.filter((t) => t.has(ch)).length > 1);
    expect(unclassified, "新通道要先判断会不会在请求里调模型 / 外网").toEqual([]);
    expect(twice).toEqual([]);
    const known = new Set<string>(IPC_CHANNELS);
    expect(tables.flatMap((t) => [...t]).filter((ch) => !known.has(ch)), "表里有不存在的通道").toEqual([]);
  });

  it("每个注册的 MCP 工具都归了类", () => {
    const registered = [...fs.readFileSync(path.join(REPO, "index.ts"), "utf-8").matchAll(/name: "(autocrew_[a-z_]+)"/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(20);
    const unclassified = registered.filter((t) => !(t in LONG_RUNNING_TOOL_ACTIONS) && !SHORT_TOOLS.has(t));
    expect(unclassified, "新工具要先判断哪些动作会调模型 / 外网 / 渲染").toEqual([]);
    expect(registered.filter((t) => t in LONG_RUNNING_TOOL_ACTIONS && SHORT_TOOLS.has(t))).toEqual([]);
    expect(isLongRunningTool("autocrew_review_desk", "submit")).toBe(true);
  });
});

import lockfile from "proper-lockfile";
import { vi } from "vitest";
import { startEpoch } from "../../desktop/chief-editor/run-store.js";

describe("P2 收回死锁时绝不挪开活锁（三方交错，确定性重放）", () => {
  it("B 看到死锁后、动手前，A 已收回并拿到新锁，C 正等着空位：A 的锁留着，B、C 都拿不到", () => {
    const lock = path.join(tmp, "update.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 99999999, token: "dead", at: "" }));
    const live = (token: string) => JSON.stringify({ pid: process.pid, token, at: "", start: startEpoch(process.pid) });
    let injected = false;
    // 「A 收回完成」插在 B 初次检查之后、B 下一步动手之前：新实现的下一步是拿收回短锁，旧实现是把锁改名成墓碑
    const injectA = () => { if (!injected) { injected = true; fs.writeFileSync(lock, live("A")); } };
    const realRename = fs.renameSync.bind(fs), realLink = fs.linkSync.bind(fs), realLockSync = lockfile.lockSync.bind(lockfile);
    const spies = [
      vi.spyOn(lockfile, "lockSync").mockImplementation((f, o) => { injectA(); return realLockSync(f, o); }),
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(from) === lock) injectA(); return realRename(from, to); }),
      // C 一看到空位就发布（旧实现把 A 的锁挪开、再放回之间那一瞬）
      vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
        if (String(to) === lock && String(from).includes(".stale-") && !fs.existsSync(lock)) fs.writeFileSync(lock, live("C"));
        return realLink(from, to);
      }),
    ];
    try {
      expect(acquireLock(tmp, "B")).toBe(false);
    } finally { for (const s of spies) s.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(lock, "utf-8")).token).toBe("A");
  });
});
