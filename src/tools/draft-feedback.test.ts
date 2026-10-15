/**
 * 改稿意见怎么学（docs/2026-10-15-writing-exemplars-spec.md §6、§15.6–15.8）：
 * save 不再即时造规则 / 提案；意见原话照存（正文没改也记、开头阶段也记）；跨稿读意见；
 * 升级提案要两篇不同稿的出处、服务端核；手册走提案与版本，范文批注 / 写法进「等你拍板」，批了范文出新版本、写法出补丁等发布。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickOpening } from "./draft-test-helpers.js";
import { executeDraft } from "./draft.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";
import { getContent, updateContent } from "../storage/local-store.js";
import { loadProfile, updateProfile } from "../modules/profile/creator-profile.js";
import { loadManifest } from "../modules/playbook/store.js";
import { putExemplar, readExemplarText } from "../modules/exemplar/store.js";
import { readPromotions } from "../modules/exemplar/promotions.js";
import { listForChat } from "../modules/production/chat-approval/present.js";
import { chatDecide } from "../modules/production/chat-approval/decide.js";

let dir: string;
const BODY = "你是不是也觉得用了 AI 以后反而更忙了？我先说结论：省下来的时间，被你自己又填满了。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的时间写进日历，标成不许约会。";
const BODY2 = BODY.replace("我先说结论：", "") + "就这一件事。";
const ANGLE = { exemplars: [] as unknown[],
  main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "你是不是也觉得更忙了？", why_viral: "没有数字",
  chain: ["更忙", "时间没消失", "被填满", "先占住"], founder_words: "就第二个", genre: "ganhuo",
};
const run = (action: string, args: Record<string, unknown> = {}) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });

async function firstVersion(inspiration = "用了 AI 反而更忙"): Promise<{ id: string; version: number }> {
  const s = await run("start", { inspiration });
  const id = s.content_id as string;
  const v = (s.progress as { version: number }).version;
  expect((await run("angle", { content_id: id, base_version: v, ...ANGLE })).ok).toBe(true);
  await pickOpening(run, id, v);
  const saved = await run("save", { content_id: id, base_version: v, body: BODY });
  expect(saved.ok).toBe(true);
  return { id, version: saved.version as number };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-feedback-"));
  await updateProfile({ industry: "AI 实操", platforms: ["douyin"] }, dir);
  setQuoteFetch(async (url) => ({ finalUrl: url, title: "", text: "" }));
});
afterEach(async () => { setQuoteFetch(undefined); await fs.rm(dir, { recursive: true, force: true }); });

describe("save feedback：只记原话，不即时造规则", () => {
  it("旧会话照传 lessons：不建档案规则、不挂手册提案；lessons 原样留着，回执带看得见的说明", async () => {
    const { id, version } = await firstVersion();
    const r = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "开头别先说结论", lessons: [{ rule: "开头不先抛结论", scope: "platform:douyin", relation: "new" }] } });
    expect(r).toMatchObject({ ok: true, lessons_note: expect.stringContaining("定稿时跨稿比对"), feedback_recorded: { version: version + 1 } });
    expect((await loadProfile(dir))!.writingRules).toEqual([]);
    expect((await loadManifest(dir)).playbooks.every((e) => e.proposals.length === 0)).toBe(true);
    const fb = (await getContent(id, dir))!.draftPath!.feedback!.filter((f) => f.stage === "body");
    expect(fb).toEqual([expect.objectContaining({ founder_words: "开头别先说结论", body_changed: true, deferred_lessons: [expect.objectContaining({ rule: "开头不先抛结论" })] })]);
  });

  it("正文没改也记意见（不出新版本）；同一版同一句重放不重复记", async () => {
    const { id, version } = await firstVersion();
    const r = await run("save", { content_id: id, base_version: version, body: BODY, feedback: { founder_words: "整体还行，先放着" } });
    expect(r).toMatchObject({ ok: true, version, body_changed: false });
    const again = await run("save", { content_id: id, base_version: version, body: BODY, feedback: { founder_words: "整体还行，先放着" } });
    expect(again).toMatchObject({ ok: true, feedback_replayed: true });
    const fb = (await getContent(id, dir))!.draftPath!.feedback!.filter((f) => f.stage === "body");
    expect(fb).toEqual([expect.objectContaining({ founder_words: "整体还行，先放着", body_changed: false, version })]);
    expect(r.lessons_note).toBeUndefined();
  });

  it("字符串化 JSON 能修就修；修不了或 lessons 不是数组才拒（不当空数组）", async () => {
    const { id, version } = await firstVersion();
    expect(await run("save", { content_id: id, base_version: version, body: BODY2, feedback: '{"founder_words":"他说"别这样"","lessons":[]}' })).toMatchObject({ ok: true });
    expect(await run("save", { content_id: id, base_version: version + 1, body: BODY, feedback: { founder_words: "x", lessons: "不是数组" } })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("save", { content_id: id, base_version: version + 1, body: BODY, feedback: "{坏" })).toMatchObject({ ok: false, code: "bad_param" });
  });

  it("第一版不收 feedback；开头阶段的意见经 opening 记成 stage=opening", async () => {
    const s = await run("start", { inspiration: "用了 AI 反而更忙" });
    const id = s.content_id as string;
    const v = (s.progress as { version: number }).version;
    await run("angle", { content_id: id, base_version: v, ...ANGLE });
    await run("opening", { content_id: id, base_version: v, candidates: ["甲甲甲", "乙乙乙", "丙丙丙"] });
    await run("opening", { content_id: id, base_version: v, candidates: ["丁丁丁", "戊戊戊", "己己己"], founder_words: "三个都太像广告" });
    expect(await run("save", { content_id: id, base_version: v, body: BODY, feedback: { founder_words: "x" } })).toMatchObject({ ok: false, code: "bad_param" });
    const fb = (await getContent(id, dir))!.draftPath!.feedback!;
    expect(fb).toEqual([expect.objectContaining({ stage: "opening", founder_words: "三个都太像广告" })]);
    await run("opening", { content_id: id, base_version: v, opening: "丁丁丁", founder_words: "选 1" });
    const after = (await getContent(id, dir))!.draftPath!;
    expect(after.feedback).toHaveLength(1);
    expect(after.angle!.opening_pick).toMatchObject({ chosen: "丁丁丁", founder_words: "选 1" });
  });
});

describe("示例稿与看板交接（main 合进来的行为）", () => {
  it("O20：示例稿的意见记在稿上，回执说明不进学习；跨稿意见里也不出现", async () => {
    const { id, version } = await firstVersion();
    await updateContent(id, { example: true }, dir);
    const r = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "开头别先说结论", lessons: [{ rule: "开头不先抛结论", scope: "platform:douyin", relation: "new" }] } });
    expect(r).toMatchObject({ ok: true, lessons_skipped: expect.stringContaining("示例稿") });
    expect((await getContent(id, dir))!.draftPath!.feedback!.filter((f) => f.stage === "body")).toEqual([expect.objectContaining({ founder_words: "开头别先说结论" })]);
    expect((await run("feedback_history", {})).entries).toEqual([]);
  });

  it("看板交出去的稿：没再调 start、直接存了一版也算接手，记下是谁（spec 2026-10-15 §B5）", async () => {
    const s = await run("start", { inspiration: "x" });
    const id = s.content_id as string, v = (s.progress as { version: number }).version;
    await run("angle", { content_id: id, base_version: v, ...ANGLE });
    await pickOpening(run, id, v);
    await updateContent(id, { writingHandoff: { host: "codex", at: new Date().toISOString() } }, dir);
    expect(await run("save", { content_id: id, base_version: v, body: BODY })).toMatchObject({ ok: true });
    expect((await getContent(id, dir))!.writingHandoff).toMatchObject({ host: "codex", pickedUpBy: "claude-code", pickedUpAt: expect.any(String) });
  });
});

describe("跨稿读意见与升级提案", () => {
  async function twoDrafts() {
    const a = await firstVersion("第一篇");
    await run("save", { content_id: a.id, base_version: a.version, body: BODY2, feedback: { founder_words: "故事要有反转" } });
    const b = await firstVersion("第二篇");
    await run("save", { content_id: b.id, base_version: b.version, body: BODY2, feedback: { founder_words: "这里没有反转，看不下去" } });
    const h = await run("feedback_history", {});
    const entries = h.entries as Array<{ content_id: string; index: number; founder_words: string; stage: string }>;
    const cite = (id: string) => entries.find((e) => e.content_id === id && e.stage === "body")!;
    return { a: a.id, b: b.id, ca: cite(a.id), cb: cite(b.id) };
  }

  it("feedback_history 列出各稿原话、编号、体裁", async () => {
    const { a, ca } = await twoDrafts();
    expect(ca).toMatchObject({ content_id: a, founder_words: "故事要有反转", genre: "ganhuo" });
    expect(ca.index).toBeGreaterThan(0);
  });

  it("出处只有一篇稿 / 编号不存在 → 拒；不再接受档案规则目标", async () => {
    const { a, ca } = await twoDrafts();
    const base = { content_id: a, target: "method", text: "中段每一关都要有真碰到的坑", note: "两篇都说要反转" };
    expect(await run("propose_promotion", { ...base, cites: [{ content_id: a, index: ca.index }, { content_id: a, index: ca.index }] })).toMatchObject({ ok: false, code: "bad_cites" });
    expect(await run("propose_promotion", { ...base, cites: [{ content_id: a, index: ca.index }, { content_id: a, index: 99 }] })).toMatchObject({ ok: false, code: "bad_cites" });
    expect(await run("propose_promotion", { ...base, target: "rule", cites: [] })).toMatchObject({ ok: false, code: "bad_param" });
  });

  it("手册目标走现有提案；范文批注批了出范文新版本（旧版不动）；写法批了出补丁、一直显示「已批，等发布」", async () => {
    const { a, b, ca, cb } = await twoDrafts();
    const cites = JSON.stringify([{ content_id: a, index: ca.index }, { content_id: b, index: cb.index }]);
    const book = (await loadManifest(dir)).playbooks.find((e) => e.id === "ganhuo")!;
    const pbArgs = { content_id: a, target: "playbook", genre: "ganhuo", text: `# 干货方法\n\n## 什么时候选它\n\n- 新骨架 v${book.current}\n`, note: "两篇都说要反转", cites };
    expect(await run("propose_promotion", pbArgs)).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("propose_promotion", { ...pbArgs, base_version: book.current + 1 })).toMatchObject({ ok: false, code: "stale", current: book.current });
    const pb = await run("propose_promotion", { ...pbArgs, base_version: book.current });
    expect(pb).toMatchObject({ ok: true, target: "playbook", proposal_id: expect.stringMatching(/^pp-/) });
    await putExemplar({ id: "bench-toctou", genre: "ganhuo", kind: "exemplar", title: "TOCTOU", text: "# TOCTOU\n全文" }, dir);
    expect(await run("propose_promotion", { content_id: a, target: "exemplar", exemplar_id: "bench-toctou", text: "[00:46] 改前 → 改后", note: "范文批注", cites })).toMatchObject({ ok: true, outcome: "proposed" });
    expect(await run("propose_promotion", { content_id: a, target: "method", text: "中段每一关都要有真碰到的坑", note: "写法", cites })).toMatchObject({ ok: true, outcome: "proposed" });
    const list = async () => (await listForChat(dir, {}) as { items: Array<{ item_id: string; gen: string; type: string; title: string; brief?: string; summary: string }> }).items;
    const ex = (await list()).find((i) => i.type === "writing_promotion" && i.summary === "范文批注")!;
    expect(ex.brief).toContain("故事要有反转");
    expect(await chatDecide({ item_id: ex.item_id, gen: ex.gen, decision: "approve_promotion", founder_words: "你定", request_id: "r-1" }, dir)).toMatchObject({ ok: false, code: "founder_words_not_approval" });
    expect(await chatDecide({ item_id: ex.item_id, gen: ex.gen, decision: "approve_promotion", founder_words: "批", request_id: "r-2" }, dir)).toMatchObject({ ok: true, status: "applied", exemplar_version: 2 });
    expect(await fs.readFile(path.join(dir, "exemplars", "bench-toctou", "v1.md"), "utf8")).toBe("# TOCTOU\n全文");
    // 范文版本上记着是哪份提案：重试只补状态，不再追加（Codex 复审 #2）
    const { readExemplarManifest } = await import("../modules/exemplar/store.js");
    expect((await readExemplarManifest(dir)).exemplars[0].versions.at(-1)).toMatchObject({ version: 2, promotion_id: expect.stringMatching(/^wp-/) });
    expect(await readExemplarText("bench-toctou", 2, dir)).toMatch(/全文[\s\S]*追加批注[\s\S]*\[00:46\] 改前 → 改后/);
    const me = (await list()).find((i) => i.type === "writing_promotion" && i.summary === "写法")!;
    const r = await chatDecide({ item_id: me.item_id, gen: me.gen, decision: "approve_promotion", founder_words: "批这条", request_id: "r-3" }, dir);
    expect(r).toMatchObject({ ok: true, status: "approved_pending_release", patch_file: expect.stringContaining("method-patches") });
    expect(await fs.readFile(path.join(dir, String(r.patch_file)), "utf8")).toContain("中段每一关都要有真碰到的坑");
    expect((await list()).find((i) => i.title === "写法改动已批，等发布")).toBeTruthy();
    expect((await readPromotions(dir)).map((p) => p.status).sort()).toEqual(["applied", "approved_pending_release"]);
  });

});
