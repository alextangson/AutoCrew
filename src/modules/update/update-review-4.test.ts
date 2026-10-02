/**
 * Codex 审第 4 轮的两条 P1：每条一个修之前会失败的用例。
 * 接手锁用真的 tsx 启动器跑（tsx 拉起的 node 才是脚本进程）；campaign 周期用注入的假依赖，不调模型。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireLock, lockAdoptedBy, lockHeld, releaseLock } from "./preflight.js";
import { spawnDetachedUpdater, type Prepared } from "./start.js";
import { activeWorkCount, resetActiveWork, runUnlessUpdating } from "./active-work.js";
import { readResult } from "./state.js";
import { runManagedCampaignHostTick } from "../campaign/managed-host.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string;
const prev = process.env.AUTOCREW_LOCAL_DIR;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-upd-review4-")); process.env.AUTOCREW_LOCAL_DIR = tmp; resetActiveWork(); });
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("P1 接手锁按暗号确认，不比 pid（真 tsx 启动器）", () => {
  it("tsx 拉起的脚本接手后：报开始、不结束它，它自己写的结果算数", async () => {
    // 一个假的程序根：node_modules/.bin/tsx 指向真的 tsx；scripts/update.mts 只接手锁、等一会儿、写结果、放锁
    const root = path.join(tmp, "root");
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "scripts"));
    fs.symlinkSync(fs.realpathSync(path.join(REPO, "node_modules", ".bin", "tsx")), path.join(root, "node_modules", ".bin", "tsx"));
    fs.symlinkSync(path.join(REPO, "node_modules", "tsx"), path.join(root, "node_modules", "tsx")); // 更新进程用 node --import tsx 起
    const mod = (f: string) => JSON.stringify(pathToFileURL(path.join(REPO, "src/modules/update", f)).href);
    fs.writeFileSync(path.join(root, "scripts", "update.mts"), [
      `import { adoptLock, releaseLock } from ${mod("preflight.ts")};`,
      `import { writeResult } from ${mod("state.ts")};`,
      `const arg = (n: string) => process.argv[process.argv.indexOf("--" + n) + 1];`,
      `const dir = process.env.AUTOCREW_LOCAL_DIR!;`,
      `if (!adoptLock(dir, arg("lock-token"), arg("adopt-nonce"))) process.exit(2);`,
      `await new Promise((r) => setTimeout(r, 1500));`,
      `writeResult(dir, { ok: true, outcome: "updated", from: "0.4.0", to: "0.5.0", at: new Date().toISOString(), message: "已更新到 0.5.0", log: arg("log") });`,
      `releaseLock(dir, arg("lock-token"));`,
    ].join("\n"));
    expect(acquireLock(tmp, "tok")).toBe(true);
    const job: Prepared = { ok: true, tag: "v0.5.0", commit: "a".repeat(40), head: "b".repeat(40), from: "0.4.0", to: "0.5.0", notes: [], token: "tok" };
    const r = await spawnDetachedUpdater(root, tmp, 1, job, undefined, 15_000);
    expect(r).toMatchObject({ ok: true });
    expect(lockAdoptedBy(tmp)).not.toBeNull();
    // 没被结束：它照样把自己的结果写出来、把锁放掉
    const deadline = Date.now() + 15_000;
    while (lockHeld(tmp) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
    expect(readResult(tmp)).toMatchObject({ ok: true, outcome: "updated" });
    expect(lockHeld(tmp)).toBe(false);
  }, 40_000);
});

describe("P1 campaign 托管周期与其他定时周期", () => {
  it("更新中：这一拍跳过（不读 campaign、不调模型），记一句日志", async () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    let listed = 0;
    const r = await runManagedCampaignHostTick(tmp, { list: async () => { listed++; return []; } });
    expect(r).toEqual([]);
    expect(listed).toBe(0);
    releaseLock(tmp, "t");
  });

  it("跑的时候算在跑，跑完释放", async () => {
    let release!: () => void;
    let seen = -1;
    const p = runManagedCampaignHostTick(tmp, { list: async () => { seen = activeWorkCount(); await new Promise<void>((r) => { release = r; }); return []; } });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toBe(1);
    release();
    await p;
    expect(activeWorkCount()).toBe(0);
  });

  it("定时周期的通用闸：更新中跳过并记日志，否则登记到这一拍结束", async () => {
    const logs: string[] = [];
    expect(acquireLock(tmp, "t")).toBe(true);
    expect(await runUnlessUpdating("选题雷达周期", async () => "ran", (m) => logs.push(m))).toBeNull();
    expect(logs[0]).toContain("跳过");
    releaseLock(tmp, "t");
    expect(await runUnlessUpdating("选题雷达周期", async () => { expect(activeWorkCount()).toBe(1); return "ran"; })).toBe("ran");
    expect(activeWorkCount()).toBe(0);
  });
});
