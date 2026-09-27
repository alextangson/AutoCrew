import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPendingStorage, previewStorage, queueStorage, storageStatus } from "./library-manager.js";
import { getConfigDir, getHostStateDir, LIBRARY_MARKER, readLibraryLocation, resolveDataDir } from "./storage-roots.js";
import { acquireLibraryLock, WRITER_LOCK } from "./library-lock.js";
import { addAssets, getAsset, listLibrary, removeAsset, updateAsset } from "./library-store.js";
import { createWorkspace, listWorkspaces, switchWorkspace } from "../desktop/workspace-store.js";
import { saveContent, getContent } from "./local-store.js";
import { loadWechatMpConfig } from "../modules/publish/wechat-config.js";
import { writeJsonAtomic } from "./json-atomic.js";
import { loadProjectRoots } from "../modules/video/handoff/roots.js";

let temp: string, local: string, target: string;
async function put(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-storage-test-")));
  local = path.join(temp, "machine"); target = path.join(temp, "NAS");
  await fs.mkdir(local);
  vi.stubEnv("AUTOCREW_LOCAL_DIR", local);
  vi.stubEnv("AUTOCREW_DATA_DIR", "");
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(temp, { recursive: true, force: true }); });

describe("portable libraries", () => {
  it("copies content and external media, keeps credentials local and existing NAS projects untouched", async () => {
    await put(path.join(target, "2026", "existing.md"), "existing project");
    await put(path.join(local, "publish.json"), { wechatMp: { wechatAppSecret: "fixture-secret" } });
    await put(path.join(local, "server-token"), "fixture-token");
    await put(path.join(local, "unknown-key"), "fixture-private");
    const original = await saveContent({ title: "test", body: "version one", platform: "wechat_mp", status: "drafting", tags: [] }, local);
    const media = path.join(temp, "original.mp4"); await put(media, "media bytes");
    const imported = await addAssets([media], null, local);
    const plan = await queueStorage({ action: "migrate", target });
    expect(plan.externalReferences).toBe(1);
    expect(plan.retained).toContain("default/unknown-key");
    expect(resolveDataDir()).toBe(local); // queuing never redirects an active service
    await applyPendingStorage();
    expect(resolveDataDir()).toBe(path.join(target, "workspaces", "default"));
    expect((await getContent(original.id))?.body).toBe("version one");
    expect((await getContent(original.id, local))?.body).toBe("version one");
    expect((await loadWechatMpConfig()).wechatAppSecret).toBe("fixture-secret");
    expect(getConfigDir()).toContain(path.join(local, "libraries"));
    expect(getHostStateDir(resolveDataDir())).toBe(local);
    await expect(fs.access(path.join(resolveDataDir(), "publish.json"))).rejects.toThrow();
    await expect(fs.access(path.join(target, "server-token"))).rejects.toThrow();
    expect(await fs.readFile(path.join(target, "2026", "existing.md"), "utf8")).toBe("existing project");
    const asset = await getAsset(imported.added[0].id);
    expect(asset?.path.startsWith(target)).toBe(true);
    expect(await fs.readFile(asset!.path, "utf8")).toBe("media bytes");
    const disk = JSON.parse(await fs.readFile(path.join(resolveDataDir(), "library", "assets", `${asset!.id}.json`), "utf8"));
    expect(path.isAbsolute(disk.path)).toBe(false);
    expect(await fs.readFile(media, "utf8")).toBe("media bytes");
    expect((await loadProjectRoots(resolveDataDir())).roots).toEqual([path.join(resolveDataDir(), "projects")]);
  });

  it("managed imports survive source deletion, updates preserve relative paths, workspaces isolate config", async () => {
    await queueStorage({ action: "create", target }); await applyPendingStorage();
    acquireLibraryLock();
    const source = path.join(temp, "shot.mp4"); await put(source, "original bytes");
    const { added } = await addAssets([source], null);
    expect(added[0].path).not.toBe(source);
    await fs.unlink(source);
    await updateAsset(added[0].id, { name: "renamed", tags: ["demo"] });
    expect((await listLibrary()).assets[0].missing).toBe(false);
    const workspace = await createWorkspace("另一个账号");
    expect(workspace.dataDir).toBe(path.join(target, "workspaces", workspace.id));
    expect(getConfigDir(workspace.dataDir)).toBe(path.join(local, "libraries", readLibraryLocation()!.id, "workspaces", workspace.id));
    expect(await listLibrary(workspace.dataDir)).toEqual({ folders: [], assets: [] });
    await switchWorkspace("default");
    expect((await listWorkspaces()).active).toBe("default");
    await removeAsset(added[0].id);
    expect(await fs.readFile(added[0].path, "utf8")).toBe("original bytes");
  });

  it("missing or substituted NAS fails closed and status remains available", async () => {
    await queueStorage({ action: "create", target }); await applyPendingStorage();
    const data = resolveDataDir();
    await fs.rename(target, `${target}-offline`);
    expect(() => resolveDataDir()).toThrow(/未连接/);
    expect(() => resolveDataDir(data)).toThrow(/未连接/);
    await expect(writeJsonAtomic(path.join(data, "new.json"), {})).rejects.toThrow(/未连接/);
    expect((await storageStatus()).connected).toBe(false);
    await expect(fs.access(target)).rejects.toThrow();
    await fs.mkdir(target);
    await put(path.join(target, LIBRARY_MARKER), { version: 1, id: "lib-deadbeef" });
    expect(() => resolveDataDir()).toThrow(/身份不匹配/);
  });

  it("rejects another writer and releases only its own lock", async () => {
    await queueStorage({ action: "create", target }); await applyPendingStorage();
    const release = acquireLibraryLock();
    expect(() => acquireLibraryLock()).toThrow(/占用/);
    release();
    const again = acquireLibraryLock(); again();
    await expect(fs.access(path.join(target, WRITER_LOCK))).rejects.toThrow();
  });

  it("does not overwrite destination, follow symlinks, copy unclassified secrets or apply while running", async () => {
    await put(path.join(target, "workspaces", "keep.txt"), "keep");
    await expect(previewStorage({ action: "migrate", target })).rejects.toThrow(/不会覆盖/);
    await expect(previewStorage({ action: "migrate", target: path.join(local, "nested") })).rejects.toThrow(/相互包含/);
    await fs.rm(path.join(target, "workspaces"), { recursive: true });
    await queueStorage({ action: "migrate", target });
    await put(path.join(local, "autocrew.pid"), String(process.pid));
    await expect(applyPendingStorage()).rejects.toThrow(/先停止/);
    expect(readLibraryLocation()).toBeNull();
    await fs.unlink(path.join(local, "autocrew.pid"));
    await fs.mkdir(path.join(local, "contents"));
    await fs.symlink(path.join(temp, "outside"), path.join(local, "contents", "linked"));
    await expect(applyPendingStorage()).rejects.toThrow(/符号链接/);
    expect(readLibraryLocation()).toBeNull();
  });

  it("opens a library at a new mount location without breaking managed media or machine configuration", async () => {
    await put(path.join(local, "publish.json"), { wechatMp: { wechatAppSecret: "private" } });
    await queueStorage({ action: "migrate", target }); await applyPendingStorage();
    const releaseWriter = acquireLibraryLock();
    const source = path.join(temp, "pic.png"); await put(source, "pic");
    const { added } = await addAssets([source], null);
    releaseWriter();
    const moved = path.join(temp, "new-mount");
    await fs.rename(target, moved);
    // Reconnection must be possible even when the old mount is unavailable.
    await queueStorage({ action: "open", target: moved });
    await applyPendingStorage();
    expect((await getAsset(added[0].id))?.path.startsWith(moved)).toBe(true);
    expect((await loadWechatMpConfig()).wechatAppSecret).toBe("private");
  });

  it("losing the destination during a transfer cannot create a local replacement or switch the pointer", async () => {
    await put(path.join(local, "topics", "one.json"), { id: "one" });
    await put(path.join(local, "topics", "two.json"), { id: "two" });
    await queueStorage({ action: "migrate", target });
    // Synchronous rename models the mount disappearing between two completed files.
    const { renameSync } = await import("node:fs");
    await expect(applyPendingStorage((copied) => {
      if (copied === 1) renameSync(target, `${target}-disconnected`);
    })).rejects.toThrow(/断开或被替换/);
    expect(readLibraryLocation()).toBeNull();
    await expect(fs.access(target)).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(local, "topics", "one.json"), "utf8"))).toEqual({ id: "one" });
  });

  it("reports an already-missing asset during preview before copying any data", async () => {
    const media = path.join(temp, "removed.mov");
    await put(media, "original");
    await addAssets([media], null, local);
    await fs.unlink(media);
    await expect(previewStorage({ action: "migrate", target })).rejects.toThrow(/缺失文件/);
    await expect(fs.access(target)).rejects.toThrow();
    expect(readLibraryLocation()).toBeNull();
  });

  it("migrates the current library back to local storage without reverting new work or reformatting immutable files", async () => {
    await put(path.join(local, "publish.json"), { wechatMp: { wechatAppSecret: "fixture-private" } });
    const c = await saveContent({ title: "Before NAS", body: "original", status: "drafting", tags: [] }, local);
    await queueStorage({ action: "migrate", target }); await applyPendingStorage();
    const sourceId = readLibraryLocation()!.id, configDir = getConfigDir();
    const release = acquireLibraryLock();
    const { updateContent } = await import("./local-store.js");
    await updateContent(c.id, { title: "Written on NAS", body: "latest NAS draft" });
    const brief = '{\n  "revision": 2,\n  "summary": "exact original bytes"\n}\n';
    const relativeBrief = "workspaces/default/research/briefs/topic-example.v2.json";
    await put(path.join(target, relativeBrief), brief);
    const previousMeta = await fs.readFile(path.join(resolveDataDir(), "contents", c.id, "meta.json"), "utf8");
    release();
    const newLocal = path.join(temp, "local-library");
    await queueStorage({ action: "migrate", target: newLocal }); await applyPendingStorage();
    expect(readLibraryLocation()).toEqual({ version: 1, id: sourceId, root: newLocal });
    expect(getConfigDir()).toBe(configDir);
    expect((await loadWechatMpConfig()).wechatAppSecret).toBe("fixture-private");
    expect((await getContent(c.id))?.body).toBe("latest NAS draft");
    expect(await fs.readFile(path.join(newLocal, relativeBrief), "utf8")).toBe(brief);
    expect(await fs.readFile(path.join(target, relativeBrief), "utf8")).toBe(brief);
    expect(await fs.readFile(path.join(target, "workspaces/default/contents", c.id, "meta.json"), "utf8")).toBe(previousMeta);
    await expect(fs.access(path.join(newLocal, "workspaces/default/project-layout.json"))).rejects.toThrow();
  });
});
