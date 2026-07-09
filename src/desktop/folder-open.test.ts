/**
 * folder-open.test.ts — 稿件文件夹直达:id 白名单、存在性校验、darwin spawn、跨平台降级。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { spawn } from "node:child_process";
import { openContentFolder } from "./folder-open.js";
import { saveContent } from "../storage/local-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-folderopen-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mockSpawn(): { impl: typeof spawn; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  const impl = ((cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    return { unref: () => {} };
  }) as unknown as typeof spawn;
  return { impl, calls };
}

describe("openContentFolder", () => {
  it("darwin:spawn open <文件夹>,返回 opened:true 与路径", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "xiaohongshu", status: "draft_ready", tags: [], hashtags: [] }, dir);
    const { impl, calls } = mockSpawn();
    const r = await openContentFolder(c.id, dir, { spawnImpl: impl, platform: "darwin" });
    expect(r).toMatchObject({ ok: true, opened: true });
    expect(r.path).toBe(path.join(dir, "contents", c.id));
    expect(calls[0][0]).toBe("open");
    expect(calls[0][1]).toEqual([r.path]);
  });

  it("非 darwin:不 spawn,只返回路径", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "xiaohongshu", status: "draft_ready", tags: [], hashtags: [] }, dir);
    const { impl, calls } = mockSpawn();
    const r = await openContentFolder(c.id, dir, { spawnImpl: impl, platform: "linux" });
    expect(r).toMatchObject({ ok: true, opened: false });
    expect(calls).toHaveLength(0);
  });

  it("非法 id / 不存在的稿件 → 拒", async () => {
    const { impl } = mockSpawn();
    expect((await openContentFolder("../../etc", dir, { spawnImpl: impl, platform: "darwin" })).ok).toBe(false);
    expect((await openContentFolder("content-123-abcdef", dir, { spawnImpl: impl, platform: "darwin" })).ok).toBe(false);
  });

  it("spawn 抛错 → 降级为返回路径,不炸", async () => {
    const c = await saveContent({ title: "t", body: "b", platform: "xiaohongshu", status: "draft_ready", tags: [], hashtags: [] }, dir);
    const boom = (() => {
      throw new Error("no open binary");
    }) as unknown as typeof spawn;
    const r = await openContentFolder(c.id, dir, { spawnImpl: boom, platform: "darwin" });
    expect(r).toMatchObject({ ok: true, opened: false });
    expect(r.error).toContain("no open binary");
  });

  it("draft.md 本就随存稿常新(人机协同的另一半,回归锚)", async () => {
    const c = await saveContent({ title: "标题甲", body: "正文乙", platform: "xiaohongshu", status: "draft_ready", tags: [], hashtags: [] }, dir);
    const md = await fs.readFile(path.join(dir, "contents", c.id, "draft.md"), "utf-8");
    expect(md).toBe("# 标题甲\n\n正文乙\n");
  });
});

