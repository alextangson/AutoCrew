/**
 * 改稿意见怎么学（docs/2026-10-15-writing-exemplars-spec.md §6、§15.6–15.8）：
 * save 不再即时造规则 / 提案；意见原话照存（正文没改也记、开头阶段也记）；跨稿读意见；
 * 升级提案要两篇不同稿的出处、服务端核；手册走提案与版本，范文批注 / 写法进「等你拍板」，批了只标等人工改。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickOpening } from "./draft-test-helpers.js";
import { executeDraft } from "./draft.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";
import { getContent } from "../storage/local-store.js";
import { loadProfile, updateProfile } from "../modules/profile/creator-profile.js";
import { loadManifest } from "../modules/playbook/store.js";
import { putExemplar } from "../modules/exemplar/store.js";
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

  it("手册目标走现有提案；范文 / 写法进「等你拍板」，批了只标「等人工改」，不改范文", async () => {
    const { a, b, ca, cb } = await twoDrafts();
    const cites = JSON.stringify([{ content_id: a, index: ca.index }, { content_id: b, index: cb.index }]);
    const book = (await loadManifest(dir)).playbooks.find((e) => e.id === "ganhuo")!;
    const pb = await run("propose_promotion", { content_id: a, target: "playbook", genre: "ganhuo", text: `# 干货方法\n\n## 什么时候选它\n\n- 新骨架 v${book.current}\n`, note: "两篇都说要反转", cites });
    expect(pb).toMatchObject({ ok: true, target: "playbook", proposal_id: expect.stringMatching(/^pp-/) });
    await putExemplar({ id: "bench-toctou", genre: "ganhuo", kind: "exemplar", title: "TOCTOU", text: "# TOCTOU\n全文" }, dir);
    const ex = await run("propose_promotion", { content_id: a, target: "exemplar", exemplar_id: "bench-toctou", text: "[00:46] 改前 → 改后", note: "两篇都说要反转", cites });
    expect(ex).toMatchObject({ ok: true, outcome: "proposed" });
    const list = await listForChat(dir, {}) as { items: Array<{ item_id: string; gen: string; type: string; brief?: string }> };
    const item = list.items.find((i) => i.type === "writing_promotion")!;
    expect(item.brief).toContain("故事要有反转");
    expect(await chatDecide({ item_id: item.item_id, gen: item.gen, decision: "approve_promotion", founder_words: "你定", request_id: "r-1" }, dir)).toMatchObject({ ok: false, code: "founder_words_not_approval" });
    expect(await chatDecide({ item_id: item.item_id, gen: item.gen, decision: "approve_promotion", founder_words: "批", request_id: "r-2" }, dir)).toMatchObject({ ok: true, status: "approved_pending_manual_apply" });
    expect((await readPromotions(dir))[0]).toMatchObject({ status: "approved_pending_manual_apply", founder_words: "批" });
    expect(await fs.readFile(path.join(dir, "exemplars", "bench-toctou", "v1.md"), "utf8")).toBe("# TOCTOU\n全文");
  });
});
