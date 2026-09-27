import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProjectLayout, resolveContentProject } from "./content-project.js";
import { saveContent, getContent, type Content, type ContentStatus } from "./local-store.js";
import { commitProjectContent } from "./project-commit.js";
import { acquireLibraryLock } from "./library-lock.js";
import { syncMyContentView, VIEW_DIR, VIEW_MANIFEST, ERROR_FILE } from "./my-content-view.js";

let release: () => void;
let temp: string, lib: string, data: string, view: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-view-test-"));
  const machine = path.join(temp, "machine");
  lib = path.join(temp, "library");
  data = path.join(lib, "workspaces/default");
  view = path.join(lib, VIEW_DIR);
  vi.stubEnv("AUTOCREW_LOCAL_DIR", machine);
  await fs.mkdir(machine, { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(machine, "storage.json"), JSON.stringify({ version: 1, id: "lib-deadbeef", root: lib }));
  await fs.writeFile(path.join(lib, "autocrew-library.json"), JSON.stringify({ version: 1, id: "lib-deadbeef" }));
  release = acquireLibraryLock(lib);
  await initializeProjectLayout(data, "lib-deadbeef", "default");
});
afterEach(async () => {
  release?.();
  vi.unstubAllEnvs();
  await fs.chmod(temp, 0o755).catch(() => {});
  await fs.rm(temp, { recursive: true, force: true });
});

const NOW = new Date(2026, 8, 27, 14, 30);
const sync = (opts = {}) => syncMyContentView(data, { now: NOW, ...opts });
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

async function make(title: string, status: ContentStatus, extra: Partial<Content> = {}): Promise<Content> {
  const c = await saveContent({ title, body: `${title} 的正文`, platform: "douyin", status: "drafting", tags: [] }, data);
  return setState(c, { status, createdAt: new Date(2026, 8, 20, 12).toISOString(), ...extra });
}
async function setState(c: Content, patch: Partial<Content>): Promise<Content> {
  const current = (await getContent(c.id, data))!;
  const next = { ...current, ...patch };
  await commitProjectContent(next, data);
  return next;
}
const root = (c: Content) => resolveContentProject(c.id, data)!.project_root;
const folder = (col: string, title: string) => path.join(view, col, `0920 ${title}`);

