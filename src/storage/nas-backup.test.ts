import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProjectLayout, resolveContentProject } from "./content-project.js";
import { saveContent, getContent, type Content } from "./local-store.js";
import { commitProjectContent } from "./project-commit.js";
import { acquireLibraryLock } from "./library-lock.js";
import { syncMyContentView, VIEW_DIR, ERROR_FILE } from "./my-content-view.js";
import { columnDir, folderTitle } from "./my-content-plan.js";
import { archivePublished } from "./nas-archive.js";
import { backupPublished, type BackupOptions } from "./nas-backup.js";
import { keptName, sha256File } from "./nas-archive-copy.js";
import { readBackupState } from "./nas-backup-state.js";

let release: () => void;
let temp: string, lib: string, data: string, view: string, nas: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-backup-test-"));
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
const MONTHS: Record<number, string> = { 7: "August", 8: "September" };
const nasDir = (c: Content) => path.join(nas, "2026", MONTHS[new Date(c.publishedAt!).getMonth()], path.basename(root(c)));
const backup = (opts: BackupOptions = {}) => backupPublished(data, { now: NOW, archiveRoot: nas, ...opts });
const read = (p: string) => fs.readFile(p, "utf8");

async function put(c: Content, rel: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root(c), rel)), { recursive: true });
  await fs.writeFile(path.join(root(c), rel), text);
}

/** 带登记成片、字幕、原片、封面的已发布视频稿 */
async function make(title: string, patch: Partial<Content>): Promise<Content> {
  const c = await saveContent({ title, body: `${title} 正文`, platform: "douyin", status: "drafting", tags: [] }, data);
  const base = (await getContent(c.id, data))!;
  const r = resolveContentProject(c.id, data)!.project_root;
  const video = {
    handoff: { aroll_path: path.join(r, "02-aroll/raw.mov") },
    final: { asset_filename: "final-g1.mp4", srt_path: path.join(r, "07-delivery/export/final.srt") },
  } as unknown as Content["video"];
  const next = { ...base, createdAt: new Date(2026, 8, 1).toISOString(), video, ...patch };
  await commitProjectContent(next, data);
  await put(next, "02-aroll/raw.mov", `${title}-raw`);
  await put(next, "05-cover/封面-3x4.png", `${title}-cover`);
  await put(next, "07-delivery/registered/final-g1.mp4", `${title}-final`);
  await put(next, "07-delivery/export/final.srt", "1\n00:00:00,000 --> 00:00:01,000\n你好\n");
  return next;
}
const published = (title: string, days: number, extra: Partial<Content> = {}) =>
  make(title, { status: "published", publishedAt: daysAgo(days), ...extra });
const PLAN = {
  platforms: [{
    platform: "douyin", title: "抖音标题", scheduled_at: "2026-09-26T18:00:00+08:00",
    campaigns: [{ name: "抖音精选App征稿中" }],
    publication: { status: "scheduled", review_status: "reviewing", evidence: "作品管理截图", post_id: "7123" },
  }],
};
const itemDir = (c: Content, col: "已发布" | "待发布" = "已发布") => path.join(view, columnDir(col), folderTitle(c));

