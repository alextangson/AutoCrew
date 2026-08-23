import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PULL_PLATFORMS,
  PULL_STATE_FILE,
  defaultPullState,
  isPullPlatform,
  localDay,
  readPullState,
  updatePlatformPullState,
  writePullState,
} from "./pull-state.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pull-state-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const statePath = (): string => path.join(dir, PULL_STATE_FILE);

describe("pull-state — 默认与损坏重建", () => {
  it("文件不存在 = 首次使用：三平台全关，不 warn", async () => {
    const warn = vi.fn();
    const state = await readPullState(dir, warn);
    expect(state.schemaVersion).toBe(1);
    for (const p of PULL_PLATFORMS) {
      expect(state.platforms[p].enabled).toBe(false);
      expect(state.platforms[p].lastStatus).toBe("never");
      expect(state.platforms[p].nextEligibleAt).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("文件损坏 → 重建默认 + warn（状态是缓存不是账本）", async () => {
    await fs.writeFile(statePath(), "{ 这不是 JSON", "utf-8");
    const warn = vi.fn();
    const state = await readPullState(dir, warn);
    expect(state).toEqual(defaultPullState());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(PULL_STATE_FILE);
  });

  it("schemaVersion 不认识 → 重建默认 + warn", async () => {
    await fs.writeFile(statePath(), JSON.stringify({ schemaVersion: 99, platforms: {} }), "utf-8");
    const warn = vi.fn();
    expect(await readPullState(dir, warn)).toEqual(defaultPullState());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("单个平台条目脏了只回退这一格，另外两家的状态保住", async () => {
    const state = defaultPullState();
    state.platforms.douyin.enabled = true;
    state.platforms.douyin.lastStatus = "ok";
    await writePullState(state, dir);
    const raw = JSON.parse(await fs.readFile(statePath(), "utf-8"));
    raw.platforms.xiaohongshu = "坏了";
    await fs.writeFile(statePath(), JSON.stringify(raw), "utf-8");

    const reread = await readPullState(dir);
    expect(reread.platforms.douyin.enabled).toBe(true);
    expect(reread.platforms.douyin.lastStatus).toBe("ok");
    expect(reread.platforms.xiaohongshu.enabled).toBe(false);
    expect(reread.platforms.xiaohongshu.lastStatus).toBe("never");
  });

  it("真 IO 故障（路径是目录）照实抛——不许谎报成「没数据」", async () => {
    await fs.mkdir(statePath());
    await expect(readPullState(dir)).rejects.toThrow();
  });
});

describe("pull-state — 写队列", () => {
  it("并发更新不互相吞：两个平台的改动都在", async () => {
    await Promise.all([
      updatePlatformPullState("douyin", (p) => ({ ...p, enabled: true }), dir),
      updatePlatformPullState("xiaohongshu", (p) => ({ ...p, failureCount: 3 }), dir),
      updatePlatformPullState("wechat_video", (p) => ({ ...p, lastRowCount: 12 }), dir),
    ]);
    const state = await readPullState(dir);
    expect(state.platforms.douyin.enabled).toBe(true);
    expect(state.platforms.xiaohongshu.failureCount).toBe(3);
    expect(state.platforms.wechat_video.lastRowCount).toBe(12);
  });

  it("同平台连续自增不丢计数（读-改-写整段在队列内）", async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        updatePlatformPullState("douyin", (p) => ({ ...p, failureCount: p.failureCount + 1 }), dir),
      ),
    );
    expect((await readPullState(dir)).platforms.douyin.failureCount).toBe(5);
  });

  it("落盘是原子写：读回来永远是完整 JSON", async () => {
    const state = defaultPullState();
    state.platforms.douyin.lastBatchId = "pull-douyin-1";
    await writePullState(state, dir);
    const raw = await fs.readFile(statePath(), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).platforms.douyin.lastBatchId).toBe("pull-douyin-1");
  });
});

describe("pull-state — 小工具", () => {
  it("isPullPlatform 只认三家（公众号走既有通道，不在此列）", () => {
    expect(isPullPlatform("douyin")).toBe(true);
    expect(isPullPlatform("wechat_video")).toBe(true);
    expect(isPullPlatform("xiaohongshu")).toBe(true);
    expect(isPullPlatform("wechat_mp")).toBe(false);
    expect(isPullPlatform(null)).toBe(false);
  });

  it("localDay 是本地时区自然日（与 localDateStamp 同一把尺子）", () => {
    const d = new Date(2026, 7, 23, 1, 30);
    expect(localDay(d)).toBe("2026-08-23");
  });
});
