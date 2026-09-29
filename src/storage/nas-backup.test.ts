import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
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

  it("recopies when the NAS copy was deleted, changed, or the target emptied, instead of trusting the manifest", async () => {
    const c = await published("稿", 1);
    await backup();
    const raw = path.join(nasDir(c), "02-aroll/raw.mov");
    await fs.rm(raw);
    expect((await backup()).backedUp).toEqual(["稿"]);
    expect(await read(raw)).toBe("稿-raw");
    await fs.writeFile(raw, "稿-rot");
    await backup();
    expect(await read(raw)).toBe("稿-raw");
    await fs.rm(nasDir(c), { recursive: true });
    const r = await backup();
    expect(r.backedUp).toEqual(["稿"]);
    expect(await read(raw)).toBe("稿-raw");
    expect(await read(path.join(nasDir(c), "05-cover/封面-3x4.png"))).toBe("稿-cover");
  });

  it("does not reuse a manifest written for a different target", async () => {
    const c = await published("稿", 1);
    await backup();
    const other = path.join(temp, "nas2");
    await fs.mkdir(other);
    const r = await backup({ archiveRoot: other });
    expect(r.backedUp).toEqual(["稿"]);
    expect(await read(path.join(other, "2026", "September", path.basename(root(c)), "02-aroll/raw.mov"))).toBe("稿-raw");
    expect((await readBackupState(root(c)))!.target.startsWith(other)).toBe(true);
  });

  it("keeps a verified NAS version when another file failed and the local file changed again before retry", async () => {
    const c = await published("稿", 1);
    await backup();
    const dest = path.join(nasDir(c), "02-aroll/raw.mov");
    const v1 = await sha256File(dest);
    await new Promise((r) => setTimeout(r, 20));
    await put(c, "02-aroll/raw.mov", "稿-raw-v2");
    await put(c, "05-cover/封面-3x4.png", "稿-cover-v2");
    const failCover = async (s: string, d: string) => { await fs.copyFile(s, d); if (s.endsWith(".png")) await fs.writeFile(d, "garbage"); };
    expect((await backup({ copyImpl: failCover })).backedUp).toEqual([]);
    const v2 = await sha256File(dest);
    await new Promise((r) => setTimeout(r, 20));
    await put(c, "02-aroll/raw.mov", "稿-raw-v3");
    expect((await backup()).backedUp).toEqual(["稿"]);
    expect(await read(dest)).toBe("稿-raw-v3");
    expect(await read(keptName(dest, v2))).toBe("稿-raw-v2");
    expect(await read(keptName(dest, v1))).toBe("稿-raw");
    const cover = path.join(nasDir(c), "05-cover/封面-3x4.png");
    expect(await read(cover)).toBe("稿-cover-v2");
    // 自己拷坏的那份当场删掉，不会被当旧版本留底
    const garbage = createHash("sha256").update("garbage").digest("hex");
    expect(await exists(keptName(cover, garbage))).toBe(false);
  });

  it("never deletes the old NAS version unless an identical kept copy is proven by hash", async () => {
    const c = await published("稿", 1);
    await backup();
    const dest = path.join(nasDir(c), "02-aroll/raw.mov");
    const v1 = await sha256File(dest);
    await fs.writeFile(keptName(dest, v1), "别的内容占了这个名");
    await new Promise((r) => setTimeout(r, 20));
    await put(c, "02-aroll/raw.mov", "稿-raw-v2");
    expect((await backup()).backedUp).toEqual(["稿"]);
    expect(await read(keptName(dest, v1))).toBe("别的内容占了这个名");
    expect(await read(keptName(dest, v1).replace(/\.mov$/, "-2.mov"))).toBe("稿-raw");
    // 留底位置已是同一内容（哈希相等）才算重复
    const v2 = await sha256File(dest);
    await fs.copyFile(dest, keptName(dest, v2));
    await new Promise((r) => setTimeout(r, 20));
    await put(c, "02-aroll/raw.mov", "稿-raw-v3");
    await backup();
    expect(await read(keptName(dest, v2))).toBe("稿-raw-v2");
    expect(await exists(keptName(dest, v2).replace(/\.mov$/, "-2.mov"))).toBe(false);
  });

  it("records project symlinks instead of creating links on the NAS", async () => {
    const c = await published("稿", 1);
    await fs.symlink("../02-aroll/raw.mov", path.join(root(c), "03-broll-link.mov"));
    const r = await backup();
    expect(r.backedUp).toEqual(["稿"]);
    expect(await exists(path.join(nasDir(c), "03-broll-link.mov"))).toBe(false);
    const note = JSON.parse(await read(path.join(nasDir(c), "符号链接清单.json")));
    expect(note.links).toEqual([{ rel: "03-broll-link.mov", target: "../02-aroll/raw.mov" }]);
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

  it("does not report backed_up for an archived project whose NAS-only files are gone", async () => {
    const old = await oldBackedUp();
    await archivePublished(data, { now: NOW, archiveRoot: nas, freeSpace: async () => 1e12, marginBytes: 0 });
    expect((await backup()).backedUp).toContain("旧稿");
    await fs.rm(nasDir(old), { recursive: true });
    const r = await backup();
    expect(r.backedUp).not.toContain("旧稿");
    const state = (await readBackupState(root(old)))!;
    expect(state.status).toBe("failed");
    expect(state.reason).toContain("02-aroll/raw.mov");
    expect(state.reason).toContain("NAS 上也不见了");
  });

  it("never writes through an old NAS dir link back into local media, so archive cannot lose unique files (Codex repro)", async () => {
    for (let i = 1; i <= 5; i++) await published(`新${i}`, i);
    const old = await published("旧稿", 8);
    await fs.rm(path.join(root(old), "03-broll"), { recursive: true, force: true });
    await fs.symlink(path.join(root(old), "02-aroll"), path.join(root(old), "03-broll"));
    await backup();
    expect(await exists(path.join(nasDir(old), "03-broll"))).toBe(false);
    // 旧版会在 NAS 上建的链接：03-broll → 本机 02-aroll
    await fs.symlink(path.join(root(old), "02-aroll"), path.join(nasDir(old), "03-broll"));
    await fs.rm(path.join(root(old), "03-broll"));
    await put(old, "03-broll/unique.mov", "独有素材");
    await backup();
    expect(await exists(path.join(root(old), "02-aroll/unique.mov"))).toBe(false);
    expect((await fs.lstat(path.join(nasDir(old), "03-broll"))).isDirectory()).toBe(true);
    expect((await fs.lstat(path.join(nasDir(old), "03-broll.link-moved-1"))).isSymbolicLink()).toBe(true);
    const r = await archivePublished(data, { now: NOW, archiveRoot: nas, freeSpace: async () => 1e12, marginBytes: 0 });
    expect(r.archived.map((a) => a.title)).toEqual(["旧稿"]);
    expect(await read(path.join(nasDir(old), "03-broll/unique.mov"))).toBe("独有素材");
    expect(await read(path.join(nasDir(old), "02-aroll/raw.mov"))).toBe("旧稿-raw");
  });

  it("moves aside a pre-existing NAS dir link pointing outside the NAS root and writes a real dir", async () => {
    const c = await published("稿", 1);
    const outside = path.join(temp, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(nasDir(c), { recursive: true });
    await fs.symlink(outside, path.join(nasDir(c), "02-aroll"));
    expect((await backup()).backedUp).toEqual(["稿"]);
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await fs.lstat(path.join(nasDir(c), "02-aroll"))).isDirectory()).toBe(true);
    expect(await read(path.join(nasDir(c), "02-aroll/raw.mov"))).toBe("稿-raw");
    expect(await fs.readlink(path.join(nasDir(c), "02-aroll.link-moved-1"))).toBe(outside);
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

describe("每周完整核对", () => {
  const later = (d: number) => new Date(NOW.getTime() + d * 86400_000);
  const WHOLE = new Date(2026, 8, 20, 10, 0, 0);
  /** NAS 副本的修改时间先对齐到整秒并让备份记下（utimes 精度不到亚毫秒），之后才能「改回原修改时间」 */
  async function pinMtime(file: string, now: Date): Promise<void> {
    await fs.utimes(file, WHOLE, WHOLE);
    await backup({ now });
  }
  /** 同样大小、改回原修改时间的静默损坏：平时的大小+修改时间检查看不出来 */
  async function rot(file: string, text: string): Promise<void> {
    await fs.writeFile(file, text);
    await fs.utimes(file, WHOLE, WHOLE);
  }

  it("skips the full re-read within 7 days, then catches a same-size same-mtime corruption and recopies", async () => {
    const c = await published("稿", 1);
    await backup();
    expect((await readBackupState(root(c)))!.lastFullVerifyAt).toBe(NOW.toISOString());
    const dest = path.join(nasDir(c), "02-aroll/raw.mov");
    await pinMtime(dest, later(1));
    await rot(dest, "稿-rax");
    expect((await backup({ now: later(3) })).backedUp).toEqual(["稿"]);
    expect(await read(dest)).toBe("稿-rax");
    expect((await readBackupState(root(c)))!.lastFullVerifyAt).toBe(NOW.toISOString());
    expect((await backup({ now: later(7) })).backedUp).toEqual(["稿"]);
    expect(await read(dest)).toBe("稿-raw");
    expect((await readBackupState(root(c)))!.lastFullVerifyAt).toBe(later(7).toISOString());
    await syncMyContentView(data, { now: later(7) });
    expect(await read(path.join(itemDir(c), "NAS备份状态.txt"))).toContain("上次完整核对：");
  });

  it("fails with the path named when the full verify finds an archived NAS-only file corrupted", async () => {
    for (let i = 1; i <= 5; i++) await published(`新${i}`, i);
    const old = await published("旧稿", 8);
    await backup();
    await archivePublished(data, { now: NOW, archiveRoot: nas, freeSpace: async () => 1e12, marginBytes: 0 });
    await rot(path.join(nasDir(old), "02-aroll/raw.mov"), "旧稿-rax");
    expect((await backup({ now: later(1) })).backedUp).toContain("旧稿");
    const r = await backup({ now: later(7) });
    expect(r.backedUp).not.toContain("旧稿");
    const state = (await readBackupState(root(old)))!;
    expect(state.status).toBe("failed");
    expect(state.reason).toContain("02-aroll/raw.mov");
    expect(state.reason).toContain("完整核对");
    expect(state.lastFullVerifyAt).toBe(NOW.toISOString());
  });

  it("says no full verify has run yet when there is none", async () => {
    const { renderBackupStatus } = await import("./nas-backup-state.js");
    expect(renderBackupStatus({ status: "unmounted", lastAttempt: NOW.toISOString(), failures: 0, target: "/x" })).toContain("还没做过完整核对");
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
