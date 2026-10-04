import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProjectLayout, resolveContentProject } from "./content-project.js";
import { saveContent, getContent, type Content, type ContentStatus } from "./local-store.js";
import { commitProjectContent } from "./project-commit.js";
import { acquireLibraryLock } from "./library-lock.js";
import { syncMyContentView, VIEW_DIR, VIEW_MANIFEST, ERROR_FILE } from "./my-content-view.js";
import { listDiffs } from "../modules/learnings/diff-tracker.js";
import { writePack, type WritingPackFile } from "../tools/writer-pack.js";
import { HUMAN_WRITE } from "./first-body-guard.js";

let release: () => void;
let temp: string, lib: string, data: string, view: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-view-back-"));
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
  await fs.rm(temp, { recursive: true, force: true });
});

const NOW = new Date(2026, 8, 27, 14, 30);
const sync = () => syncMyContentView(data, { now: NOW });
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
const COLS = ["写稿中", "待录制", "剪辑中", "待发布", "已发布", "复盘"];
const colDir = (col: string) => `${COLS.indexOf(col) + 1} ${col}`;
const folder = (col: string, title: string) => path.join(view, colDir(col), `0920 ${title}`);
const root = (c: Content) => resolveContentProject(c.id, data)!.project_root;
const founderDiffs = async (c: Content) => (await listDiffs({ contentId: c.id }, data)).filter((d) => d.changeType === "创始人在「我的内容」里改稿");

async function make(title: string, status: ContentStatus, extra: Partial<Content> = {}): Promise<Content> {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title, body: `${title} 的正文`, platform: "douyin", status: "drafting", tags: [] }, data);
  return setState(c, { status, createdAt: new Date(2026, 8, 20, 12).toISOString(), ...extra });
}
async function setState(c: Content, patch: Partial<Content>): Promise<Content> {
  const next = { ...(await getContent(c.id, data))!, ...patch };
  await commitProjectContent(next, data);
  return next;
}
async function edit(col: string, title: string, text: string): Promise<string> {
  const file = path.join(folder(col, title), "口播稿.md");
  await fs.chmod(file, 0o644);
  await fs.writeFile(file, text);
  return file;
}

/** 没写回：稿子原样、改稿另存、出错文件说清原因、不记差异 */
async function expectKeptAside(c: Content, col: string, text: string, reason: string): Promise<void> {
  expect((await getContent(c.id, data))!.body).toBe(`${c.title} 的正文`);
  const aside = path.join(folder(col, c.title), "口播稿（我改过的 20260927-1430）.md");
  expect(await fs.readFile(aside, "utf8")).toBe(text);
  const err = await fs.readFile(path.join(view, ERROR_FILE), "utf8");
  expect(err).toContain("没有同步回 AutoCrew");
  expect(err).toContain(reason);
  expect(await founderDiffs(c)).toEqual([]);
}

describe("我的内容 · 改稿回流", () => {
  it.each([["drafting", "写稿中"], ["draft_ready", "写稿中"], ["approved", "待录制"]] as const)("%s：改稿存成新版本并记差异，视图同一轮刷新，下一轮无变化", async (status, col) => {
    const c = await make("回流", status);
    await sync();
    const file = await edit(col, "回流", "创始人改过的口播\n");
    const r = await sync();
    expect(r.errors).toEqual([]);
    const after = (await getContent(c.id, data))!;
    expect(after.body).toBe("创始人改过的口播\n");
    expect(after.versions?.at(-1)?.note).toBe("创始人在「我的内容」里改稿");
    const diffs = await founderDiffs(c);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ field: "body", before: "回流 的正文", after: "创始人改过的口播\n", platform: "douyin" });
    expect(await fs.readFile(file, "utf8")).toBe("创始人改过的口播\n");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
    expect((await fs.readdir(folder(col, "回流"))).filter((n) => n.includes("我改过的"))).toEqual([]);
    expect(await exists(path.join(view, ERROR_FILE))).toBe(false);
    const again = await sync();
    expect([again.created, again.updated, again.removed, again.preservedEdits]).toEqual([0, 0, 0, 0]);
    expect(await founderDiffs(c)).toHaveLength(1);
  });

  it("可回流栏目的口播稿可写，其它栏目的副本只读", async () => {
    await make("可写", "approved");
    await make("只读", "publish_ready");
    await sync();
    const mode = async (col: string, title: string) => (await fs.stat(path.join(folder(col, title), "口播稿.md"))).mode & 0o777;
    expect(await mode("待录制", "可写")).toBe(0o644);
    expect(await mode("待发布", "只读")).toBe(0o444);
  });

  it("AI 会话认领着这篇：不写回", async () => {
    const c = await make("认领中", "drafting");
    await sync();
    const now = Date.now();
    await setState(c, { claim: { employee: "writer", host: "claude-code", token: "clm-1-x", at: new Date(now).toISOString(), leaseUntil: new Date(now + 30 * 60_000).toISOString() } });
    await edit("写稿中", "认领中", "改了");
    await sync();
    await expectKeptAside(c, "写稿中", "改了", "正在处理这篇稿");
  });

  it("写作包还在备料：不写回", async () => {
    const c = await make("备料中", "drafting");
    await sync();
    await writePack(c.id, { packId: "pack-1", issuedAt: new Date().toISOString(), state: "preparing", host: "claude-code" } as unknown as WritingPackFile, data);
    await edit("写稿中", "备料中", "改了");
    await sync();
    await expectKeptAside(c, "写稿中", "改了", "写作包正在备料");
  });

  it("改成空白：按误操作，不写回", async () => {
    const c = await make("清空", "drafting");
    await sync();
    await edit("写稿中", "清空", "  \n\t\n");
    await sync();
    await expectKeptAside(c, "写稿中", "  \n\t\n", "空的");
  });

  it("改完之后稿子已交剪辑：不写回，改稿留在原文件夹", async () => {
    const c = await make("已交接", "approved");
    await sync();
    await edit("待录制", "已交接", "改了");
    await setState(c, { status: "editing" });
    await sync();
    await expectKeptAside(c, "待录制", "改了", "定稿锁定");
    expect(await fs.readFile(path.join(folder("剪辑中", "已交接"), "口播稿.md"), "utf8")).toBe("已交接 的正文");
  });

  it("改的同时 AI 也更新了稿子：不覆盖 AI 的新版本", async () => {
    const c = await make("并发", "drafting");
    await sync();
    await edit("写稿中", "并发", "我的版本");
    await setState(c, { body: "并发 的正文" });
    await fs.writeFile(path.join(root(c), "01-script/manuscripts/current.md"), "AI 的新版本");
    await sync();
    const err = await fs.readFile(path.join(view, ERROR_FILE), "utf8");
    expect(err).toContain("被 AI 更新了");
    expect(await founderDiffs(c)).toEqual([]);
  });
});

