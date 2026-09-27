import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProjectLayout, resolveContentProject } from "./content-project.js";
import { saveContent, getContent, type Content } from "./local-store.js";
import { commitProjectContent } from "./project-commit.js";
import { acquireLibraryLock } from "./library-lock.js";
import { portableProjectRecord } from "./project-record.js";
import { syncMyContentView, VIEW_DIR, ERROR_FILE } from "./my-content-view.js";
import { archivePublished, type ArchiveOptions } from "./nas-archive.js";

let release: () => void;
let temp: string, lib: string, data: string, view: string, nas: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-archive-test-"));
  const machine = path.join(temp, "machine");
  lib = path.join(temp, "library");
  data = path.join(lib, "workspaces/default");
  view = path.join(lib, VIEW_DIR);
  nas = path.join(temp, "nas");
  vi.stubEnv("AUTOCREW_LOCAL_DIR", machine);
  await fs.mkdir(machine, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(nas, { recursive: true });
  await fs.writeFile(path.join(machine, "storage.json"), JSON.stringify({ version: 1, id: "lib-deadbeef", root: lib }));
  await fs.writeFile(path.join(lib, "autocrew-library.json"), JSON.stringify({ version: 1, id: "lib-deadbeef" }));
  release = acquireLibraryLock(lib);
  await initializeProjectLayout(data, "lib-deadbeef", "default");
});
afterEach(async () => {
  release?.();
  vi.unstubAllEnvs();
  await fs.rm(temp, { recursive: true, force: true });
});

const NOW = new Date(2026, 8, 27, 14, 30);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
const root = (c: Content) => resolveContentProject(c.id, data)!.project_root;
const archive = (opts: ArchiveOptions = {}) =>
  archivePublished(data, { now: NOW, archiveRoot: nas, freeSpace: async () => 1e12, marginBytes: 0, ...opts });

async function make(title: string, patch: Partial<Content>): Promise<Content> {
  const c = await saveContent({ title, body: `${title} 正文`, platform: "douyin", status: "drafting", tags: [] }, data);
  const next = { ...(await getContent(c.id, data))!, createdAt: new Date(2026, 8, 1).toISOString(), ...patch };
  await commitProjectContent(next, data);
  await fs.mkdir(path.join(root(next), "02-aroll"), { recursive: true });
  await fs.writeFile(path.join(root(next), "02-aroll/raw.mov"), `${title}-raw`);
  await fs.mkdir(path.join(root(next), "05-cover"), { recursive: true });
  await fs.writeFile(path.join(root(next), "05-cover/封面-3x4.png"), `${title}-cover`);
  return next;
}
const published = (title: string, days: number, extra: Partial<Content> = {}) =>
  make(title, { status: "published", publishedAt: daysAgo(days), ...extra });
/** 最近 5 条已发布（1–5 天前），占满保留名额 */
async function fiveRecent(): Promise<void> { for (let i = 1; i <= 5; i++) await published(`新${i}`, i); }
const nasDir = (c: Content) => path.join(nas, "2026", "September", path.basename(root(c)));

