/**
 * 手动收件验收（spec 2026-10-06）：对话里列收件箱、把点名的文件挂到点名的稿；对不上唯一一个 → 拒并给候选；
 * 列出之后换过字节 → 拒；ChatCut 按路径在用的照旧原地收；「同步一下」单飞；巡检启动一次 + 30 分钟；旧数据照常读。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardData } from "../../desktop/board-data.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { executeReviewInbox } from "../../tools/review-inbox.js";
import { cardPanel } from "./panel.js";
import { readInbox } from "./inbox-read.js";
import { reportFile } from "./reconcile.js";
import { mutateProduction, ensureProductionReady, resetProductionReady } from "./service.js";
import { withFileOwnership } from "./mutex.js";
import { cachedSha } from "./observe.js";
import { PENDING_RETIRED } from "./legacy-discovery.js";
import { forgetShaIndex } from "./sha-index.js";
import { runSweep, setSweepRunner, startSweepLoop, SWEEP_INTERVAL_MS, type SweepResult } from "./sweep.js";
import { setChatcutDeps } from "./sliver/chatcut-read.js";
import { exists, founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
let cc: string;
beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  cc = path.join(path.dirname(env.dir), "chatcut-projects");
  setChatcutDeps({ projectsRoot: () => cc });
});
afterEach(async () => { setSweepRunner(null); setChatcutDeps(null); await env.cleanup(); });

const tool = (p: Record<string, unknown>) => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "s-intake", ...p });
type Listed = { files: Array<{ name: string; path: string; sha256: string; used_by?: { content_id: string } }>; contents: Array<{ id: string; title: string }> };
const list = async () => (await tool({ action: "inbox_list" })) as unknown as Listed & { ok: boolean };
const arolls = async (id: string) => (await readProductionDocOrEmpty(id, env.dir)).facts.filter((f) => f.kind === "aroll");

async function approved(title: string) {
  const c = await videoContent(env, title);
  await founderApprove(env, c.id);
  return c;
}

describe("inbox_list", () => {
  it("列收件箱顶层视频（带 sha256、已挂在哪条）和能挂的稿；子目录、隐藏文件、非视频不列；什么都不写", async () => {
    const c = await approved("列收件箱的稿");
    await put(path.join(env.inbox, "IMG_0001.mov"), "take-1");
    await put(path.join(env.inbox, ".DS_Store"), "x");
    await put(path.join(env.inbox, "notes.txt"), "x");
    await put(path.join(env.inbox, "sub", "IMG_9.mov"), "deep");
    const r = await list();
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.name)).toEqual(["IMG_0001.mov"]);
    expect(r.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r.contents).toEqual(expect.arrayContaining([expect.objectContaining({ id: c.id, title: "列收件箱的稿" })]));
    expect(await arolls(c.id)).toEqual([]);
  });
});

describe("inbox_attach", () => {
  it("把点名的文件挂到点名的稿：挪进项目、记原话来源 chat；同一 request_id 重发 = 回放", async () => {
    const c = await approved("对话挂原片的稿");
    const src = await put(path.join(env.inbox, "IMG_0002.mov"), "take-2");
    const f = (await list()).files[0];
    const req = { action: "inbox_attach", file: "IMG_0002.mov", sha256: f.sha256, content_id: c.id, founder_words: "原片放进去了，是对话挂原片那条", request_id: "intake-1" };
    const r = await tool(req);
    expect(r).toMatchObject({ ok: true, state: "accepted", content_id: c.id, recorded_as: "chat" });
    expect(await exists(src)).toBe(false);
    expect(String(r.path)).toMatch(/^02-aroll\//);
    expect(await exists(path.join(projectRoot(env, c.id), String(r.path)))).toBe(true);
    const doc = await readProductionDocOrEmpty(c.id, env.dir);
    expect(doc.decisions.find((d) => d.type === "candidate_confirm")).toMatchObject({ source: "chat", founder_words: "原片放进去了，是对话挂原片那条", request_id: "intake-1" });
    expect(await tool(req)).toMatchObject({ ok: true, replayed: true });
    expect((await arolls(c.id)).filter((x) => x.state === "accepted")).toHaveLength(1);
  });

  it("稿也可以按完整标题点名；标题对不上唯一一条 → ambiguous_content 带候选，什么都不挂", async () => {
    const a = await approved("AI 工具第一条");
    await approved("AI 工具第二条");
    await put(path.join(env.inbox, "IMG_0003.mov"), "take-3");
    const sha = (await list()).files[0].sha256;
    const amb = await tool({ action: "inbox_attach", file: "IMG_0003.mov", sha256: sha, content_id: "AI 工具", founder_words: "是 AI 工具那条", request_id: "intake-2" });
    expect(amb).toMatchObject({ ok: false, code: "ambiguous_content" });
    expect((amb.candidates as Array<{ title: string }>).map((x) => x.title).sort()).toEqual(["AI 工具第一条", "AI 工具第二条"]);
    expect(await arolls(a.id)).toEqual([]);
    expect(await tool({ action: "inbox_attach", file: "IMG_0003.mov", sha256: sha, content_id: "AI 工具第一条", founder_words: "第一条", request_id: "intake-3" })).toMatchObject({ ok: true, content_id: a.id });
  });

  it("文件对不上唯一一个 → ambiguous_file 带候选，什么都不挂", async () => {
    const c = await approved("文件有歧义的稿");
    await put(path.join(env.inbox, "IMG_1.mov"), "one");
    await put(path.join(env.inbox, "IMG_10.mov"), "ten");
    const sha = (await list()).files[0].sha256;
    const r = await tool({ action: "inbox_attach", file: "IMG_1", sha256: sha, content_id: c.id, founder_words: "IMG_1 那个", request_id: "intake-4" });
    expect(r).toMatchObject({ ok: false, code: "ambiguous_file" });
    expect((r.candidates as Array<{ name: string }>).map((x) => x.name)).toEqual(["IMG_1.mov", "IMG_10.mov"]);
    expect(await arolls(c.id)).toEqual([]);
  });

  it("列出之后文件换过（同名）→ file_changed，什么都不挂、文件不动", async () => {
    const c = await approved("文件换过的稿");
    const src = await put(path.join(env.inbox, "IMG_0005.mov"), "bytes-one");
    const old = (await list()).files[0].sha256;
    await put(src, "bytes-two");
    const r = await tool({ action: "inbox_attach", file: "IMG_0005.mov", sha256: old, content_id: c.id, founder_words: "是这条", request_id: "intake-5" });
    expect(r).toMatchObject({ ok: false, code: "file_changed" });
    expect(await arolls(c.id)).toEqual([]);
    expect(await fs.readFile(src, "utf8")).toBe("bytes-two");
  });

  it("ChatCut 工程按路径在用收件箱这份：照旧原地收下、不挪，依据写出工程名", async () => {
    const c = await approved("ChatCut在用的对话挂载稿");
    const src = await put(path.join(env.inbox, "IMG_0006.mov"), "in-use");
    const dir = path.join(cc, "p1", "project.chatcutproject");
    await fs.mkdir(path.join(dir, "assets", "video"), { recursive: true });
    await fs.writeFile(path.join(dir, "project.json"), JSON.stringify({ name: "在剪的工程", projectId: "p1", schemaVersion: 4 }));
    await fs.writeFile(path.join(dir, "assets", "video", "a0.json"), JSON.stringify({ id: "a0", type: "video", path: src }));
    const sha = (await list()).files[0].sha256;
    expect(await tool({ action: "inbox_attach", file: "IMG_0006.mov", sha256: sha, content_id: c.id, founder_words: "是这条", request_id: "intake-6" })).toMatchObject({ ok: true, state: "accepted" });
    expect(await exists(src)).toBe(true);
    expect((await arolls(c.id))[0]).toMatchObject({ state: "accepted", path: src, evidence: expect.stringContaining("在剪的工程") });
    // 已挂上的文件在列表里标出挂在哪条
    expect((await list()).files[0].used_by).toMatchObject({ content_id: c.id });
  });

  it("文件名更像别条 → looks_like_other 先问；创始人确认后换 request_id 带 confirm_other 才挂", async () => {
    const a = await approved("甲稿要挂的原片");
    await approved("乙稿名字像的那条");
    await put(path.join(env.inbox, "乙稿名字像的那条-原片.mov"), "take-x");
    const sha = (await list()).files[0].sha256;
    const base = { action: "inbox_attach", file: "乙稿名字像的那条-原片.mov", sha256: sha, content_id: a.id, founder_words: "挂到甲稿" };
    expect(await tool({ ...base, request_id: "intake-7" })).toMatchObject({ ok: false, code: "looks_like_other" });
    expect(await arolls(a.id)).toEqual([]);
    expect(await tool({ ...base, request_id: "intake-8", confirm_other: true, founder_words: "对，还是挂甲稿" })).toMatchObject({ ok: true, state: "accepted" });
  });

  it("按 id 点名已发布 / 已归档的稿 → not_attachable 写明原因，什么都不挂", async () => {
    await put(path.join(env.inbox, "IMG_0010.mov"), "x");
    const sha = (await list()).files[0].sha256;
    for (const status of ["published", "archived"] as const) {
      const c = await videoContent(env, `不能挂的${status}稿`, status);
      const r = await tool({ action: "inbox_attach", file: "IMG_0010.mov", sha256: sha, content_id: c.id, founder_words: "是这条", request_id: `na-${status}` });
      expect(r).toMatchObject({ ok: false, code: "not_attachable", error: expect.stringContaining(status) });
      expect(await arolls(c.id)).toEqual([]);
    }
  });

  it("缺原话 / 缺 sha256 / 缺 request_id → 拒，不动任何东西", async () => {
    const c = await approved("参数不全的稿");
    await put(path.join(env.inbox, "IMG_0009.mov"), "x");
    const sha = (await list()).files[0].sha256;
    expect(await tool({ action: "inbox_attach", file: "IMG_0009.mov", sha256: sha, content_id: c.id, request_id: "i9" })).toMatchObject({ code: "founder_words_required" });
    expect(await tool({ action: "inbox_attach", file: "IMG_0009.mov", content_id: c.id, founder_words: "是", request_id: "i9b" })).toMatchObject({ code: "invalid_params" });
    expect(await tool({ action: "inbox_attach", file: "IMG_0009.mov", sha256: sha, content_id: c.id, founder_words: "是" })).toMatchObject({ code: "invalid_params" });
    expect(await arolls(c.id)).toEqual([]);
  });
});

describe("「同步一下」与巡检节奏", () => {
  const empty: SweepResult = { errors: [], warnings: [], view_errors: [] };

  it("sync 立即跑一轮；同时来两次只跑一轮（第二个等同一轮，joined）", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setSweepRunner(async () => { calls += 1; await gate; return { ...empty, warnings: ["一条提醒"] }; });
    const a = tool({ action: "sync" });
    const b = tool({ action: "sync" });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra).toMatchObject({ ok: true, warnings: ["一条提醒"] });
    expect(rb).toMatchObject({ ok: true, joined: true });
    expect(await tool({ action: "sync" })).toMatchObject({ ok: true });
    expect(calls).toBe(2);
  });

  it("巡检没跑成 / 更新中跳过：看得见，不报成功", async () => {
    setSweepRunner(async () => ({ ...empty, error: "盘读不了" }));
    expect(await tool({ action: "sync" })).toMatchObject({ ok: false, code: "sweep_failed", error: expect.stringContaining("盘读不了") });
    setSweepRunner(async () => ({ ...empty, skipped: true }));
    expect(await tool({ action: "sync" })).toMatchObject({ ok: false, code: "updating" });
  });

  it("守护进程：启动跑一轮，之后每 30 分钟一轮（不是 60 秒）", async () => {
    let calls = 0;
    setSweepRunner(async () => { calls += 1; return empty; });
    const setIntervalSpy = vi.fn(() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout);
    startSweepLoop(() => env.dir, { setInterval: setIntervalSpy as unknown as typeof setInterval });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(SWEEP_INTERVAL_MS).toBe(30 * 60_000);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), SWEEP_INTERVAL_MS);
    const tick = (setIntervalSpy.mock.calls[0] as unknown as [() => void])[0];
    tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  it("真跑一轮：项目里换掉的原片照样对上，收件箱里的文件不碰", async () => {
    const c = await approved("巡检真跑的稿");
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "巡检真跑的稿-原片.mov"), "raw"), request_id: "r1" });
    const loose = await put(path.join(env.inbox, "IMG_7777.mov"), "loose");
    const r = await runSweep(env.dir);
    expect(r.error).toBeUndefined();
    expect(await exists(loose)).toBe(true);
    expect((await arolls(c.id)).map((f) => f.state)).toEqual(["accepted"]);
  });
});

describe("旧数据照常读（规则 5）", () => {
  it("旧对账报告里的「没对上」/ 监视文件夹字段：看板与「等你拍板」照常读，不再出收件箱条目", async () => {
    await approved("旧报告下的稿");
    await fs.mkdir(path.dirname(reportFile(env.dir)), { recursive: true });
    await fs.writeFile(reportFile(env.dir), JSON.stringify({ at: new Date().toISOString(), enabled: true, errors: [], moves: [], warnings: [],
      inbox: { unmatched: [{ name: "IMG_1.mov", path: path.join(env.inbox, "IMG_1.mov"), sha256: "a".repeat(64), size: 1, mtime_ms: 1, guess: ["旧报告下的稿"] }], failed: [], checking: 2, paused: true },
      watch: [{ path: "/Users/x/Downloads", at: new Date().toISOString(), files: 3, suggested: 1 }] }));
    await put(path.join(env.inbox, "IMG_1.mov"), "still-here");
    const view = await readInbox(env.dir);
    expect(view.items.some((i) => (i.type as string) === "inbox_file")).toBe(false);
    expect((await boardData(env.dir)).ontology.report).toMatchObject({ enabled: true });
  });

  it("停用前自动挂上 / 挂载核对中的原片：不出「对吗」「更像别条」条目，卡片照常、能点「不是」", async () => {
    const c = await approved("旧自动挂上的稿");
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "旧自动挂上的稿-原片.mov"), "raw"), request_id: "r1" });
    await withFileOwnership(() => mutateProduction(c.id, env.dir, (doc) => {
      Object.assign(doc.facts.find((f) => f.kind === "aroll")!, { auto_attached: true, source: "reconcile", attach_check: { status: "suggest", other_id: "content-x", other_title: "别条", at: new Date().toISOString() } });
      return { value: null, events: [] };
    }));
    const items = (await readInbox(env.dir, { contentId: c.id })).items;
    expect(items.some((i) => ["auto_attached", "attach_check"].includes(i.type as string))).toBe(false);
    const panel = await cardPanel(c.id, env.dir);
    expect(panel.arolls).toEqual([expect.objectContaining({ origin: "收件箱自动挂上", undo_blocked: null })]);
    expect(panel.arolls).toEqual([expect.not.objectContaining({ check: expect.anything() })]);
  });

  it("停用前留下的 pending_match：启动时转成候选并写原因，不再永远「正在核对」", async () => {
    const c = await approved("旧核对中的稿");
    const src = await put(path.join(env.outside, "IMG_old.mov"), "pending");
    const h = await cachedSha(src);
    await withFileOwnership(() => mutateProduction(c.id, env.dir, (doc) => {
      doc.facts.push({ id: "fact-pending-1", kind: "aroll", round: doc.round, state: "pending_match", availability: "present", source: "record", at: new Date().toISOString(),
        path: src, sha256: h.sha256, size: h.size, mtime_ms: h.mtime_ms, match_job: "mjob-old", match_started_at: new Date().toISOString(), evidence: "正在核对开头转写" });
      return { value: null, events: [] };
    }));
    resetProductionReady(env.dir);
    forgetShaIndex();
    const ready = await ensureProductionReady(env.dir);
    expect(ready.hookErrors).toBeUndefined();
    expect((await arolls(c.id)).find((f) => f.id === "fact-pending-1")).toMatchObject({ state: "candidate", evidence: PENDING_RETIRED });
    expect((await readInbox(env.dir, { contentId: c.id })).items.some((i) => i.type === "candidate")).toBe(true);
  });
});