describe("我的内容 · 实拍版", () => {
  async function registered(title: string, finalScript: string, spoken: string | null): Promise<Content> {
    const c = await make(title, "publish_ready");
    const r = root(c);
    await fs.mkdir(path.join(r, "01-script/handoff/g0001"), { recursive: true });
    await fs.writeFile(path.join(r, "01-script/handoff/g0001/final-script.md"), finalScript);
    if (spoken !== null) {
      await fs.mkdir(path.join(r, "01-script/spoken"), { recursive: true });
      await fs.writeFile(path.join(r, "01-script/spoken/g0001-spoken.md"), spoken);
    }
    return setState(c, { video: { handoff: { generation: 1 }, final: { generation: 1, asset_filename: "none.mp4" } } as unknown as Content["video"] });
  }

  it("有实拍版就放只读副本，并列出新说的数字和出处", async () => {
    await registered("实拍", "省下两小时。第一步交出去。", "省下两小时，据麦肯锡报告能省 30%。第一步交出去，一年省 5 万。\n");
    await sync();
    const dir = folder("待发布", "实拍");
    expect(await fs.readFile(path.join(dir, "口播稿-实拍版.md"), "utf8")).toContain("麦肯锡");
    expect((await fs.stat(path.join(dir, "口播稿-实拍版.md"))).mode & 0o777).toBe(0o444);
    const check = await fs.readFile(path.join(dir, "发布前核对.txt"), "utf8");
    expect(check).toContain("实拍时新说的数字和出处，还没核验，发布前看一眼");
    expect(check).toContain("30%");
    expect(check).toContain("5万");
    expect(check).toContain("据麦肯锡报告能省 30%");
    expect(check).not.toContain("两小时");
  });

  it("实拍没有新数字、新出处就没有核对单；没登记实拍版就都不出现", async () => {
    await registered("照稿", "省下 2 小时。", "省下 2 小时。\n");
    await registered("没字幕", "省下 2 小时。", null);
    await sync();
    expect(await exists(path.join(folder("待发布", "照稿"), "口播稿-实拍版.md"))).toBe(true);
    expect(await exists(path.join(folder("待发布", "照稿"), "发布前核对.txt"))).toBe(false);
    expect(await exists(path.join(folder("待发布", "没字幕"), "口播稿-实拍版.md"))).toBe(false);
  });
});

describe("我的内容 · 栏目编号迁移", () => {
  it("旧的无编号栏目：条目挪到编号栏目，空的旧栏目删掉，留着创始人文件的旧栏目保留", async () => {
    const c = await make("迁移", "drafting");
    await sync();
    // 伪造旧命名的视图：把编号目录改回旧名，清单也换成旧名
    const manifestFile = path.join(view, VIEW_MANIFEST);
    const raw = await fs.readFile(manifestFile, "utf8");
    for (const col of COLS) await fs.rename(path.join(view, colDir(col)), path.join(view, col));
    await fs.writeFile(manifestFile, COLS.reduce((s, col) => s.split(`"${colDir(col)}`).join(`"${col}`), raw));
    await fs.writeFile(path.join(view, "待发布", "我的笔记.txt"), "mine");
    const r = await sync();
    expect(r.errors).toEqual([]);
    expect(await fs.readFile(path.join(folder("写稿中", "迁移"), "口播稿.md"), "utf8")).toBe(`${c.title} 的正文`);
    expect(await exists(path.join(view, "写稿中"))).toBe(false);
    expect(await exists(path.join(view, "复盘"))).toBe(false);
    expect(await fs.readFile(path.join(view, "待发布", "我的笔记.txt"), "utf8")).toBe("mine");
    const names = (await fs.readdir(view)).filter((n) => !n.startsWith("."));
    expect(names.sort()).toEqual([...COLS.map(colDir), "使用说明.md", "待发布"].sort());
  });
});
