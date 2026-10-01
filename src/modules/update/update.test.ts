/**
 * 一键更新（self-update spec）：全部在临时 git 仓库里跑——一个 bare「origin」带 tag + 一个用户 clone。
 * 安装 / 构建 / 重启 / 健康检查全是假的：测试里不跑 npm ci、不碰任何真服务。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSemver, highestTag, isNewer, parseSemver } from "./semver.js";
import { notesBetween, parseChangelog, shortDate } from "./changelog.js";
import { bannerFor, briefLine, checkForUpdate, scheduledTick, updateView } from "./check.js";
import { gitRunner } from "./git.js";
import { acquireLock, adoptLock, busyWork, lockHeld, preflight, releaseLock } from "./preflight.js";
import { prepareUpdate } from "./start.js";
import { runUpdate, type UpdateSteps } from "./updater.js";
import { readResult, readSettings, readStatus, writeSettings } from "./state.js";

let tmp: string, origin: string, dev: string, user: string, machine: string;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const changelog = (versions: Array<[string, string, string]>) =>
  "# 更新记录\n\n" + versions.map(([v, d, todo]) => `## ${v} · ${d}\n\n### 新东西\n\n- 新功能 ${v}\n\n### 修好的\n\n- 修了 ${v}\n\n### 需要你做的\n\n- ${todo}\n`).join("\n");

function release(version: string, notes: Array<[string, string, string]>, tag = true) {
  fs.writeFileSync(path.join(dev, "package.json"), JSON.stringify({ name: "autocrew", version }));
  fs.writeFileSync(path.join(dev, "CHANGELOG.md"), changelog(notes));
  sh(dev, "add", "package.json", "CHANGELOG.md");
  sh(dev, "commit", "-q", "-m", `release ${version}`);
  if (tag) sh(dev, "tag", "-a", `v${version}`, "-m", `v${version}`);
  sh(dev, "push", "-q", "origin", "main", "--tags");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-update-"));
  origin = path.join(tmp, "origin.git"); dev = path.join(tmp, "dev"); user = path.join(tmp, "user"); machine = path.join(tmp, "machine");
  fs.mkdirSync(machine);
  sh(tmp, "init", "-q", "--bare", "-b", "main", origin);
  sh(tmp, "clone", "-q", origin, dev);
  sh(dev, "checkout", "-q", "-b", "main");
  release("0.4.0", [["0.4.0", "2026-09-01", "无"]]);
  sh(tmp, "clone", "-q", origin, user);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const noBusy = { runAlive: () => false, inProcessTurns: () => 0 };
const git = () => gitRunner(user);

describe("semver", () => {
  it("按数字比，不按字符串比；非法 tag 不算", () => {
    expect(compareSemver(parseSemver("0.10.0")!, parseSemver("0.9.9")!)).toBeGreaterThan(0);
    expect(highestTag(["v0.9.0", "v0.10.0", "v1.0.0-rc1", "release-2", "v0.10.0x", "0.99.0"])).toEqual({ tag: "v0.10.0", version: "0.10.0" });
    expect(highestTag(["nope"])).toBeNull();
    expect(isNewer("0.5.0", "0.4.9")).toBe(true);
    expect(isNewer("0.5.0", "0.5.0")).toBe(false);
    expect(isNewer("garbage", "0.1.0")).toBe(false);
  });
});

describe("CHANGELOG", () => {
  it("读出每版三段，(from, to] 区间新的在前，日期写成 10月1日", () => {
    const all = parseChangelog(changelog([["0.6.0", "2026-10-09", "重新登录"], ["0.5.0", "2026-10-01", "跑 migrate"], ["0.4.0", "2026-09-01", "无"]]) + "\n## 其他说明\n\n- 不该进来\n");
    expect(all.map((n) => n.version)).toEqual(["0.6.0", "0.5.0", "0.4.0"]);
    expect(all[1]).toEqual({ version: "0.5.0", date: "2026-10-01", news: ["新功能 0.5.0"], fixes: ["修了 0.5.0"], todo: ["跑 migrate"] });
    expect(notesBetween(all, "0.4.0", "0.6.0").map((n) => n.version)).toEqual(["0.6.0", "0.5.0"]);
    expect(shortDate("2026-10-01")).toBe("10月1日");
    expect(parseChangelog("# 只有说明\n")).toEqual([]);
  });
});

describe("检查", () => {
  it("origin/main 上有更高的 tag：有更新、带说明、上横幅和晨报", async () => {
    release("0.5.0", [["0.5.0", "2026-10-01", "跑一次迁移"], ["0.4.0", "2026-09-01", "无"]]);
    const s = await checkForUpdate(user, machine, { git: git() });
    expect(s).toMatchObject({ available: true, current: "0.4.0", latest: "0.5.0", tag: "v0.5.0" });
    expect(s.notes?.map((n) => n.version)).toEqual(["0.5.0"]);
    expect(updateView(user, machine, false).banner?.version).toBe("0.5.0");
    expect(briefLine(user, machine)).toContain("0.5.0");
  });

  it("main 上没打 tag 的新提交不算更新", async () => {
    release("0.5.0", [["0.5.0", "2026-10-01", "x"]], false);
    expect(await checkForUpdate(user, machine, { git: git() })).toMatchObject({ available: false, reason: "up_to_date" });
  });

  it("本地比发布版新或已分叉：不提示", async () => {
    release("0.5.0", [["0.5.0", "2026-10-01", "x"]]);
    fs.writeFileSync(path.join(user, "local.txt"), "mine");
    sh(user, "add", "local.txt"); sh(user, "commit", "-q", "-m", "local work");
    const s = await checkForUpdate(user, machine, { git: git() });
    expect(s).toMatchObject({ available: false, reason: "local_ahead" });
    expect(updateView(user, machine, false).banner).toBeNull();
    expect(briefLine(user, machine)).toBeNull();
  });

  it("连不上 origin：状态里写原因，不上横幅", async () => {
    sh(user, "remote", "set-url", "origin", path.join(tmp, "gone.git"));
    const s = await checkForUpdate(user, machine, { git: git() });
    expect(s.available).toBe(false);
    expect(s.error).toMatch(/连不上 GitHub/);
    expect(readStatus(machine)?.error).toBe(s.error);
    expect(updateView(user, machine, false).banner).toBeNull();
  });

  it("不是 git 安装：说按 README 手动更新", async () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, "package.json"), JSON.stringify({ version: "0.4.0" }));
    const s = await checkForUpdate(plain, machine, { git: gitRunner(plain) });
    expect(s.error).toMatch(/README/);
  });

  it("这个版本先不更新：这一版不提示，下一版再提示", async () => {
    release("0.5.0", [["0.5.0", "2026-10-01", "x"]]);
    await checkForUpdate(user, machine, { git: git() });
    writeSettings(machine, { skipVersion: "0.5.0" });
    expect(updateView(user, machine, false).banner).toBeNull();
    release("0.6.0", [["0.6.0", "2026-10-09", "y"], ["0.5.0", "2026-10-01", "x"]]);
    await checkForUpdate(user, machine, { git: git() });
    expect(updateView(user, machine, false).banner?.version).toBe("0.6.0");
  });

  it("自动检查关掉：定时那一拍什么都不做；默认是开的", async () => {
    expect(readSettings(machine).autoCheck).toBe(true);
    writeSettings(machine, { autoCheck: false });
    expect(await scheduledTick(user, machine, { git: git() })).toBe("skipped");
    expect(readStatus(machine)).toBeNull();
  });

  it("横幅只在目标比本地新时出现（更新完自然消失）", () => {
    const st = { checkedAt: "", current: "0.4.0", latest: "0.5.0", tag: "v0.5.0", available: true };
    expect(bannerFor(st, { autoCheck: true }, "0.5.0")).toBeNull();
    expect(bannerFor(st, { autoCheck: true }, "0.4.0")?.version).toBe("0.5.0");
  });
});

describe("预检", () => {
  beforeEach(() => release("0.5.0", [["0.5.0", "2026-10-01", "x"]]));
  const fetchFirst = () => checkForUpdate(user, machine, { git: git() });

  it("已跟踪文件有改动：不动手（未跟踪文件不管）", async () => {
    await fetchFirst();
    fs.writeFileSync(path.join(user, "untracked.txt"), "x");
    expect(await preflight(user, machine, "v0.5.0", { git: git(), ...noBusy })).toEqual({ ok: true });
    fs.writeFileSync(path.join(user, "package.json"), "{}");
    expect(await preflight(user, machine, "v0.5.0", { git: git(), ...noBusy })).toMatchObject({ ok: false, code: "dirty" });
  });

  it("不在 main：不动手", async () => {
    await fetchFirst();
    sh(user, "checkout", "-q", "-b", "feature");
    expect(await preflight(user, machine, "v0.5.0", { git: git(), ...noBusy })).toMatchObject({ ok: false, code: "not_main" });
  });

  it("有任务在跑：不动手（总编辑轮次记录 + 本进程对话轮）", async () => {
    await fetchFirst();
    const home = path.join(machine, "chief-editor");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "runs.json"), JSON.stringify([{ turnId: "t1", status: "running", owner: { pid: 1, start: 1 } }, { turnId: "t2", status: "done" }]));
    expect(await preflight(user, machine, "v0.5.0", { git: git(), runAlive: () => true })).toMatchObject({ ok: false, code: "busy" });
    expect(busyWork(machine, { runAlive: () => false })).toBeNull();
    expect(busyWork(machine, { runAlive: () => false, inProcessTurns: () => 1 })).toMatch(/正在跑/);
  });

  it("服务不是启动器起的：不动手", async () => {
    await fetchFirst();
    const r = await preflight(user, machine, "v0.5.0", { git: git(), ...noBusy, launcher: async () => ({ running: true, managed: false }) });
    expect(r).toMatchObject({ ok: false, code: "unmanaged" });
  });

  it("锁：活进程持锁 → 正在更新；死进程的旧锁清掉重拿；令牌对上才交接", async () => {
    expect(acquireLock(machine, "a")).toBe(true);
    expect(acquireLock(machine, "b")).toBe(false);
    expect(lockHeld(machine)).toBe(true);
    expect(await prepareUpdate(user, machine, { git: git(), ...noBusy })).toMatchObject({ ok: false, code: "running", reason: "正在更新，等它跑完" });
    expect(adoptLock(machine, "wrong", 4242)).toBe(false);
    releaseLock(machine, "a");
    fs.writeFileSync(path.join(machine, "update.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
    expect(acquireLock(machine, "c")).toBe(true);
    releaseLock(machine, "c");
  });

  it("连点两次：第二次回「正在更新」", async () => {
    const first = await prepareUpdate(user, machine, { git: git(), ...noBusy });
    expect(first).toMatchObject({ ok: true, tag: "v0.5.0", from: "0.4.0", to: "0.5.0" });
    const second = await prepareUpdate(user, machine, { git: git(), ...noBusy });
    expect(second).toMatchObject({ ok: false, code: "running" });
  });
});

describe("更新执行", () => {
  let calls: string[];
  const steps = (fail: Partial<Record<string, number>> = {}): UpdateSteps => {
    const seen: Record<string, number> = {};
    const step = (name: string) => async () => {
      seen[name] = (seen[name] ?? 0) + 1;
      calls.push(name);
      if (fail[name] && seen[name] <= fail[name]!) throw new Error(`${name} 坏了`);
    };
    return { install: step("install"), build: step("build"), restart: step("restart"), health: step("health") };
  };
  beforeEach(async () => {
    calls = [];
    release("0.5.0", [["0.5.0", "2026-10-01", "跑一次迁移"], ["0.4.0", "2026-09-01", "无"]]);
    await checkForUpdate(user, machine, { git: git() });
  });
  const job = (s: UpdateSteps) => ({ root: user, machineDir: machine, tag: "v0.5.0", from: "0.4.0", to: "0.5.0", git: git(), steps: s, logFile: path.join(machine, "update-logs", "u.log") });

  it("成功：ff-only 到 tag，依次装 / 建 / 重启 / 健康检查，结果给页面", async () => {
    const tagCommit = sh(user, "rev-parse", "v0.5.0^{commit}");
    const r = await runUpdate(job(steps()));
    expect(r).toMatchObject({ ok: true, outcome: "updated" });
    expect(sh(user, "rev-parse", "HEAD")).toBe(tagCommit);
    expect(calls).toEqual(["install", "build", "restart", "health"]);
    expect(readResult(machine)).toMatchObject({ ok: true, to: "0.5.0" });
    expect(updateView(user, machine, false)).toMatchObject({ current: "0.5.0", banner: null, result: { ok: true } });
    expect(fs.readFileSync(r.log, "utf-8")).toContain("merge --ff-only");
  });

  it("安装失败：退回旧 HEAD，重装重建重启，告诉你原因和日志", async () => {
    const oldHead = sh(user, "rev-parse", "HEAD");
    const r = await runUpdate(job(steps({ install: 1 })));
    expect(r).toMatchObject({ ok: false, outcome: "rolled_back" });
    expect(r.message).toMatch(/更新失败，已退回 0\.4\.0，原因：install 坏了，完整记录在 .*u\.log/);
    expect(sh(user, "rev-parse", "HEAD")).toBe(oldHead);
    expect(calls).toEqual(["install", "install", "build", "restart", "health"]);
    expect(updateView(user, machine, false).result?.outcome).toBe("rolled_back");
  });

  it("退回也失败：停下，给手动恢复命令", async () => {
    const oldHead = sh(user, "rev-parse", "HEAD");
    const r = await runUpdate(job(steps({ build: 2 })));
    expect(r).toMatchObject({ ok: false, outcome: "stuck" });
    expect(r.manualCommands).toContain(`git reset --hard ${oldHead}`);
    expect(r.manualCommands).toContain("npm run restart");
    expect(fs.readFileSync(r.log, "utf-8")).toContain(`git reset --hard ${oldHead}`);
  });
});