describe("发布即备份 NAS", () => {
  it("backs up published items whose publish time has come, including the newest 5; skips scheduled ones", async () => {
    const recent = await published("最新", 1);
    const scheduled = await make("定时稿", { status: "published", publishedAt: new Date(NOW.getTime() + 3600_000).toISOString() });
    const draft = await make("待发布", { status: "publish_ready" });
    const r = await backup();
    expect(r.errors).toEqual([]);
    expect(r.backedUp).toEqual(["最新"]);
    expect(await read(path.join(nasDir(recent), "02-aroll/raw.mov"))).toBe("最新-raw");
    expect(await exists(path.join(nasDir(recent), "01-script/manuscripts/current.md"))).toBe(true);
    // 备份只读不删
    expect(await exists(path.join(root(recent), "02-aroll/raw.mov"))).toBe(true);
    const notes = await fs.readdir(path.join(root(recent), "00-project/notes"));
    expect(notes.some((n) => /^backup-\d.+\.json$/.test(n))).toBe(true);
    expect(notes.some((n) => n.startsWith("archive-"))).toBe(false);
    for (const c of [scheduled, draft]) expect(await readBackupState(root(c))).toBeNull();
    const state = await readBackupState(root(recent));
    expect(state).toMatchObject({ status: "backed_up", failures: 0, target: nasDir(recent) });
    await syncMyContentView(data, { now: NOW });
    const status = await read(path.join(itemDir(recent), "NAS备份状态.txt"));
    expect(status).toContain("已备份到 NAS");
    expect(status).toContain(nasDir(recent));
    expect(status).toMatch(/文件数：\d+，总大小：/);
  });

  it("copies only changed files on the next run and keeps the replaced NAS version under a renamed name", async () => {
    const c = await published("稿", 1);
    await backup();
    const oldSha = await sha256File(path.join(nasDir(c), "02-aroll/raw.mov"));
    await new Promise((r) => setTimeout(r, 20));
    await put(c, "02-aroll/raw.mov", "稿-raw-v2");
    const copied: string[] = [];
    const r = await backup({ copyImpl: async (s, d) => { copied.push(path.relative(root(c), s)); await fs.copyFile(s, d); } });
    expect(r.errors).toEqual([]);
    expect(copied).toEqual(["02-aroll/raw.mov"]);
    const dest = path.join(nasDir(c), "02-aroll/raw.mov");
    expect(await read(dest)).toBe("稿-raw-v2");
    expect(await read(keptName(dest, oldSha))).toBe("稿-raw");
    const third = vi.fn(async (s: string, d: string) => fs.copyFile(s, d));
    await backup({ copyImpl: third });
    expect(third).not.toHaveBeenCalled();
  });

  it("marks items unmounted when the NAS is missing, without errors, and catches up once mounted", async () => {
    const a = await published("甲", 1);
    const b = await published("乙", 2);
    const r = await backup({ archiveRoot: path.join(temp, "not-mounted") });
    expect(r.errors).toEqual([]);
    expect(r.pending).toBe(2);
    await syncMyContentView(data, { now: NOW });
    for (const c of [a, b]) {
      const status = await read(path.join(itemDir(c), "NAS备份状态.txt"));
      expect(status).toContain("NAS 未挂载");
      expect(status).toContain("最后尝试");
    }
    expect(await exists(path.join(view, ERROR_FILE))).toBe(false);
    const again = await backup();
    expect(again.backedUp.sort()).toEqual(["乙", "甲"]);
    await syncMyContentView(data, { now: NOW });
    expect(await read(path.join(itemDir(a), "NAS备份状态.txt"))).toContain("已备份到 NAS");
  });

  it("does not mark a mismatched copy as done, retries, and reports the reason after 3 failures", async () => {
    const c = await published("坏", 1);
    const corrupt = async (s: string, d: string) => { await fs.copyFile(s, d); if (s.endsWith("raw.mov")) await fs.writeFile(d, "garbage"); };
    for (let i = 1; i <= 3; i++) {
      const r = await backup({ copyImpl: corrupt });
      expect(r.backedUp).toEqual([]);
      expect((await readBackupState(root(c)))!.failures).toBe(i);
    }
    const notes = await fs.readdir(path.join(root(c), "00-project/notes"));
    expect(notes.some((n) => /^backup-\d/.test(n))).toBe(false);
    await syncMyContentView(data, { now: NOW });
    const status = await read(path.join(itemDir(c), "NAS备份状态.txt"));
    expect(status).toContain("连续失败 3 次");
    expect(status).toContain("校验不一致");
    expect(await read(path.join(view, ERROR_FILE))).toContain("NAS 备份");
    const ok = await backup();
    expect(ok.backedUp).toEqual(["坏"]);
    expect(await exists(path.join(view, ERROR_FILE))).toBe(false);
  });
});

