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
  updateAsset,
  removeAsset,
  getAsset,
  searchAssets,
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

describe("updateAsset", () => {
  it("patches name/tags/description/folderId", async () => {
    const p = await makeFile("raw.mp4");
    const f = await createFolder("精选", dir);
    const { added } = await addAssets([p], null, dir);
    const updated = await updateAsset(added[0].id, { name: "开场", tags: ["钩子", "excel"], folderId: f.id }, dir);
    expect(updated).toMatchObject({ name: "开场", tags: ["钩子", "excel"], folderId: f.id });
    const view = await listLibrary(dir);
    expect(view.assets[0].name).toBe("开场");
  });

  it("relocate updates path/size/ext/type and clears missing", async () => {
    const p = await makeFile("old.mp4", "12345");
    const { added } = await addAssets([p], null, dir);
    await fs.unlink(p);
    expect((await listLibrary(dir)).assets[0].missing).toBe(true);
    const p2 = await makeFile("new.png", "1234567");
    const updated = await updateAsset(added[0].id, { path: p2 }, dir);
    expect(updated).toMatchObject({ path: p2, size: 7, ext: "png", type: "image" });
    expect((await listLibrary(dir)).assets[0].missing).toBe(false);
  });

  it("relocate to a nonexistent file returns null (record unchanged)", async () => {
    const p = await makeFile("keep.mp4");
    const { added } = await addAssets([p], null, dir);
    expect(await updateAsset(added[0].id, { path: path.join(mediaDir, "ghost.mp4") }, dir)).toBeNull();
    expect((await listLibrary(dir)).assets[0].path).toBe(p);
  });

  it("unknown/invalid id returns null", async () => {
    expect(await updateAsset("asset-1-gone", { name: "x" }, dir)).toBeNull();
    expect(await updateAsset("../escape", { name: "x" }, dir)).toBeNull();
  });
});

describe("removeAsset / getAsset", () => {
  it("removes the record but never the original file", async () => {
    const p = await makeFile("precious.mp4");
    const { added } = await addAssets([p], null, dir);
    expect(await removeAsset(added[0].id, dir)).toBe(true);
    expect((await listLibrary(dir)).assets).toEqual([]);
    await expect(fs.access(p)).resolves.toBeUndefined(); // 原文件还在
  });

  it("getAsset returns record or null", async () => {
    const p = await makeFile("g.png");
    const { added } = await addAssets([p], null, dir);
    expect((await getAsset(added[0].id, dir))!.path).toBe(p);
    expect(await getAsset("asset-1-none", dir)).toBeNull();
  });
});

describe("searchAssets", () => {
  it("matches name and tags case-insensitively, optional type filter, passes missing through", async () => {
    const p1 = await makeFile("Excel钩子.mp4");
    const p2 = await makeFile("风景.png");
    const { added } = await addAssets([p1, p2], null, dir);
    await updateAsset(added[1].id, { tags: ["excel", "封面"] }, dir);
    const byName = await searchAssets("excel", undefined, dir);
    expect(byName.map((a) => a.name).sort()).toEqual(["Excel钩子.mp4", "风景.png"]);
    const onlyVideo = await searchAssets("excel", "video", dir);
    expect(onlyVideo.map((a) => a.name)).toEqual(["Excel钩子.mp4"]);
    await fs.unlink(p1);
    const after = await searchAssets("钩子", undefined, dir);
    expect(after[0].missing).toBe(true);
  });

  it("empty query returns all", async () => {
    const p = await makeFile("solo.mp3");
    await addAssets([p], null, dir);
    expect(await searchAssets("", undefined, dir)).toHaveLength(1);
  });
});