async function withFinal(c: Content, bytes = "video-1"): Promise<{ c: Content; file: string }> {
  const name = "final-g1-0123456789abcdef.mp4";
  const file = path.join(root(c), "07-delivery/registered", name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  await fs.mkdir(path.join(root(c), "05-cover"), { recursive: true });
  await fs.writeFile(path.join(root(c), "05-cover/封面-3x4.png"), "c34");
  await fs.writeFile(path.join(root(c), "05-cover/封面-4x3.png"), "c43");
  const video = { final: { asset_filename: name } } as unknown as Content["video"];
  const kit = { platform: "douyin", postTitle: "发布标题", caption: "发布正文", storyboard: [], coverText: "", coverPrompt: "", generatedAt: "x" };
  return { c: await setState(c, { video, videoKit: kit, hashtags: ["AI"] }), file };
}

describe("我的内容视图", () => {
  it("skips when no library is configured", async () => {
    await fs.rm(path.join(temp, "machine/storage.json"));
    const r = await syncMyContentView(undefined, { now: NOW });
    expect(r.skipped).toBeTruthy();
    expect(await exists(view)).toBe(false);
  });

  it("puts items in columns, writes the guide, and is idempotent", async () => {
    await make("写稿一", "drafting");
    await make("录制一", "approved");
    await make("公众号一", "approved", { platform: "wechat_mp" });
    const first = await sync();
    expect(first.errors).toEqual([]);
    expect(await fs.readFile(path.join(folder("写稿中", "写稿一"), "口播稿.md"), "utf8")).toBe("写稿一 的正文");
    expect(await exists(path.join(folder("待录制", "录制一"), "口播稿.md"))).toBe(true);
    expect(await exists(path.join(folder("待发布", "公众号一"), "口播稿.md"))).toBe(true);
    expect(await exists(path.join(view, "使用说明.md"))).toBe(true);
    expect((await fs.stat(path.join(folder("写稿中", "写稿一"), "口播稿.md"))).mode & 0o777).toBe(0o444);
    const second = await sync();
    expect([second.created, second.updated, second.removed]).toEqual([0, 0, 0]);
  });

  it("hard-links the final and relinks after the source is replaced", async () => {
    const { file } = await withFinal(await make("成片稿", "publish_ready"));
    await sync();
    const linked = path.join(folder("待发布", "成片稿"), "成片.mp4");
    expect((await fs.stat(linked)).ino).toBe((await fs.stat(file)).ino);
    await fs.rm(file); await fs.writeFile(file, "video-2");
    const r = await sync();
    expect(r.updated).toBeGreaterThan(0);
    expect((await fs.stat(linked)).ino).toBe((await fs.stat(file)).ino);
    expect(await exists(path.join(folder("待发布", "成片稿"), "封面-3x4.png"))).toBe(true);
    expect(await fs.readFile(path.join(folder("待发布", "成片稿"), "发布文案.md"), "utf8")).toContain("发布标题");
    expect(await exists(path.join(folder("待发布", "成片稿"), "还缺什么.txt"))).toBe(false);
  });

  it.each(["EXDEV", "ENOTSUP", "EPERM"])("falls back to a symlink on %s", async (code) => {
    const { file } = await withFinal(await make("跨盘", "publish_ready"));
    const linkImpl = async () => { throw Object.assign(new Error(code), { code }); };
    await sync({ linkImpl });
    const linked = path.join(folder("待发布", "跨盘"), "成片.mp4");
    expect(await fs.readlink(linked)).toBe(file);
    const manifest = JSON.parse(await fs.readFile(path.join(view, VIEW_MANIFEST), "utf8"));
    expect(manifest.entries["待发布/0920 跨盘/成片.mp4"]).toMatchObject({ kind: "symlink", target: file });
    const again = await sync({ linkImpl });
    expect([again.created, again.updated, again.removed]).toEqual([0, 0, 0]);
  });

  it("moves the folder on stage change and rename; keeps a folder holding foreign files", async () => {
    const c = await make("旧标题", "drafting");
    const d = await make("另一条", "drafting");
    await sync();
    await fs.writeFile(path.join(folder("写稿中", "另一条"), "我的笔记.txt"), "mine");
    await setState(c, { status: "editing", title: "新标题" });
    await setState(d, { status: "editing" });
    await sync();
    expect(await exists(folder("写稿中", "旧标题"))).toBe(false);
    expect(await exists(path.join(folder("剪辑中", "新标题"), "口播稿.md"))).toBe(true);
    expect(await fs.readFile(path.join(folder("写稿中", "另一条"), "我的笔记.txt"), "utf8")).toBe("mine");
    expect(await exists(path.join(folder("写稿中", "另一条"), "口播稿.md"))).toBe(false);
  });

  it("keeps a founder-edited script aside and writes a fresh copy", async () => {
    await make("改稿", "drafting");
    await sync();
    const file = path.join(folder("写稿中", "改稿"), "口播稿.md");
    await fs.chmod(file, 0o644); await fs.writeFile(file, "我自己改的");
    const r = await sync();
    expect(r.preservedEdits).toBe(1);
    expect(await fs.readFile(path.join(folder("写稿中", "改稿"), "口播稿（我改过的 20260927-1430）.md"), "utf8")).toBe("我自己改的");
    expect(await fs.readFile(file, "utf8")).toBe("改稿 的正文");
    const manifest = JSON.parse(await fs.readFile(path.join(view, VIEW_MANIFEST), "utf8"));
    expect(Object.keys(manifest.entries).some((k) => k.includes("我改过的"))).toBe(false);
  });

  it("shows only the newest 5 published items", async () => {
    for (let i = 1; i <= 6; i++) await make(`发布${i}`, "published", { publishedAt: `2026-09-0${i}T00:00:00.000Z` });
    await sync();
    const names = await fs.readdir(path.join(view, "已发布"));
    expect(names.sort()).toEqual(["0920 发布2", "0920 发布3", "0920 发布4", "0920 发布5", "0920 发布6"]);
  });

  it("lists missing publish copy instead of inventing it", async () => {
    await make("缺文案", "publish_ready");
    await sync();
    const dir = folder("待发布", "缺文案");
    expect(await exists(path.join(dir, "发布文案.md"))).toBe(false);
    const missing = await fs.readFile(path.join(dir, "还缺什么.txt"), "utf8");
    expect(missing).toContain("发布文案");
    expect(missing).toContain("成片");
  });

  it("publish copy prefers the publish plan's per-platform text over the video kit", async () => {
    const { c } = await withFinal(await make("有计划", "publish_ready"));
    await fs.mkdir(path.join(root(c), "06-publish"), { recursive: true });
    await fs.writeFile(path.join(root(c), "06-publish/publish-plan.json"), JSON.stringify({ platforms: [
      { platform: "douyin", title: "抖音标题", caption: "抖音正文", tags: ["AI工具"], caption_status: "submitted", scheduled_at: "2026-10-02T18:00:00+08:00" },
      { platform: "wechat_video", title: "视频号标题", caption: "视频号正文", tags: [], caption_status: "local_draft_not_submitted" },
    ] }));
    await sync();
    const copy = await fs.readFile(path.join(folder("待发布", "有计划"), "发布文案.md"), "utf8");
    expect(copy).toContain("抖音标题");
    expect(copy).toContain("#AI工具");
    expect(copy).toContain("已提交到平台");
    expect(copy).toContain("视频号正文");
    expect(copy).toContain("还没提交");
    expect(copy).not.toContain("发布标题");
  });

  it("a corrupt publish plan is reported, not silently replaced by the kit", async () => {
    const { c } = await withFinal(await make("坏计划", "publish_ready"));
    await fs.mkdir(path.join(root(c), "06-publish"), { recursive: true });
    await fs.writeFile(path.join(root(c), "06-publish/publish-plan.json"), "{坏");
    const r = await sync();
    expect(r.errors.join()).toContain("坏计划");
    expect(await fs.readFile(path.join(view, ERROR_FILE), "utf8")).toContain("坏计划");
  });

  it("one failing item does not block others; the error file clears after a clean run", async () => {
    const bad = await make("坏稿", "drafting");
    await make("好稿", "drafting");
    const current = path.join(root(bad), "01-script/manuscripts/current.md");
    await fs.rm(current); await fs.mkdir(current);
    const r = await sync();
    expect(r.errors.join()).toContain("坏稿");
    expect(await exists(path.join(folder("写稿中", "好稿"), "口播稿.md"))).toBe(true);
    expect(await fs.readFile(path.join(view, ERROR_FILE), "utf8")).toContain("坏稿");
    await fs.rmdir(current); await fs.writeFile(current, "修好了");
    const ok = await sync();
    expect(ok.errors).toEqual([]);
    expect(await exists(path.join(view, ERROR_FILE))).toBe(false);
  });

  it("剪辑中 links 成片放这里 to the project's export dir", async () => {
    const c = await make("剪辑稿", "editing");
    await sync();
    const link = path.join(folder("剪辑中", "剪辑稿"), "成片放这里");
    const target = path.join(root(c), "07-delivery/export");
    expect(await fs.readlink(link)).toBe(target);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it("sanitizes names and suffixes collisions with the id tail", async () => {
    const long = "长".repeat(50);
    await make(`［生成中］a/b:c`, "drafting");
    const x = await make("同名", "drafting");
    const y = await make("同名", "drafting", { createdAt: new Date(2026, 8, 20, 13).toISOString() });
    await make(long, "drafting");
    await sync();
    const names = await fs.readdir(path.join(view, "写稿中"));
    expect(names).toContain("0920 abc");
    expect(names).toContain(`0920 ${"长".repeat(40)}`);
    expect(names).toContain("0920 同名");
    expect(names).toContain(`0920 同名 ${y.id.slice(-6)}`);
    expect(x.id).not.toBe(y.id);
  });

  it("hides other library entries on macOS", async () => {
    if (process.platform !== "darwin") return;
    await sync();
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("ls", ["-lO", lib], { encoding: "utf8" });
    const line = (name: string) => out.split("\n").find((l) => l.endsWith(` ${name}`)) ?? "";
    expect(line("workspaces")).toContain("hidden");
    expect(line(VIEW_DIR)).not.toContain("hidden");
  });
});
