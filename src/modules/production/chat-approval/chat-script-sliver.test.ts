/**
 * 对话里认稿（draft）与处理画面闪帧（sliver）：spec 2026-10-11 验收清单 1–8。假 ChatCut 工程建在临时库旁边，不碰真实目录。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getContent } from "../../../storage/local-store.js";
import { readProductionDoc } from "../../../storage/production-store.js";
import { executeContentSave } from "../../../tools/content-save.js";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { HUMAN_WRITE } from "../../../storage/first-body-guard.js";
import { setPullDeps } from "../../video/handoff/pull-deps.js";
import { founderApprove, makeEnv, put, record, videoContent, type Env } from "../testkit.js";
import { setChatcutDeps, type MediaInfo } from "../sliver/chatcut-read.js";
import { ASSETS, aroll, broll, timeline } from "../sliver/fixtures.js";
import type { Json } from "../sliver/snapshot-types.js";
import { hiddenUntilScriptApproved } from "../ready.js";

let env: Env, ccRoot: string;
const PID = "proj-chat-1";
/** 原片名要对得上稿名才自动认（和 gate.test 同一对） */
const TITLE = "AI 又忘了怎么办";
const raw = (_t: string) => "AI又忘了怎么办-原片.mov";
const media = async (f: string): Promise<MediaInfo> => (f.startsWith("/fake/") ? { pix_fmt: "yuv420p" } : { r_frame_rate: "30/1", nb_frames: 300 });
beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  ccRoot = path.join(path.dirname(env.dir), "chatcut-projects");
  setPullDeps({ benchPort: 4317 });
  setChatcutDeps({ projectsRoot: () => ccRoot, media });
});
afterEach(async () => { setChatcutDeps(null); setPullDeps(null); await env.cleanup(); });

type R = Record<string, any>;
const tool = (p: R): Promise<R> => executeReviewInbox({ _dataDir: env.dir, _host: "claude-code", _session: "sess-abcdef123", ...p });
let rid = 0;
const nextId = () => `rq-${++rid}`;
const list = async (contentId?: string) => (await tool({ action: "list", ...(contentId ? { content_id: contentId } : {}) })).items as R[];
const itemOf = async (type: string, contentId?: string) => (await list(contentId)).find((i) => i.type === type)!;
const decide = (it: R, decision: string, extra: R = {}) => tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision, founder_words: "原话", request_id: nextId(), ...extra });
const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;

/** 假 ChatCut 工程：一条 A-roll 垫底，B-roll 之间留 gaps 处缝 */
async function writeProject(title: string, gaps: number, schema = 11): Promise<void> {
  const dir = path.join(ccRoot, PID, "project.chatcutproject");
  await fs.mkdir(path.join(dir, "timelines"), { recursive: true });
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  const items = [aroll("ar", 0, 300)];
  for (let i = 0, at = 30; i <= gaps; i++, at += 50) items.push(broll(`b${i}`, at, i < gaps ? 45 : 50));
  const tl: Json = { ...timeline({ videoItems: items }), id: "tl-1" };
  await fs.writeFile(path.join(dir, "timelines/t.json"), JSON.stringify(tl));
  const t = new Date(Date.now() - 120_000);
  await fs.utimes(path.join(dir, "timelines/t.json"), t, t);
  const assets = { ...ASSETS, A: { ...ASSETS.A, path: path.join(env.inbox, raw(title)) } };
  const videoAssets = [];
  for (const a of Object.values(assets).filter((x) => x.type !== "image" && x.type !== "motion-graphic")) {
    const { pix_fmt: _p, ...meta } = a;
    await fs.writeFile(path.join(dir, `assets/${a.id}.json`), JSON.stringify(meta));
    videoAssets.push({ id: a.id, name: a.name, resourcePath: `assets/${a.id}.json` });
  }
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify({ projectId: PID, schemaVersion: schema, timelines: [{ id: "tl-1", resourcePath: "timelines/t.json" }], videoAssets, imageAssets: [], motionGraphicAssets: [] }));
}

