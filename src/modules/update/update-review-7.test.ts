/**
 * Codex 审第 7 轮（P1 + P2）：每条一个修之前会失败的用例。git 只碰临时仓库；装 / 建 / 重启全是假的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runUpdate, type UpdateSteps } from "./updater.js";
import { checkForUpdate } from "./check.js";
import { gitRunner } from "./git.js";
import { acquireLock, lockHeld, UNREADABLE_LOCK_GRACE_MS } from "./preflight.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-upd-review7-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

describe("P1 退回不许悄悄覆盖不归 git 管的文件", () => {
  it("新版删掉了 docs/old.md，用户在更新途中又建了一个：不退回，列出文件，文件留着", async () => {
    const origin = path.join(tmp, "o.git"), dev = path.join(tmp, "d"), user = path.join(tmp, "u"), machine = path.join(tmp, "m");
    g(tmp, "init", "-q", "--bare", "-b", "main", origin); g(tmp, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    fs.mkdirSync(path.join(dev, "docs"));
    fs.writeFileSync(path.join(dev, "docs/old.md"), "旧版文档\n");
    fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: "0.4.0" }));
    g(dev, "add", "package.json", "docs/old.md"); g(dev, "commit", "-q", "-m", "0.4.0"); g(dev, "tag", "-a", "v0.4.0", "-m", "x"); g(dev, "push", "-q", "origin", "main", "--tags");
    g(tmp, "clone", "-q", origin, user);
    g(dev, "rm", "-q", "docs/old.md");
    fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ version: "0.5.0" }));
    g(dev, "add", "package.json"); g(dev, "commit", "-q", "-m", "0.5.0"); g(dev, "tag", "-a", "v0.5.0", "-m", "x"); g(dev, "push", "-q", "origin", "main", "--tags");
    fs.mkdirSync(machine);
    await checkForUpdate(user, machine, { git: gitRunner(user) });
    const commit = g(user, "rev-parse", "v0.5.0^{commit}");
    const s = (n: string) => async () => { void n; };
    const steps: UpdateSteps = {
      install: async () => { fs.mkdirSync(path.join(user, "docs"), { recursive: true }); fs.writeFileSync(path.join(user, "docs/old.md"), "用户新写的\n"); },
      build: async () => { throw new Error("构建坏了"); },
      quiesce: s("q"), serviceDown: async () => false, restart: s("r"), health: s("h"),
    };
    const r = await runUpdate({ root: user, machineDir: machine, tag: "v0.5.0", commit, from: "0.4.0", to: "0.5.0", git: gitRunner(user), steps, logFile: path.join(machine, "u.log") });
    expect(fs.readFileSync(path.join(user, "docs/old.md"), "utf-8")).toBe("用户新写的\n");
    expect(g(user, "rev-parse", "HEAD")).toBe(commit);
    expect(r).toMatchObject({ ok: false, outcome: "stuck" });
    expect(r.message).toContain("docs/old.md");
  });
});

describe("P2 拿锁是原子的；读不出内容的新锁不当死锁", () => {
  it("锁文件刚出现、还是空的：第二个来拿的不能赢；过了宽限期才能收回", () => {
    const lock = path.join(tmp, "update.lock");
    const fd = fs.openSync(lock, "w"); // 别人 wx 建了、还没写进内容
    expect(lockHeld(tmp)).toBe(true);
    expect(acquireLock(tmp, "second")).toBe(false);
    fs.closeSync(fd);
    const old = (Date.now() - UNREADABLE_LOCK_GRACE_MS - 1_000) / 1000;
    fs.utimesSync(lock, old, old);
    expect(acquireLock(tmp, "second")).toBe(true);
  });

  it("拿到的锁从出现那一刻起就是完整内容", () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "update.lock"), "utf-8"))).toMatchObject({ token: "t", pid: process.pid });
    expect(fs.readdirSync(tmp).filter((f) => f.includes(".new-"))).toEqual([]);
  });
});