describe("NAS 归档", () => {
  it("archives only the 6th-newest+ published ≥7 days, unclaimed", async () => {
    await fiveRecent();
    const old = await published("旧稿", 8);
    const young = await published("三天稿", 3.5);
    const draft = await make("未发布", { status: "publish_ready" });
    const claim = { token: "clm-x", host: "codex", leaseUntil: new Date(NOW.getTime() + 3600_000).toISOString() } as unknown as Content["claim"];
    const claimed = await published("认领中", 9, { claim });
    const r = await archive();
    expect(r.errors).toEqual([]);
    expect(r.archived.map((a) => a.title)).toEqual(["旧稿"]);
    expect(r.archived[0].target).toBe(nasDir(old));
    expect(r.archived[0].freedBytes).toBe(Buffer.byteLength("旧稿-raw") + Buffer.byteLength("旧稿-cover"));
    expect(await fs.readFile(path.join(nasDir(old), "02-aroll/raw.mov"), "utf8")).toBe("旧稿-raw");
    expect(await exists(path.join(nasDir(old), "01-script/manuscripts/current.md"))).toBe(true);
    expect(await fs.readdir(path.join(root(old), "02-aroll"))).toEqual([]);
    expect(await exists(path.join(root(old), "01-script/manuscripts/current.md"))).toBe(true);
    for (const c of [young, draft, claimed]) expect(await exists(path.join(root(c), "02-aroll/raw.mov"))).toBe(true);
  });

  it("keeps the newest 5 published even when they are old", async () => {
    for (let i = 0; i < 5; i++) await published(`老${i}`, 20 + i);
    const r = await archive();
    expect(r.archived).toEqual([]);
    expect(r.pending).toBe(0);
  });

  it("does nothing when the NAS is not mounted and reports pending", async () => {
    await fiveRecent();
    const old = await published("旧稿", 8);
    const r = await archive({ archiveRoot: path.join(temp, "not-mounted") });
    expect(r.pending).toBe(1);
    expect(await exists(path.join(root(old), "02-aroll/raw.mov"))).toBe(true);
    expect(await fs.readFile(path.join(view, ERROR_FILE), "utf8")).toContain("NAS 未连接，有 1 条待归档");
    await archive();
    expect(await exists(path.join(view, ERROR_FILE))).toBe(false);
  });

  it("deletes nothing when a copy does not verify", async () => {
    await fiveRecent();
    const old = await published("旧稿", 8);
    const corrupt = async (s: string, d: string) => {
      await fs.copyFile(s, d);
      if (s.endsWith("raw.mov")) await fs.writeFile(d, "garbage");
    };
    const r = await archive({ copyImpl: corrupt });
    expect(r.archived).toEqual([]);
    expect(r.pending).toBe(1);
    expect(r.errors.join()).toContain("校验不一致");
    expect(await exists(path.join(root(old), "02-aroll/raw.mov"))).toBe(true);
    expect(await exists(path.join(root(old), "05-cover/封面-3x4.png"))).toBe(true);
    expect(await exists(path.join(root(old), "00-project/autocrew/relocations.json"))).toBe(false);
  });

  it("resumes after a partial copy, recopying mismatched files", async () => {
    await fiveRecent();
    const old = await published("旧稿", 8);
    await fs.mkdir(path.join(nasDir(old), "02-aroll"), { recursive: true });
    await fs.writeFile(path.join(nasDir(old), "02-aroll/raw.mov"), "half");
    const copied: string[] = [];
    const r = await archive({ copyImpl: async (s, d) => { copied.push(path.basename(s)); await fs.copyFile(s, d); } });
    expect(r.archived).toHaveLength(1);
    expect(copied).toContain("raw.mov");
    expect(await fs.readFile(path.join(nasDir(old), "02-aroll/raw.mov"), "utf8")).toBe("旧稿-raw");
  });

  it("finishes a deletion that failed midway", async () => {
    await fiveRecent();
    const old = await published("旧稿", 8);
    await archive();
    // 模拟上次删到一半：记录已写，但 05-cover 还有文件
    await fs.writeFile(path.join(root(old), "05-cover/封面-3x4.png"), "旧稿-cover");
    const r = await archive();
    expect(r.archived).toHaveLength(1);
    expect(await fs.readdir(path.join(root(old), "05-cover"))).toEqual([]);
  });

  it("writes relocations that portableProjectRecord decodes to the NAS path", async () => {
    await fiveRecent();
    const old = await published("旧稿", 8);
    await archive();
    const decoded = portableProjectRecord({ path: "@project/02-aroll/raw.mov", other: "x" }, root(old), true);
    expect(decoded.path).toBe(path.join(nasDir(old), "02-aroll/raw.mov"));
    const relocations = JSON.parse(await fs.readFile(path.join(root(old), "00-project/autocrew/relocations.json"), "utf8"));
    expect(Object.keys(relocations).sort()).toEqual(["@project/02-aroll/raw.mov", "@project/05-cover/封面-3x4.png"]);
    const notes = await fs.readdir(path.join(root(old), "00-project/notes"));
    const record = JSON.parse(await fs.readFile(path.join(root(old), "00-project/notes", notes.find((n) => n.startsWith("archive-"))!), "utf8"));
    expect(record.target).toBe(nasDir(old));
    expect(record.files.find((f: { rel: string }) => f.rel === "02-aroll/raw.mov").sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is idempotent on a second run", async () => {
    await fiveRecent();
    await published("旧稿", 8);
    await archive();
    const copy = vi.fn(async (s: string, d: string) => fs.copyFile(s, d));
    const r = await archive({ copyImpl: copy });
    expect(r).toEqual({ archived: [], pending: 0, errors: [] });
    expect(copy).not.toHaveBeenCalled();
  });

  it("skips an item when the NAS lacks free space", async () => {
    await fiveRecent();
    const old = await published("旧稿", 8);
    const r = await archive({ freeSpace: async () => 10, marginBytes: 100 });
    expect(r.archived).toEqual([]);
    expect(r.errors.join()).toContain("NAS 空间不够");
    expect(await exists(path.join(root(old), "02-aroll/raw.mov"))).toBe(true);
    expect(await exists(nasDir(old))).toBe(false);
  });

  it("lists archives newest-first in 我的内容/归档记录.md", async () => {
    await fiveRecent();
    await published("旧稿甲", 10);
    await archive({ now: new Date(NOW.getTime() - 86400_000) });
    await published("旧稿乙", 9);
    await archive();
    await syncMyContentView(data, { now: NOW });
    const md = await fs.readFile(path.join(view, "归档记录.md"), "utf8");
    expect(md.indexOf("旧稿乙")).toBeGreaterThan(0);
    expect(md.indexOf("旧稿乙")).toBeLessThan(md.indexOf("旧稿甲"));
    expect(md).toContain("| 2026-09-27 | 旧稿乙 | ");
    expect(md).toContain(path.join(nas, "2026", "September"));
    expect(md).toMatch(/旧稿乙 \| .+ \| \d+ B \|/);
    expect((await fs.stat(path.join(view, "归档记录.md"))).mode & 0o222).toBe(0);
  });
});
