/**
 * autocrew_draft 新流程（spec 2026-10-15 §2.4、§7、§15.5、§15.9–15.13）：预览范文 → 立意锁版 → 先磨开头 → 观众试读。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "./draft.js";
import { OPENINGS, pickOpening } from "./draft-test-helpers.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";
import { getContent, updateContent } from "../storage/local-store.js";
import { putExemplar } from "../modules/exemplar/store.js";

let dir: string;
const BODY = "你让 AI 写周报，它交回来一份你自己都不认识的周报。省下来的时间，被你自己又填满了。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的时间写进日历。";
const ANGLE = { main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "你是不是也觉得更忙了？", why_viral: "没有数字", chain: ["一", "二", "三", "四"], founder_words: "就这个", genre: "ganhuo" };
const run = (action: string, args: Record<string, unknown> = {}) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });
const put = (id: string, text: string, genre: "ganhuo" | "renwu" = "ganhuo") => putExemplar({ id, genre, kind: "exemplar", title: id, text }, dir);

async function started(): Promise<{ id: string; v: number }> {
  const s = await run("start", { inspiration: "用了 AI 反而更忙" });
  return { id: s.content_id as string, v: (s.progress as { version: number }).version };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-ex-"));
  setQuoteFetch(async (url) => ({ finalUrl: url, title: "", text: "" }));
});
afterEach(async () => { setQuoteFetch(undefined); await fs.rm(dir, { recursive: true, force: true }); });

describe("预览与立意锁版", () => {
  it("exemplars 预览给全文和版本；angle 锁卡上引用的范文和写法；之后范文改版续写仍给锁住的那版", async () => {
    await put("bench-a", "# A\n第一版全文");
    const p = await run("exemplars", { genre: "ganhuo" });
    expect(p).toMatchObject({ ok: true, entries: [{ id: "bench-a", version: 1, text: "# A\n第一版全文" }] });
    expect(await run("exemplars", { genre: "nope" })).toMatchObject({ ok: false, code: "bad_genre" });
    const { id, v } = await started();
    expect(await run("angle", { content_id: id, base_version: v, ...ANGLE })).toMatchObject({ ok: false, code: "bad_param", error: expect.stringContaining("exemplars") });
    const a = await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: '[{"id":"bench-a","version":"1"}]' });
    expect(a).toMatchObject({ ok: true, exemplars: [{ id: "bench-a", version: 1 }], method_version: expect.stringMatching(/^[0-9a-f]{16}$/) });
    await put("bench-a", "# A\n第二版全文");
    const r = await run("start", { content_id: id }) as { progress: Record<string, any> };
    expect(r.progress.exemplars.entries[0]).toMatchObject({ id: "bench-a", version: 1, text: "# A\n第一版全文" });
    expect(r.progress.method.text).toContain("怎么让人看下去");
    expect(r.progress).toMatchObject({ needs_opening: true, opening_pick: null });
  });

  it("锁的范文不在库里 / 别的体裁 → 拒；同体裁重出不换；换体裁重新选", async () => {
    await put("bench-a", "# A");
    await put("bench-r", "# R", "renwu");
    const { id, v } = await started();
    expect(await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: [{ id: "bench-r", version: 1 }] })).toMatchObject({ ok: false, error: expect.stringContaining("凑数") });
    await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: [{ id: "bench-a", version: 1 }] });
    const again = await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: [] });
    expect(again).toMatchObject({ ok: true, exemplars: [{ id: "bench-a", version: 1 }], lock_note: expect.stringContaining("沿用") });
    const renwu = await run("angle", { content_id: id, base_version: v, ...ANGLE, genre: "renwu", exemplars: [{ id: "bench-r", version: 1 }] });
    expect(renwu).toMatchObject({ ok: true, exemplars: [{ id: "bench-r", version: 1 }] });
  });

  it("手册里点名的范文不在库里：回执降级提示，不失败", async () => {
    const { id, v } = await started();
    const a = await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: [] });
    expect(a.ok).toBe(true);
    expect(a.playbook_missing_exemplars).toEqual(expect.arrayContaining([{ id: "bench-toctou", note: "范文库里没有这篇" }]));
  });

  it("范文库清单坏了：预览报可见错误，不当空库", async () => {
    await fs.mkdir(path.join(dir, "exemplars"), { recursive: true });
    await fs.writeFile(path.join(dir, "exemplars", "manifest.json"), "{坏");
    expect(await run("exemplars", { genre: "ganhuo" })).toMatchObject({ ok: false, code: "exemplars_unreadable" });
  });

  it("旧稿（立意早于范文库）：同体裁照旧续写，不要求开头三选一", async () => {
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: [] });
    const c = (await getContent(id, dir))!;
    const { exemplars: _e, method: _m, exemplars_at: _t, ...legacy } = c.draftPath!.angle!;
    await updateContent(id, { draftPath: { ...c.draftPath!, angle: legacy } }, dir);
    expect(await run("angle", { content_id: id, base_version: v, ...ANGLE, founder_words: "再来" })).toMatchObject({ ok: true, lock_note: expect.stringContaining("照旧方式") });
    // 技能现在总传 exemplars：传 [] 也不能把旧稿拉进新流程（Codex 复审 #7）
    expect(await run("angle", { content_id: id, base_version: v, ...ANGLE, founder_words: "又来", exemplars: [] })).toMatchObject({ ok: true, exemplars: null, method_version: null });
    expect((await run("save", { content_id: id, base_version: v, body: BODY })).ok).toBe(true);
    expect((await run("start", { content_id: id }) as { progress: Record<string, unknown> }).progress.exemplars_note).toContain("早于范文库");
  });
});

describe("先磨开头", () => {
  it("没选开头不收第一版；选了才收；回执和进度写「等你选开头」", async () => {
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: [] });
    expect(await run("save", { content_id: id, base_version: v, body: BODY })).toMatchObject({ ok: false, code: "needs_opening" });
    expect(await run("opening", { content_id: id, base_version: v, opening: OPENINGS[0], founder_words: "第一个" })).toMatchObject({ ok: false, code: "no_candidates" });
    expect(await run("opening", { content_id: id, base_version: v, candidates: "只有一个" })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("opening", { content_id: id, base_version: v, candidates: JSON.stringify(OPENINGS) })).toMatchObject({ ok: true, round: 1, waiting: "等创始人选开头" });
    const s = await run("start", { content_id: id }) as { progress: Record<string, any>; next_action: { note: string } };
    expect(s.progress.opening_pick).toMatchObject({ round: 1, waiting: "等你选开头" });
    expect(s.next_action.note).toContain("原样编号列给创始人");
    expect(await run("opening", { content_id: id, base_version: v, opening: OPENINGS[1] })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("opening", { content_id: id, base_version: v, opening: OPENINGS[1], founder_words: "第二个，改一句" })).toMatchObject({ ok: true, chosen: OPENINGS[1] });
    expect((await getContent(id, dir))!.draftPath!.angle!.opening).toBe(OPENINGS[1]);
    expect((await run("save", { content_id: id, base_version: v, body: BODY })).ok).toBe(true);
    expect(await run("opening", { content_id: id, base_version: v + 1, candidates: OPENINGS })).toMatchObject({ ok: false, code: "has_body" });
  });

  it("连着两轮都没选中：不出第三轮，回到立意；重出立意后重新开始", async () => {
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: [] });
    await run("opening", { content_id: id, base_version: v, candidates: OPENINGS });
    expect(await run("opening", { content_id: id, base_version: v, candidates: OPENINGS, founder_words: "都不行" })).toMatchObject({ ok: true, round: 2 });
    expect(await run("opening", { content_id: id, base_version: v, candidates: OPENINGS, founder_words: "还是不行" })).toMatchObject({ ok: false, code: "back_to_angle" });
    await run("angle", { content_id: id, base_version: v, ...ANGLE, main_line: "换个立意", exemplars: [] });
    expect(await run("opening", { content_id: id, base_version: v, candidates: OPENINGS })).toMatchObject({ ok: true, round: 1 });
  });
});

describe("观众试读", () => {
  async function written() {
    const { id, v } = await started();
    await run("angle", { content_id: id, base_version: v, ...ANGLE, exemplars: [] });
    await pickOpening(run, id, v);
    const s = await run("save", { content_id: id, base_version: v, body: BODY });
    return { id, version: s.version as number };
  }

  it("记在它读的那一版上带 body_hash；改稿后标「修改前那版的试读」；失败不算已审", async () => {
    const { id, version } = await written();
    expect(await run("save", { content_id: id, base_version: version, body: BODY, test_read: { status: "maybe", notes: "x" } })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("save", { content_id: id, base_version: version, body: BODY, test_read: '{"status":"failed","notes":"子代理超时 8 分钟"}' })).toMatchObject({ ok: true, version });
    const rec = (await getContent(id, dir))!.draftPath!.testReads![0];
    expect(rec).toMatchObject({ kind: "viewer_test_read", status: "failed", version, body_hash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const fin = await run("prepare_final", { content_id: id, base_version: version, citations: [] });
    expect(fin.review).toMatchObject({ kind: "viewer_test_read", status: "failed", reviewed: false, current: true });
    const v2 = (await run("save", { content_id: id, base_version: version, body: `${BODY}改一句。` })).version as number;
    expect(await run("save", { content_id: id, base_version: v2, body: BODY, test_read: { status: "ok", notes: "读的不是这一版" } })).toMatchObject({ ok: false, code: "bad_param" });
    const fin2 = await run("prepare_final", { content_id: id, base_version: v2, citations: [] });
    expect(fin2.review).toMatchObject({ current: false, note: "这是修改前那版的试读" });
    const s = await run("start", { content_id: id }) as { progress: Record<string, any> };
    expect(s.progress.test_read).toMatchObject({ status: "failed", current: false });
  });
});