describe("7 天腾空间前核对 NAS", () => {
  async function oldBackedUp(): Promise<Content> {
    for (let i = 1; i <= 5; i++) await published(`新${i}`, i);
    const old = await published("旧稿", 8);
    await backup();
    return old;
  }

  it("recopies files missing or different on the NAS before deleting local media", async () => {
    const old = await oldBackedUp();
    await fs.rm(path.join(nasDir(old), "05-cover/封面-3x4.png"));
    await fs.writeFile(path.join(nasDir(old), "02-aroll/raw.mov"), "tampered");
    const r = await archivePublished(data, { now: NOW, archiveRoot: nas, freeSpace: async () => 1e12, marginBytes: 0 });
    expect(r.errors).toEqual([]);
    expect(r.archived.map((a) => a.title)).toEqual(["旧稿"]);
    expect(await read(path.join(nasDir(old), "05-cover/封面-3x4.png"))).toBe("旧稿-cover");
    expect(await read(path.join(nasDir(old), "02-aroll/raw.mov"))).toBe("旧稿-raw");
    expect(await fs.readdir(path.join(root(old), "02-aroll"))).toEqual([]);
  });

  it("deletes nothing when the NAS copy cannot be verified", async () => {
    const old = await oldBackedUp();
    await fs.writeFile(path.join(nasDir(old), "02-aroll/raw.mov"), "tampered");
    const corrupt = async (s: string, d: string) => { await fs.copyFile(s, d); if (s.endsWith("raw.mov")) await fs.writeFile(d, "garbage"); };
    const r = await archivePublished(data, { now: NOW, archiveRoot: nas, freeSpace: async () => 1e12, marginBytes: 0, copyImpl: corrupt });
    expect(r.archived).toEqual([]);
    expect(await exists(path.join(root(old), "02-aroll/raw.mov"))).toBe(true);
  });

  it("swaps 成片/原片 for NAS path notes after archiving, keeping covers, subtitles, script, receipt", async () => {
    const old = await oldBackedUp();
    await put(old, "06-publish/publish-plan.json", JSON.stringify(PLAN));
    await archivePublished(data, { now: NOW, archiveRoot: nas, freeSpace: async () => 1e12, marginBytes: 0 });
    await syncMyContentView(data, { now: NOW, keepPublished: 10 });
    const dir = itemDir(old);
    const names = await fs.readdir(dir);
    expect(names).not.toContain("成片.mp4");
    expect(names).not.toContain("原片.mov");
    expect(await read(path.join(dir, "成片在NAS.txt"))).toContain(path.join(nasDir(old), "07-delivery/registered/final-g1.mp4"));
    expect(await read(path.join(dir, "原片在NAS.txt"))).toContain(path.join(nasDir(old), "02-aroll/raw.mov"));
    expect(await read(path.join(dir, "封面-3x4.png"))).toBe("旧稿-cover");
    expect(await read(path.join(dir, "成片字幕.srt"))).toContain("你好");
    for (const n of ["口播稿.md", "发布回执.md", "发布文案.md"]) expect(names).toContain(n);
  });
});

describe("已发布文件夹补三样", () => {
  it("adds 成片字幕.srt, 发布回执.md and 原片 to published items only", async () => {
    const pub = await published("已发", 1);
    await put(pub, "06-publish/publish-plan.json", JSON.stringify(PLAN));
    const noPlan = await published("无计划", 2);
    const ready = await make("待发", { status: "publish_ready" });
    await put(ready, "06-publish/publish-plan.json", JSON.stringify(PLAN));
    await syncMyContentView(data, { now: NOW });
    const dir = itemDir(pub);
    expect(await read(path.join(dir, "成片字幕.srt"))).toContain("你好");
    expect(await read(path.join(dir, "原片.mov"))).toBe("已发-raw");
    expect((await fs.stat(path.join(dir, "原片.mov"))).ino).toBe((await fs.stat(path.join(root(pub), "02-aroll/raw.mov"))).ino);
    const receipt = await read(path.join(dir, "发布回执.md"));
    for (const s of ["## douyin", "抖音标题", "已定时", "审核中", "抖音精选App征稿中", "7123", "2026-09-26T18:00:00+08:00"]) expect(receipt).toContain(s);
    expect(await fs.readdir(itemDir(noPlan))).not.toContain("发布回执.md");
    const readyNames = await fs.readdir(itemDir(ready, "待发布"));
    for (const n of ["成片字幕.srt", "发布回执.md", "原片.mov", "NAS备份状态.txt"]) expect(readyNames).not.toContain(n);
  });

  it("leaves out 字幕 and 原片 when there is no source", async () => {
    const c = await published("无源", 1, { video: undefined });
    await syncMyContentView(data, { now: NOW });
    const names = await fs.readdir(itemDir(c));
    for (const n of ["成片字幕.srt", "原片.mov", "原片在NAS.txt"]) expect(names).not.toContain(n);
  });
});
