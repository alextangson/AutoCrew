// src/storage/library-store.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectType,
  createFolder,
  removeFolder,
  addAssets,
  listLibrary,
} from "./library-store.js";

let dir: string;
let mediaDir: string;

async function makeFile(name: string, content = "x"): Promise<string> {
  const p = path.join(mediaDir, name);
  await fs.writeFile(p, content, "utf-8");
  return p;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-lib-test-"));
  mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-media-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(mediaDir, { recursive: true, force: true });
});

describe("detectType", () => {
  it("classifies by extension, case-insensitive", () => {
    expect(detectType("/a/b/clip.MP4")).toEqual({ type: "video", ext: "mp4" });
    expect(detectType("/a/封面.png")).toEqual({ type: "image", ext: "png" });
    expect(detectType("/a/bgm.m4a")).toEqual({ type: "audio", ext: "m4a" });
    expect(detectType("/a/notes.txt")).toEqual({ type: "other", ext: "txt" });
    expect(detectType("/a/noext")).toEqual({ type: "other", ext: "" });
  });
});

describe("folders", () => {
  it("creates and lists folders", async () => {
    const f = await createFolder("b-roll", dir);
    expect(f.id).toMatch(/^folder-\d+-[a-z0-9]+$/);
    const view = await listLibrary(dir);
    expect(view.folders.map((x) => x.name)).toEqual(["b-roll"]);
  });

  it("removeFolder moves its assets to root and returns true", async () => {
    const f = await createFolder("临时", dir);
    const p = await makeFile("clip.mp4");
    const { added } = await addAssets([p], f.id, dir);
    expect(added[0].folderId).toBe(f.id);
    expect(await removeFolder(f.id, dir)).toBe(true);
    const view = await listLibrary(dir);
    expect(view.folders).toEqual([]);
    expect(view.assets[0].folderId).toBeNull();
  });

  it("removeFolder returns false for unknown/invalid id", async () => {
    expect(await removeFolder("folder-1-gone", dir)).toBe(false);
    expect(await removeFolder("../etc", dir)).toBe(false);
  });
});

describe("addAssets / listLibrary", () => {
  it("imports with detected type/size, name defaults to filename", async () => {
    const p = await makeFile("开场钩子.mp4", "0123456789");
    const { added, skipped } = await addAssets([p], null, dir);
    expect(skipped).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: "开场钩子.mp4", type: "video", ext: "mp4", size: 10, folderId: null, tags: [],
    });
    expect(added[0].id).toMatch(/^asset-\d+-[a-z0-9]+$/);
    expect(added[0].path).toBe(p);
  });

  it("dedupes by resolved path (idempotent re-import)", async () => {
    const p = await makeFile("a.png");
    await addAssets([p], null, dir);
    const second = await addAssets([p], null, dir);
    expect(second.added).toEqual([]);
    expect(second.skipped).toEqual([p]);
    expect((await listLibrary(dir)).assets).toHaveLength(1);
  });

  it("unknown folderId falls back to root", async () => {
    const p = await makeFile("b.png");
    const { added } = await addAssets([p], "folder-1-ghost", dir);
    expect(added[0].folderId).toBeNull();
  });

  it("nonexistent source path is skipped, not added", async () => {
    const res = await addAssets([path.join(mediaDir, "ghost.mp4")], null, dir);
    expect(res.added).toEqual([]);
    expect(res.skipped).toHaveLength(1);
  });

  it("flags missing when the original file disappears", async () => {
    const p = await makeFile("vanish.jpg");
    await addAssets([p], null, dir);
    await fs.unlink(p);
    const view = await listLibrary(dir);
    expect(view.assets[0].missing).toBe(true);
  });

  it("skips corrupt asset json with a warning, keeps the rest", async () => {
    const p = await makeFile("ok.png");
    const { added } = await addAssets([p], null, dir);
    await fs.writeFile(path.join(dir, "library", "assets", "asset-1-bad.json"), "{ nope", "utf-8");
    const view = await listLibrary(dir);
    expect(view.assets.map((a) => a.id)).toEqual([added[0].id]);
  });
});
