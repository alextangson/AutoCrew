/** e2e 的 P3：被复用的 pid 不算持锁人；失败原因是人话、命令行只进日志。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, lockHeld } from "./preflight.js";
import { startEpoch } from "./process-start.js";
import { realSteps } from "./updater.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-p3-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("锁的主人按 pid + 启动时刻认", () => {
  it("锁里的 pid 现在被别的进程用着（启动时刻对不上）：当死锁收回", () => {
    // 本进程活着，但锁里记的启动时刻是很久以前——说明那个持锁进程早没了，pid 被复用
    fs.writeFileSync(path.join(tmp, "update.lock"), JSON.stringify({ pid: process.pid, token: "old", at: "", start: 1 }));
    expect(lockHeld(tmp)).toBe(false);
    expect(acquireLock(tmp, "new")).toBe(true);
  });

  it("拿到的锁记下自己的启动时刻，自己就是活的持锁人", () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    const body = JSON.parse(fs.readFileSync(path.join(tmp, "update.lock"), "utf-8")) as { start: number };
    expect(body.start).toBe(startEpoch(process.pid));
    expect(lockHeld(tmp)).toBe(true);
  });
});

describe("失败原因说人话", () => {
  it("装依赖失败：原因里没有命令行，命令行在日志里", async () => {
    const npm = path.join(tmp, "fake-npm.sh");
    fs.writeFileSync(npm, "#!/bin/sh\necho 'npm ERR! network' >&2\nexit 1\n", { mode: 0o755 });
    const lines: string[] = [];
    const err = await realSteps(tmp, 1, { serverWasRunning: false, busy: async () => null, npm }).install((l) => lines.push(l)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("装依赖没成功（退出码 1），详情见日志");
    expect(lines.join("\n")).toContain("ci --prefer-offline");
  });
});
