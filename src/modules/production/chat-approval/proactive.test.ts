/**
 * 主动把要拍板的事带进对话（spec 2026-10-06 proactive-chat-review）：E1–E7 逐条验收。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc } from "../../../storage/production-store.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { executeStatus } from "../../../tools/status.js";
import { readInbox } from "../inbox-read.js";
import { transcriptCacheDir } from "../match/cache.js";
import { CLIP_SECONDS } from "../match/l2.js";
import { founderApprove, makeEnv, png, projectRoot, put, record, videoContent, waiveSliverCheck, type Env } from "../testkit.js";
import { previewFolder, setPreviewDeps, sweepPreview } from "./preview.js";
import { NO_CHANGE_NOTE, NO_COVER_TEXT } from "./brief.js";

let env: Env;
let pane: string;
let opened: Array<{ file: string; app: string }>;
beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  setPullDeps({ benchPort: 4317 });
  pane = path.join(env.dir, "..", "session");
  await fs.mkdir(pane, { recursive: true });
  opened = [];
  setPreviewDeps({ open: async (file, app) => { opened.push({ file, app }); } });
});
afterEach(async () => { setPreviewDeps(null); setPullDeps(null); await env.cleanup(); });

const TITLE = "主动拍板测试";
type Item = { item_id: string; gen: string; type: string; brief: string; number?: number; shown: Record<string, string>; preview?: { files: Array<{ name: string; path: string }>; opened: Array<{ reason: string; app: string }>; problems: string[] } };
const list = async (p: Record<string, unknown> = {}) => (await executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "s1", action: "list", ...p })).items as Item[];
const byType = async (t: string, p: Record<string, unknown> = {}) => (await list(p)).find((i) => i.type === t)!;
const img = (n: string, w: number, h: number) => put(path.join(env.chatcut, n), png(w, h, n));

async function editing() {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${TITLE}-原片.mov`), "raw"), request_id: "a" });
  return c;
}
const coverGroup = async (id: string, tag: string, text = "大字") =>
  record(env, { content_id: id, kind: "cover", paths: [await img(`${tag}-34.png`, 900, 1200), await img(`${tag}-43.png`, 1200, 900)], cover_text: text, request_id: `g-${tag}` });
async function cut(id: string, tag = "v1", extra: Record<string, unknown> = {}) {
  const file = await put(path.join(env.chatcut, `${TITLE}-${tag}.mp4`), `cut-${tag}`);
  const r = await record(env, { content_id: id, kind: "cut", path: file, request_id: `cut-${tag}`, review: true, ...extra });
  const f = (await readProductionDoc(id, env.dir))!.facts.find((x) => x.id === r.fact_id)!;
  await waiveSliverCheck(env, id, f.sha256!);
  return { fact_id: String(r.fact_id), sha: f.sha256!, file: path.isAbsolute(f.path!) ? f.path! : path.join(projectRoot(env, id), f.path!) };
}

describe("E1 会话开场", () => {
  it("没有要拍板的事 → 开场那行不提；有了才叫 agent 第一句回复列出来", async () => {
    const empty = await executeStatus({ brief: true, _dataDir: env.dir, _chatcutExportDir: path.join(env.dir, "no-chatcut") });
    expect(empty).not.toHaveProperty("review");
    const c = await editing();
    await coverGroup(c.id, "a");
    const r = await executeStatus({ brief: true, _dataDir: env.dir, _chatcutExportDir: path.join(env.dir, "no-chatcut") });
    expect(String(r.review)).toMatch(/有 1 件.*autocrew_review_inbox\{action:"list", preview_dir/);
  });
});

describe("E6 brief 由服务端写", () => {
  it("封面：封面字、判断什么、两个比例的文件、回复提示；没字 → 没写封面字", async () => {
    const c = await editing();
    await coverGroup(c.id, "a", "三个字");
    const b = (await byType("cover_pick")).brief;
    expect(b).toContain("封面字：「三个字」");
    expect(b).toContain("大字是不是一眼就能看清；你本人看着自不自然");
    expect(b).toMatch(/文件：3:4 \S+\.png、4:3 \S+\.png/);
    expect(b).toContain("回我「用」/「还要改：……」");
    await coverGroup(c.id, "b", "");
    expect((await byType("cover_pick")).brief).toContain(`封面字：${NO_COVER_TEXT}`);
  });

  it("成片：第几版、时长、改了什么（登记备注 > 执行汇报 > 没写改了什么）、看片提醒", async () => {
    const c = await editing();
    await cut(c.id, "v1");
    let b = (await byType("cut_review")).brief;
    expect(b).toMatch(/第 1 版（最新一版，12 秒）/);
    expect(b).toContain(`这版改了什么：${NO_CHANGE_NOTE}`);
    expect(b).toContain("留意剪错的地方、卡顿、字幕错字");
    const v2 = await cut(c.id, "v2");
    const dir = path.join(projectRoot(env, c.id), "00-project/notes/execution-reports");
    await put(path.join(dir, "r1.json"), JSON.stringify({ files: [{ sha256: v2.sha }], result: "删掉了开头 3 秒的停顿", recorded_at: "2026-10-06T00:00:00Z" }));
    expect((await byType("cut_review")).brief).toContain("这版改了什么：删掉了开头 3 秒的停顿");
    await cut(c.id, "v3", { note: "字幕错字改了" });
    b = (await byType("cut_review")).brief;
    expect(b).toContain("这版改了什么：字幕错字改了");
    expect(b).toMatch(/第 3 版.*还有 2 版/);
  });

  it("候选原片：只读已有转写的第一句，没有就不说、也不去转写", async () => {
    const c = await editing();
    const src = await put(path.join(env.outside, "别处.mov"), "cand-raw");
    await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "cand" });
    const cand = await byType("candidate");
    expect(cand.brief).toContain("要你判断：这是不是这条稿的原片？");
    expect(cand.brief).not.toContain("开头一句");
    const fact = (await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.path === src || f.source_path === src)!;
    expect(await fs.readdir(transcriptCacheDir(env.dir)).catch(() => [])).toEqual([]);
    // 停用前留下的旧转写缓存（手动收件之后不再写，只读）
    await fs.mkdir(transcriptCacheDir(env.dir), { recursive: true });
    await fs.writeFile(path.join(transcriptCacheDir(env.dir), `${fact.sha256}.json`), JSON.stringify({ sha256: fact.sha256, text: "大家好今天聊封面。后面的话不该出现。", clip_seconds: CLIP_SECONDS, at: new Date().toISOString() }));
    expect((await byType("candidate")).brief).toContain("开头一句：「大家好今天聊封面。」");
  });

  it("不止一件 → 编号", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    await cut(c.id);
    const items = (await list()).filter((i) => i.brief);
    expect(items.map((i) => i.number)).toEqual([1, 2]);
    expect(items[0].brief.startsWith("1. ")).toBe(true);
  });
});

describe("E2 多组 / 多版只放最新", () => {
  it("只放最新一组，其余给数量；点名旧的一组就放那一组", async () => {
    const c = await editing();
    const a = await coverGroup(c.id, "a");
    await coverGroup(c.id, "b");
    const it0 = await byType("cover_pick", { preview_dir: pane });
    expect(it0.brief).toContain("最新一组（还有 1 组）");
    const latest = it0.preview!.files.map((f) => f.path);
    expect(latest).toHaveLength(2);
    for (const p of latest) expect(p.startsWith(`review-preview/${TITLE}-`)).toBe(true);
    expect(await fs.readFile(path.join(pane, it0.preview!.files[0].path))).toBeTruthy();
    const old = await byType("cover_pick", { preview_dir: pane, item_id: it0.item_id, group_id: a.group_id });
    expect(old.brief).toContain("上一组");
    expect(old.shown.group_id).toBe(a.group_id);
    expect(old.preview!.files.map((f) => f.path)).not.toEqual(latest);
    const bytes = await fs.readFile(path.join(pane, old.preview!.files[0].path));
    expect(bytes.equals(png(900, 1200, "a-34.png"))).toBe(true);
  });

  it("成片硬链接进会话文件夹，不另占空间", async () => {
    const c = await editing();
    const k = await cut(c.id);
    const it0 = await byType("cut_review", { preview_dir: pane });
    const dest = path.join(pane, it0.preview!.files[0].path);
    expect((await fs.stat(dest)).ino).toBe((await fs.stat(k.file)).ino);
  });
});

describe("E3 放不进去 → 说原因并打开", () => {
  it("跨盘硬链接失败 → QuickTime 打开并说明；preview_dir 不对 → 预览打开并说明；打开也失败 → problems", async () => {
    const c = await editing();
    await cut(c.id);
    setPreviewDeps({ open: async (file, app) => { opened.push({ file, app }); }, link: async () => { throw Object.assign(new Error("x"), { code: "EXDEV" }); } });
    const v = await byType("cut_review", { preview_dir: pane });
    expect(v.preview!.files).toEqual([]);
    expect(v.preview!.opened[0]).toMatchObject({ app: "QuickTime Player" });
    expect(v.preview!.opened[0].reason).toContain("不在同一块盘上");
    await coverGroup(c.id, "a");
    const cv = await byType("cover_pick", { preview_dir: "relative/dir" });
    expect(cv.preview!.opened).toHaveLength(2);
    expect(cv.preview!.opened[0].reason).toContain("绝对路径");
    setPreviewDeps({ open: async () => { throw new Error("没有这个 App"); } });
    const bad = await byType("cover_pick", { preview_dir: path.join(pane, "nope") });
    expect(bad.preview!.problems[0]).toContain("也没能打开");
  });
});

describe("E4 看过之后文件被换 → 拒并重给", () => {
  it("预览后成片被覆盖 → file_changed，什么都没记，带新的 item", async () => {
    const c = await editing();
    const k = await cut(c.id);
    const it0 = await byType("cut_review", { preview_dir: pane });
    await fs.writeFile(k.file, "被换掉的字节");
    const r = await executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "s1", action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "approve_cut", founder_words: "用", request_id: "e4", preview_dir: pane });
    expect(r).toMatchObject({ ok: false, code: "file_changed", item: { item_id: it0.item_id } });
    expect((await readProductionDoc(c.id, env.dir))!.decisions.filter((d) => d.type === "cut_approval")).toHaveLength(0);
  });
});

describe("E5 清理只碰 review-preview/", () => {
  it("定掉的事的预览删掉；7 天以上的删掉；review-preview 外面的不碰", async () => {
    const c = await editing();
    const g = await coverGroup(c.id, "a");
    const it0 = await byType("cover_pick", { preview_dir: pane });
    const stray = path.join(pane, "review-preview", "旧的", "old.png");
    await put(stray, "old");
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await fs.utimes(stray, old, old);
    const mine = await put(path.join(pane, "我的笔记.png"), "keep");
    await fs.utimes(mine, old, old);
    const r = await executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "s1", action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "pick_cover", group_id: g.group_id, founder_words: "用", request_id: "e5", preview_dir: pane });
    expect(r).toMatchObject({ ok: true });
    for (const f of it0.preview!.files) await expect(fs.access(path.join(pane, f.path))).rejects.toThrow();
    await expect(fs.access(stray)).rejects.toThrow();
    await fs.access(mine);
  });

  it("review-preview 是符号链接 → 不往里放也不清", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    const elsewhere = path.join(env.outside, "target");
    await put(path.join(elsewhere, "别人的.png"), "x");
    await fs.symlink(elsewhere, path.join(pane, "review-preview"));
    const it0 = await byType("cover_pick", { preview_dir: pane });
    expect(it0.preview!.files).toEqual([]);
    expect(it0.preview!.opened[0].reason).toContain("不是普通文件夹");
    await fs.access(path.join(elsewhere, "别人的.png"));
  });
});

describe("E7 网页「等你拍板」不变", () => {
  it("带 preview_dir 的 list 不改看板读到的条目", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    await cut(c.id);
    const { generated_at: _a, ...before } = await readInbox(env.dir);
    await list({ preview_dir: pane });
    const { generated_at: _b, ...after } = await readInbox(env.dir);
    expect(after).toEqual(before);
  });
});

describe("Codex 审 d2f3c63c", () => {
  const decideCut = (it0: Item, extra: Record<string, unknown> = {}) => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "s1", action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "approve_cut", founder_words: "用", request_id: `d-${Date.now()}`, ...extra });

  it("P1 标题文件夹被换成指向外面的链接 → 不删不写外面的文件，说原因", async () => {
    const c = await editing();
    await cut(c.id);
    const first = await byType("cut_review", { preview_dir: pane });
    const rel = first.preview!.files[0].path;
    const folder = path.join(pane, path.dirname(rel));
    expect(path.basename(folder)).toBe(previewFolder(TITLE, { content_id: c.id, item_id: first.item_id }));
    const outside = path.join(env.outside, "victim");
    await put(path.join(outside, path.basename(rel)), "别人的东西");
    await fs.rm(folder, { recursive: true });
    await fs.symlink(outside, folder);
    const again = await byType("cut_review", { preview_dir: pane });
    expect(again.preview!.files).toEqual([]);
    expect(again.preview!.opened[0].reason).toContain("不是普通文件夹");
    expect(await fs.readFile(path.join(outside, path.basename(rel)), "utf8")).toBe("别人的东西");
  });

  it("P1 .index.json 是指向外面的链接 → 不写穿；清理失败进 warnings（list 和 decide 都有），决定照样记下", async () => {
    const c = await editing();
    await cut(c.id);
    await fs.mkdir(path.join(pane, "review-preview"));
    const victim = await put(path.join(env.outside, "victim.json"), "原样");
    await fs.symlink(victim, path.join(pane, "review-preview", ".index.json"));
    const r = await executeReviewInbox({ _dataDir: env.dir, action: "list", preview_dir: pane });
    expect(String((r.warnings as string[])[0])).toContain("旧预览没清掉");
    const it0 = (r.items as Item[]).find((i) => i.type === "cut_review")!;
    expect(it0.preview!.files).toEqual([]);
    const d = await decideCut(it0, { preview_dir: pane });
    expect(d, JSON.stringify(d)).toMatchObject({ ok: true });
    expect((d.warnings as string[]).length).toBe(1);
    expect(await fs.readFile(victim, "utf8")).toBe("原样");
  });

  it("P2 标题前 20 字相同的两条稿 → 各自的文件夹", async () => {
    const same = "这是一个非常非常长的标题前二十个字完全相同";
    const dirs: string[] = [];
    for (const [n, tail] of ["甲", "乙"].entries()) {
      const c = await videoContent(env, `${same}${tail}`);
      await founderApprove(env, c.id);
      const g = await record(env, { content_id: c.id, kind: "cover", paths: [await img(`${tail}-34.png`, 900, 1200), await img(`${tail}-43.png`, 1200, 900)], cover_text: "字", request_id: `g-same-${n}` });
      expect(g.ok, JSON.stringify(g)).toBe(true);
    }
    for (const i of (await list({ preview_dir: pane })).filter((x) => x.type === "cover_pick")) dirs.push(path.dirname(i.preview!.files[0].path));
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
  });

  it("P2 点名的组 / 版对不上 → stale_selector + 现在的 item，不拿别的顶替", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    await cut(c.id);
    const cv = await byType("cover_pick");
    const r1 = await executeReviewInbox({ _dataDir: env.dir, action: "list", item_id: cv.item_id, group_id: "grp-gone", preview_dir: pane });
    expect(r1).toMatchObject({ ok: false, code: "stale_selector", item: { item_id: cv.item_id } });
    const ct = await byType("cut_review");
    const r2 = await executeReviewInbox({ _dataDir: env.dir, action: "list", item_id: ct.item_id, fact_id: "fact-gone" });
    expect(r2).toMatchObject({ ok: false, code: "stale_selector", item: { item_id: ct.item_id } });
  });
});

describe("Codex 复审 7d0b8b6d", () => {
  it("标题文件夹读不了 → 清理的原因进 warnings，不当成空的", async () => {
    const c = await editing();
    await cut(c.id);
    const locked = path.join(pane, "review-preview", "锁住的");
    await put(path.join(locked, "x.png"), "x");
    await fs.chmod(locked, 0o000);
    try {
      const r = await executeReviewInbox({ _dataDir: env.dir, action: "list", preview_dir: pane });
      expect((r.warnings as string[]).some((w) => w.includes("锁住的"))).toBe(true);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it("放文件独占创建：撞上 EEXIST → 报问题，不覆盖", async () => {
    const c = await editing();
    await coverGroup(c.id, "a");
    setPreviewDeps({ open: async (file, app) => { opened.push({ file, app }); }, copy: async () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); } });
    const it0 = await byType("cover_pick", { preview_dir: pane });
    expect(it0.preview!.files).toEqual([]);
    expect(it0.preview!.opened[0].reason).toContain("没覆盖");
  });
});

describe("Codex 复审 3958bb1a", () => {
  it("文件读不了（EACCES）时留着预览记录，权限恢复后还能按记录清", async () => {
    const c = await editing();
    await cut(c.id);
    await executeReviewInbox({ _dataDir: env.dir, action: "list", preview_dir: pane });
    const root = path.join(pane, "review-preview");
    const before = JSON.parse(await fs.readFile(path.join(root, ".index.json"), "utf8")) as { files: Record<string, unknown> };
    const rels = Object.keys(before.files);
    expect(rels.length).toBeGreaterThan(0);
    const dir = path.join(root, rels[0].split("/")[0]);
    await fs.chmod(dir, 0o000);
    try {
      await sweepPreview(pane, () => true);
    } finally {
      await fs.chmod(dir, 0o755);
    }
    const after = JSON.parse(await fs.readFile(path.join(root, ".index.json"), "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(after.files)).toEqual(expect.arrayContaining(rels));
  });

  it("review-preview 读不了（不是 ENOENT）→ 报进 errors，不当成没东西", async () => {
    await fs.mkdir(path.join(pane, "review-preview"), { recursive: true });
    await fs.chmod(pane, 0o600);
    try {
      const r = await sweepPreview(pane, () => true);
      expect(r.errors.some((e) => e.includes("review-preview"))).toBe(true);
    } finally {
      await fs.chmod(pane, 0o755);
    }
    expect((await sweepPreview(path.join(pane, "nope"), () => true)).errors.length).toBeGreaterThan(0);
  });
});
