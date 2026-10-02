/** Codex 审第 9 轮 P1：不带 turn_id / client_id 的对话轮（命令行 `autocrew revise` 就是这样）也算在跑、更新中被拒。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIpcHandlers } from "../../desktop/ipc.js";
import { acquireLock, busyWork, releaseLock, UPDATING_MESSAGE } from "./preflight.js";
import { activeWorkCount, resetActiveWork } from "./active-work.js";

let tmp: string;
const prev = process.env.AUTOCREW_LOCAL_DIR;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review9-")); process.env.AUTOCREW_LOCAL_DIR = tmp; resetActiveWork(); });
afterEach(() => {
  if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev;
  resetActiveWork();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 命令行 revise 发的样子：只有 message 和 context，没有 turn_id / client_id
const CLI_TURN = { message: "把开头改短一点", context: { content_id: "content-1-a" } };

describe("不带 id 的对话轮", () => {
  it("跑的时候算在跑（预检据此判忙）", async () => {
    let release!: () => void;
    let seen = -1;
    const h = buildIpcHandlers({ "chat:turn": async () => { seen = activeWorkCount(); await new Promise<void>((r) => { release = r; }); return { ok: true }; } });
    const pending = h["chat:turn"](CLI_TURN);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toBe(1);
    expect(busyWork(tmp, { inProcessTurns: activeWorkCount })).toMatch(/正在跑/);
    release();
    await pending;
    expect(activeWorkCount()).toBe(0);
  });

  it("更新锁在手：直接回「正在更新，稍后再试」，不进对话", async () => {
    expect(acquireLock(tmp, "t")).toBe(true);
    let ran = false;
    const h = buildIpcHandlers({ "chat:turn": async () => { ran = true; return { ok: true }; } });
    expect(await h["chat:turn"](CLI_TURN)).toEqual({ ok: false, code: "updating", error: UPDATING_MESSAGE });
    expect(ran).toBe(false);
    releaseLock(tmp, "t");
  });
});
