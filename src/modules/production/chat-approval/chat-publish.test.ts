/**
 * 「发之前再看一眼」在对话里定（spec 2026-10-06 proactive-chat-review，Addendum 2）：每条一个测试。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc } from "../../../storage/production-store.js";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { executePublishCheck } from "../../publish/review-gate/check.js";
import { fakeJev, planEntry, planOf, registeredVideo, type Reg } from "../../publish/review-gate/testkit.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { decideItem } from "../inbox-decide.js";
import { makeEnv, type Env } from "../testkit.js";
import { setChatDecideDeps } from "./decide.js";
import { setPreviewDeps } from "./preview.js";

let env: Env;
let pane: string;
beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  setPullDeps({ benchPort: 4317 });
  setChatDecideDeps({ jev: fakeJev().caller });
  setPreviewDeps({ open: async () => undefined });
  pane = path.join(env.dir, "..", "session");
  await fs.mkdir(pane, { recursive: true });
});
afterEach(async () => { setPreviewDeps(null); setChatDecideDeps(null); setPullDeps(null); await env.cleanup(); });

type Item = { item_id: string; gen: string; type: string; chat_decidable: boolean; brief: string; decisions: Array<{ decision: string }>; facts: { platform: string }; preview?: { files: Array<{ path: string }> } };
const tool = (p: Record<string, unknown>) => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "s1", ...p });
const checks = async (p: Record<string, unknown> = {}) => ((await tool({ action: "list", ...p })).items as Item[]).filter((i) => i.type === "publish_check");
const runCheck = (r: Reg, entries: unknown[]) => executePublishCheck({ _dataDir: env.dir, content_id: r.id, plan: planOf(r, entries) }, { jev: fakeJev().caller });
let rid = 0;
const decidePub = (it: Item, decision: string, extra: Record<string, unknown> = {}) =>
  tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision, founder_words: "没问题", request_id: `p-${++rid}`, ...extra });
const decisionsOf = async (id: string, type: string) => (await readProductionDoc(id, env.dir))!.decisions.filter((d) => d.type === type);
const SCHEDULE = { tags: ["#AI工具", "#效率"], scheduled_at: "2026-10-07 18:00", timezone: "Asia/Shanghai" };

describe("brief（第 1 条）", () => {
  it("计划条目原样、定时带时区、成片绝对路径、检查结果分组；封面进会话文件夹", async () => {
    const r = await registeredVideo(env);
    await runCheck(r, [planEntry(r, "douyin", ["3:4", "4:3"], { title: "标题 <原样> \"引号\"", ...SCHEDULE })]);
    const [it0] = await checks({ preview_dir: pane });
    expect(it0.chat_decidable).toBe(true);
    const b = it0.brief;
    expect(b).toContain("标题：「标题 <原样> \"引号\"」");
    expect(b).toMatch(/简介：「.+」/);
    expect(b).toContain("话题：#AI工具 #效率");
    expect(b).toContain("封面字：「AI 又忘了？」");
    expect(b).toContain("定时：2026-10-07 18:00（Asia/Shanghai）");
    expect(b).toContain(`成片：${path.join(r.root, r.video)}`);
    expect(b).toMatch(/通过（\d+）：/);
    expect(b).toMatch(/没查实（\d+）：/);
    expect(b).toContain("被拦（0）：无");
    expect(b).toContain("回我「没问题」/「还要改：……」");
    expect(it0.preview!.files).toHaveLength(2);
    await fs.access(path.join(pane, it0.preview!.files[0].path));
  });
});

describe("决定（第 2 条）", () => {
  it("被拦：不给「没问题」，被拦依据原文照录；只能改或破例", async () => {
    const r = await registeredVideo(env);
    await runCheck(r, [planEntry(r, "xiaohongshu", ["4:3"])]);
    const [it0] = await checks();
    expect(it0.decisions.map((d) => d.decision)).toEqual(["publish_check_revise", "publish_check_override"]);
    expect(it0.brief).toMatch(/被拦（[1-9]）：.+——.+/);
    expect(it0.brief).toContain("「没问题」用不了");
    expect(await decidePub(it0, "publish_check_confirm")).toMatchObject({ ok: false, code: "not_chat_decidable" });
  });

  it("破例必须带原话，原话原样记进新检查", async () => {
    const r = await registeredVideo(env);
    await runCheck(r, [planEntry(r, "xiaohongshu", ["4:3"])]);
    const [it0] = await checks();
    expect(await decidePub(it0, "publish_check_override", { founder_words: "" })).toMatchObject({ ok: false, code: "founder_words_required" });
    const out = await decidePub(it0, "publish_check_override", { founder_words: "这次横版就行，别拦了" });
    expect(out).toMatchObject({ ok: true });
    const rec = JSON.parse(await fs.readFile(path.join(r.root, "06-publish/checks", `${String(out.check_id)}.json`), "utf8"));
    expect(rec.inputs.overrides).toEqual(expect.arrayContaining([expect.objectContaining({ founder_quote: "这次横版就行，别拦了" })]));
  });

  it("还要改：note 必填；记成对话来源、原话", async () => {
    const r = await registeredVideo(env);
    await runCheck(r, [planEntry(r, "douyin", ["3:4", "4:3"])]);
    const [it0] = await checks();
    expect(await decidePub(it0, "publish_check_revise")).toMatchObject({ ok: false, code: "note_required" });
    expect(await decidePub(it0, "publish_check_revise", { note: "标题别用问号", founder_words: "标题别用问号" })).toMatchObject({ ok: true });
    expect((await decisionsOf(r.id, "publish_check_revise"))[0]).toMatchObject({ source: "chat", note: "标题别用问号", founder_words: "标题别用问号" });
  });
});

describe("「都没问题」（第 3 条）", () => {
  it("列出来的几个平台各定一次，同一句原话，各自代次", async () => {
    const r = await registeredVideo(env);
    await runCheck(r, [planEntry(r, "douyin", ["3:4", "4:3"]), planEntry(r, "wechat_video", ["3:4", "4:3"])]);
    const listed = await checks();
    expect(listed).toHaveLength(2);
    for (const it of listed) expect(await decidePub(it, "publish_check_confirm", { founder_words: "都没问题" })).toMatchObject({ ok: true, recorded_as: "chat" });
    const ds = await decisionsOf(r.id, "publish_check_confirm");
    expect(ds.map((d) => d.platform).sort()).toEqual(["douyin", "wechat_video"]);
    for (const d of ds) expect(d).toMatchObject({ source: "chat", founder_words: "都没问题" });
    expect(await checks()).toEqual([]);
  });
});

describe("守卫（第 4 条）", () => {
  it("看过之后成片字节被换、元数据没变 → 「没问题」被拒，什么都没记，给现在的样子", async () => {
    const r = await registeredVideo(env);
    await runCheck(r, [planEntry(r, "douyin", ["3:4", "4:3"])]);
    const [it0] = await checks();
    const video = path.join(r.root, r.video);
    const st = await fs.stat(video);
    const old = await fs.readFile(video);
    await fs.writeFile(video, Buffer.from(old.toString().replace(/./, "X")));
    await fs.utimes(video, st.atimeMs / 1000, st.mtimeMs / 1000);
    expect((await checks())[0].gen).toBe(it0.gen); // 读路径按元数据认：看不出来，只有提交时现算能逮住
    const out = await decidePub(it0, "publish_check_confirm");
    expect(out).toMatchObject({ ok: false, code: "check_stale", item: { item_id: it0.item_id } });
    expect(await decisionsOf(r.id, "publish_check_confirm")).toHaveLength(0);
  });

  it("看过之后计划改了（代次变）→ stale + 新的样子", async () => {
    const r = await registeredVideo(env);
    await runCheck(r, [planEntry(r, "douyin", ["3:4", "4:3"])]);
    const [old] = await checks();
    await runCheck(r, [planEntry(r, "douyin", ["3:4", "4:3"], { title: "换了个标题" })]);
    const out = await decidePub(old, "publish_check_confirm");
    expect(out).toMatchObject({ ok: false, code: "stale" });
    expect((out.item as { gen: string }).gen).not.toBe(old.gen);
  });

  it("网页上已经定了 → already_handled；网页那条路照旧；同一 request_id 重试回放", async () => {
    const r = await registeredVideo(env);
    await runCheck(r, [planEntry(r, "douyin", ["3:4", "4:3"]), planEntry(r, "wechat_video", ["3:4", "4:3"])]);
    const [a, b] = await checks();
    expect(await decideItem({ content_id: r.id, item_id: a.item_id, gen: a.gen, action: "publish_check_confirm" }, env.dir)).toMatchObject({ ok: true });
    expect((await decisionsOf(r.id, "publish_check_confirm"))[0]).toMatchObject({ source: "founder" });
    expect(await decidePub(a, "publish_check_confirm")).toMatchObject({ ok: false, code: "already_handled" });
    const once = await decidePub(b, "publish_check_confirm", { request_id: "same" });
    expect(await decidePub(b, "publish_check_confirm", { request_id: "same" })).toMatchObject({ ok: true, replayed: true, decision: { id: (once.decision as { id: string }).id } });
  });
});
