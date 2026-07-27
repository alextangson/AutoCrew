/**
 * settings-video.test.ts —— 视频线配置三件套：读缺省、增量写、非法值当场拒、
 * 600 权限、真变更才广播。落盘根是**工作区** <dataDir>（与 engine/publish 同侧）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getVideoSettings,
  getVideoSettingsRaw,
  onVideoSettingsChanged,
  setVideoSettings,
  type VideoSettings,
} from "./settings-video.js";

let dir: string;
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-settings-"));
});

afterEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  await fs.rm(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, "video.json");

describe("video:settings_get / set", () => {
  it("没配置过：读到全默认，不报错也不建文件", async () => {
    expect(await getVideoSettings({ _dataDir: dir })).toEqual({
      ok: true,
      data: { renderConcurrency: null, snapshotCopy: false },
    });
    await expect(fs.access(file())).rejects.toThrow();
  });

  it("写入后回读一致，落盘是 600（配置文件将来要放密钥）", async () => {
    const res = await setVideoSettings({ _dataDir: dir, render_concurrency: 4, snapshot_copy: true });
    expect(res).toEqual({ ok: true, data: { renderConcurrency: 4, snapshotCopy: true } });
    expect(await getVideoSettingsRaw(dir)).toEqual({ renderConcurrency: 4, snapshotCopy: true });
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
  });

  it("增量：只传一个字段不清掉另一个", async () => {
    await setVideoSettings({ _dataDir: dir, render_concurrency: 2, snapshot_copy: true });
    await setVideoSettings({ _dataDir: dir, snapshot_copy: false });
    expect(await getVideoSettingsRaw(dir)).toEqual({ renderConcurrency: 2 });
  });

  it("清空：render_concurrency 传 null 回到「交给渲染层自己定」", async () => {
    await setVideoSettings({ _dataDir: dir, render_concurrency: 8 });
    expect(await setVideoSettings({ _dataDir: dir, render_concurrency: null })).toEqual({
      ok: true,
      data: { renderConcurrency: null, snapshotCopy: false },
    });
  });

  it.each([
    [{ render_concurrency: 0.5 }, "render_concurrency"],
    [{ render_concurrency: 99 }, "render_concurrency"],
    [{ render_concurrency: "4" }, "render_concurrency"],
    [{ snapshot_copy: "yes" }, "snapshot_copy"],
  ])("非法值 %# 当场拒，且不落盘", async (patch, field) => {
    const res = await setVideoSettings({ _dataDir: dir, ...patch });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(field);
    await expect(fs.access(file())).rejects.toThrow();
  });

  it("没有可写字段：说清楚能写什么", async () => {
    const res = await setVideoSettings({ _dataDir: dir, nonsense: 1 });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("render_concurrency");
  });

  it("磁盘上的非法值被读侧丢弃（坏配置不传染渲染层）", async () => {
    await fs.writeFile(file(), JSON.stringify({ renderConcurrency: -3, snapshotCopy: "true" }));
    expect(await getVideoSettingsRaw(dir)).toEqual({});
  });

  it("文件损坏要炸出来，不能静默当空——否则一次保存就把真配置覆盖没了", async () => {
    await fs.writeFile(file(), "{ 坏掉的 json");
    const res = await getVideoSettings({ _dataDir: dir });
    expect(res.ok).toBe(false);
  });

  it("变更事件：真变了才发，原样重存不发", async () => {
    const seen: VideoSettings[] = [];
    unsubscribe = onVideoSettingsChanged((s) => seen.push(s));
    await setVideoSettings({ _dataDir: dir, render_concurrency: 3 });
    await setVideoSettings({ _dataDir: dir, render_concurrency: 3 });
    expect(seen).toEqual([{ renderConcurrency: 3 }]);
  });

  it("payload 不是对象：边界守卫兜住", async () => {
    expect(await getVideoSettings(null as never)).toMatchObject({ ok: false });
    expect(await setVideoSettings([] as never)).toMatchObject({ ok: false });
  });
});