/** 认过稿、原片、（可选）ChatCut 工程、标了「可以审了」的成片 */
async function cutUnderReview(title: string, o: { chatcut?: boolean } = {}) {
  const c = await videoContent(env, o.chatcut === false ? title : TITLE);
  await founderApprove(env, c.id);
  const ar = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, raw(title)), "raw"), request_id: "a" });
  if (o.chatcut !== false) await record(env, { content_id: c.id, kind: "chatcut_project", chatcut_project_id: PID, uses_aroll: [ar.fact_id], request_id: "cc" });
  await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, `${title}.mp4`), "cut-v1"), request_id: "c", review: true });
  return c;
}

describe("认稿在对话里定（B2）", () => {
  it("1 认稿和成片同时在等：都列出来、编号；认稿 brief 贴全文和字数", async () => {
    const draft = await videoContent(env, "等认的稿", "draft_ready", "第一段正文。\n第二段正文。");
    const cutC = await cutUnderReview("等审的片", { chatcut: false });
    const items = await list();
    const d = items.find((i) => i.type === "draft")!, k = items.find((i) => i.type === "cut_review")!;
    expect(d).toMatchObject({ content_id: draft.id, chat_decidable: true, number: expect.any(Number), facts: { words: 12 } });
    expect(k).toMatchObject({ content_id: cutC.id, number: expect.any(Number) });
    expect(d.number).not.toBe(k.number);
    expect(d.brief).toContain("第一段正文。\n第二段正文。");
    expect(d.brief).toContain("「稿子没问题」");
  });

  it("2 list 之后正文改过：approve_script 回 stale + 新 brief，什么都不记", async () => {
    const c = await videoContent(env, "改过的稿", "draft_ready", "旧正文。");
    const it0 = await itemOf("draft");
    await executeContentSave({ _dataDir: env.dir, _writer: HUMAN_WRITE, action: "update", id: c.id, body: "新正文，改过了。" });
    const r = await decide(it0, "approve_script");
    expect(r).toMatchObject({ ok: false, code: "stale" });
    expect(r.item.brief).toContain("新正文，改过了。");
    expect((await getContent(c.id, env.dir))!.status).toBe("draft_ready");
  });

  it("5 原话必填；认稿记成 chat 并带发起方；8 revise_script 没 note → note_required", async () => {
    const a = await videoContent(env, "稿一", "draft_ready");
    const ia = await itemOf("draft", a.id);
    expect(await tool({ action: "decide", item_id: ia.item_id, gen: ia.gen, decision: "approve_script", request_id: nextId() })).toMatchObject({ code: "founder_words_required" });
    const r = await decide(ia, "approve_script", { founder_words: "稿子没问题" });
    expect(r).toMatchObject({ ok: true, recorded_as: "chat", next_action: expect.stringContaining("再 list") });
    expect((await getContent(a.id, env.dir))!.status).toBe("approved");
    const b = await videoContent(env, "稿二", "draft_ready");
    const ib = await itemOf("draft", b.id);
    expect(await decide(ib, "revise_script")).toMatchObject({ code: "note_required" });
    expect(await decide(ib, "revise_script", { note: "开头换一句" })).toMatchObject({ ok: true });
    expect((await getContent(b.id, env.dir))!.status).toBe("revision");
    const rev = (await doc(b.id)).decisions.find((x) => x.type === "script_revise")!;
    expect(rev).toMatchObject({ source: "chat", founder_words: "原话", requested_by: "Claude（会话 sess-abc）" });
  });

  it("7 同一个 request_id 重放同结果；同号换内容 → request_conflict", async () => {
    await videoContent(env, "幂等的稿", "draft_ready");
    const it0 = await itemOf("draft");
    const req = { action: "decide", item_id: it0.item_id, gen: it0.gen, decision: "approve_script", founder_words: "行", request_id: "same-1" };
    const first = await tool(req);
    expect(first).toMatchObject({ ok: true });
    expect(await tool(req)).toMatchObject({ ok: true, replayed: true });
    expect(await tool({ ...req, founder_words: "换了" })).toMatchObject({ code: "request_conflict" });
  });
});

describe("写稿阶段的指引（B3）", () => {
  it("draft_ready → 叫 agent 在对话里列认稿那件；没交审 → 先交审再在对话里问；都不许代认", () => {
    const ready = hiddenUntilScriptApproved({ phase: "writing" }, "draft_ready", "成片记下了")!;
    expect(ready).toContain("autocrew_review_inbox");
    expect(ready).not.toContain("点「稿子没问题」");
    expect(ready).toContain("不要替创始人认稿");
    const early = hiddenUntilScriptApproved({ phase: "writing" }, "drafting", "成片记下了")!;
    expect(early).toMatch(/先走审稿.*draft_ready.*autocrew_review_inbox/);
  });
});

describe("画面闪帧在对话里定（B1）", () => {
  it("3 多处缝：不点名 → selector_required；点错 → stale；逐处点名都能放行，放行完成片能用同一句原话通过", async () => {
    await writeProject("两处缝", 2);
    const c = await cutUnderReview("两处缝");
    const s = await itemOf("sliver");
    expect(s.facts.points).toHaveLength(2);
    expect(s.brief).toMatch(/第 1 处：.*\n第 2 处：/);
    expect(s.brief).toContain("「都是故意的」");
    expect(s.brief).not.toContain("「不查了」");
    expect((await itemOf("cut_review")).facts.blocked_reason).toContain("对话里就能定");
    expect(await decide(s, "waive_sliver")).toMatchObject({ code: "selector_required" });
    expect(await decide(s, "waive_sliver", { sliver_key: "nope" })).toMatchObject({ ok: false, code: "stale" });
    let cur = s;
    for (const p of s.facts.points) {
      expect(await decide(cur, "waive_sliver", { sliver_key: p.sliver_key, founder_words: "都是故意的" })).toMatchObject({ ok: true, recorded_as: "chat" });
      cur = await itemOf("sliver");
    }
    expect(cur).toBeUndefined();
    expect((await doc(c.id)).decisions.filter((d) => d.type === "sliver_waive")).toHaveLength(2);
    const k = await itemOf("cut_review");
    expect(await decide(k, "approve_cut", { fact_id: k.facts.versions[0].fact_id, founder_words: "都是故意的" })).toMatchObject({ ok: true });
  });

  it("4 查出了缝时不给「不查了」：硬要定 → not_chat_decidable", async () => {
    await writeProject("一处缝", 1);
    await cutUnderReview("一处缝");
    const s = await itemOf("sliver");
    expect(s.decisions.map((d: R) => d.decision)).toEqual(["waive_sliver", "reject_cut"]);
    expect(await decide(s, "waive_sliver_check")).toMatchObject({ code: "not_chat_decidable" });
  });

  it("6 ChatCut 格式版本不认识（12）：未检查，对话里能「不查了」；记成 chat", async () => {
    await writeProject("新版本工程", 1, 12);
    const c = await cutUnderReview("新版本工程");
    const s = await itemOf("sliver");
    expect(s.facts).toMatchObject({ status: "unchecked", reason: expect.stringContaining("格式版本（12）不认识"), points: [] });
    expect(s.decisions.map((d: R) => d.decision)).toEqual(["waive_sliver_check", "reject_cut"]);
    expect(s.brief).toContain("「不查了」");
    expect(await decide(s, "waive_sliver_check", { founder_words: "不查了，用" })).toMatchObject({ ok: true, next_action: expect.stringContaining("approve_cut") });
    expect((await doc(c.id)).decisions.find((d) => d.type === "sliver_waive_all")).toMatchObject({ source: "chat", founder_words: "不查了，用" });
  });

  it("8 reject_cut 没 note → note_required；带 note 打回", async () => {
    await writeProject("打回的片", 1);
    const c = await cutUnderReview("打回的片");
    const s = await itemOf("sliver");
    expect(await decide(s, "reject_cut")).toMatchObject({ code: "note_required" });
    expect(await decide(s, "reject_cut", { note: "补一帧 B-roll" })).toMatchObject({ ok: true });
    expect((await doc(c.id)).decisions.find((d) => d.type === "cut_reject")).toMatchObject({ source: "chat" });
  });

  it("7 新决定类型的 request_id：同号换内容 → request_conflict", async () => {
    await writeProject("幂等闪帧", 1, 12);
    await cutUnderReview("幂等闪帧");
    const s = await itemOf("sliver");
    const req = { action: "decide", item_id: s.item_id, gen: s.gen, decision: "waive_sliver_check", founder_words: "不查了", request_id: "sv-1" };
    expect(await tool(req)).toMatchObject({ ok: true });
    expect(await tool(req)).toMatchObject({ ok: true, replayed: true });
    expect(await tool({ ...req, decision: "reject_cut", note: "改" })).toMatchObject({ code: "request_conflict" });
  });
});
