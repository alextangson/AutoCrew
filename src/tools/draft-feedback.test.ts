/**
 * 对话里的改稿意见也能被吸取（docs/2026-10-10-chat-feedback-learning-spec.md）：save 带 feedback、start 给判断材料、
 * prepare_final 列这篇攒下的待批规则。边界表逐条（1、2、3、4、9、10、11）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeDraft } from "./draft.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";
import { getContent } from "../storage/local-store.js";
import { loadProfile, ruleStatus, updateProfile, decideWritingRule } from "../modules/profile/creator-profile.js";
import { addWritingRule } from "../modules/profile/writing-rules.js";
import { addApprovedRuleForTest } from "../modules/profile/rule-fixtures.js";
import { vi } from "vitest";

/** 边界 9 用：让档案写入抛错（只在 failProfile 为真时） */
let failProfile = false;
vi.mock("../modules/profile/writing-rules.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../modules/profile/writing-rules.js")>();
  return { ...orig, addWritingRule: (...a: Parameters<typeof orig.addWritingRule>) => (failProfile ? Promise.reject(new Error("EACCES: disk full")) : orig.addWritingRule(...a)) };
});

let dir: string;
const BODY = "你是不是也觉得用了 AI 以后反而更忙了？我先说结论：省下来的时间，被你自己又填满了。可周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的时间写进日历，标成不许约会。";
const BODY2 = BODY.replace("我先说结论：", "") + "就这一件事。";
const ANGLE = {
  main_line: "AI 省下的时间会被你自己填满", for_whom: "职场人", opening: "你是不是也觉得更忙了？", why_viral: "没有数字",
  chain: ["更忙", "时间没消失", "被填满", "先占住"], founder_words: "就第二个",
};
const run = (action: string, args: Record<string, unknown> = {}) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });

/** 建稿、记立意、存第一版：返回 id 与当前版本号 */
async function firstVersion(): Promise<{ id: string; version: number }> {
  const s = await run("start", { inspiration: "用了 AI 反而更忙" });
  const id = s.content_id as string;
  const v = (s.progress as { version: number }).version;
  expect((await run("angle", { content_id: id, base_version: v, ...ANGLE })).ok).toBe(true);
  const saved = await run("save", { content_id: id, base_version: v, body: BODY });
  expect(saved.ok).toBe(true);
  return { id, version: saved.version as number };
}
const rules = async () => (await loadProfile(dir))!.writingRules;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-feedback-"));
  await updateProfile({ industry: "AI 实操", platforms: ["douyin"] }, dir);
  setQuoteFetch(async (url) => ({ finalUrl: url, title: "", text: "" }));
});
afterEach(async () => { failProfile = false; setQuoteFetch(undefined); await fs.rm(dir, { recursive: true, force: true }); });

describe("save feedback", () => {
  it("能推广的意见 new → 建待批规则（user_explicit、带出处原话与 origin），稿上记原话", async () => {
    const { id, version } = await firstVersion();
    const r = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "开头别先说结论", lessons: [{ rule: "开头不先抛结论，从一个具体瞬间说起", scope: "platform:douyin", relation: "new" }] } });
    expect(r).toMatchObject({ ok: true, lessons: [{ outcome: "created_pending" }] });
    const rule = (await rules()).find((x) => x.rule === "开头不先抛结论，从一个具体瞬间说起")!;
    expect(rule).toMatchObject({ status: "pending", source: "user_explicit", confidence: 1, scope: "platform:douyin", origin: { content_id: id, version: version + 1 } });
    expect(rule.evidence?.[0]).toBe(`稿件 ${id} 第 ${version + 1} 版 创始人原话：开头别先说结论`);
    const c = await getContent(id, dir);
    expect(c!.draftPath!.feedback).toEqual([expect.objectContaining({ version: version + 1, founder_words: "开头别先说结论", lessons: [{ rule_id: rule.id, outcome: "created_pending" }] })]);
  });

  it("边界 1：只针对这篇的意见 → 只记 draftPath.feedback，不建规则", async () => {
    const { id, version } = await firstVersion();
    const before = (await rules()).length;
    const r = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "第三句那个例子换掉" } });
    expect(r).toMatchObject({ ok: true, lessons: [] });
    expect((await rules()).length).toBe(before);
    expect((await getContent(id, dir))!.draftPath!.feedback).toHaveLength(1);
  });

  it("边界 2：和生效规则重复 → 原话追加为那条的出处，不新建、不动 status/revision；定稿时列进 repeated_rules", async () => {
    await addApprovedRuleForTest({ rule: "开头不铺垫", source: "manual", confidence: 1, scope: "voice_core" }, dir);
    const existing = (await rules()).find((x) => x.rule === "开头不铺垫")!;
    const { id, version } = await firstVersion();
    const r = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "又铺垫了", lessons: [{ rule: "开头别铺垫", scope: "voice_core", relation: "duplicate", relates_to: existing.id }] } });
    expect(r).toMatchObject({ ok: true, lessons: [{ outcome: "evidence_added", rule_id: existing.id }] });
    const after = (await rules()).find((x) => x.id === existing.id)!;
    expect(after).toMatchObject({ status: "active", revision: existing.revision });
    expect(after.evidence?.at(-1)).toContain("又铺垫了");
    expect((await rules()).some((x) => x.rule === "开头别铺垫")).toBe(false);
    const fin = await run("prepare_final", { content_id: id, base_version: version + 1, citations: [] });
    expect(fin).toMatchObject({ ok: true, repeated_rules: [{ id: existing.id, rule: "开头不铺垫" }], pending_lessons: [] });
  });

  it("边界 2 附：duplicate 的 relates_to 不存在 → 按 new 记，回执说明", async () => {
    const { id, version } = await firstVersion();
    const r = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "x", lessons: [{ rule: "结尾给一个能照做的动作", scope: "voice_core", relation: "duplicate", relates_to: "nope" }] } });
    expect(r).toMatchObject({ ok: true, lessons: [{ outcome: "created_pending", note: expect.stringContaining("nope") }] });
  });

  it("边界 3：和已有规则矛盾 → 待批规则带 conflictsWith；prepare_final 并排给出冲突规则原文与编号", async () => {
    await addApprovedRuleForTest({ rule: "开头先说结论", source: "manual", confidence: 1, scope: "platform:douyin" }, dir);
    const old = (await rules()).find((x) => x.rule === "开头先说结论")!;
    const { id, version } = await firstVersion();
    await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "别一上来就下结论", lessons: [{ rule: "开头先抛问题，结论放后面", scope: "platform:douyin", relation: "conflict", relates_to: old.id }] } });
    const pending = (await rules()).find((x) => x.rule === "开头先抛问题，结论放后面")!;
    expect(pending.conflictsWith).toBe(old.id);
    const fin = await run("prepare_final", { content_id: id, base_version: version + 1, citations: [] });
    expect(fin).toMatchObject({ ok: true, active_rule_count: 1, rule_cap: 12,
      pending_lessons: [{ number: 1, rule_id: pending.id, rule: "开头先抛问题，结论放后面", founder_words: "别一上来就下结论", conflicts_with: { id: old.id, rule: "开头先说结论" } }] });
    expect(String((fin.next_action as { note: string }).note)).toContain("pending_lessons");
  });

  it("边界 4：否决过的规则进 rejected_rules；一字不差再提 → blocked_by_tombstone", async () => {
    const added = await addWritingRule({ rule: "多用排比", source: "auto_distilled", confidence: 0.5 }, dir);
    const r0 = added.writingRules.find((x) => x.rule === "多用排比")!;
    await decideWritingRule({ ruleId: r0.id!, revision: r0.revision!, decision: "rejected", eventId: "evt-reject-1" }, dir);
    const s = await run("start", { inspiration: "另一篇" });
    expect((s.context as { profile: Record<string, unknown> }).profile).toMatchObject({ rejected_rules: ["多用排比"], pending_rules: [], rules_detail: [], active_rule_count: 0, rule_cap: 12 });
    const { id, version } = await firstVersion();
    const r = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "排比多一点", lessons: [{ rule: "多用排比", scope: "voice_core", relation: "new" }] } });
    expect(r).toMatchObject({ ok: true, lessons: [{ outcome: "blocked_by_tombstone" }] });
  });

  it("start 给 rules_detail（带 id）与 pending_rules，rules 仍是字符串数组", async () => {
    await addApprovedRuleForTest({ rule: "口语化", source: "manual", confidence: 1, scope: "voice_core" }, dir);
    await addWritingRule({ rule: "少用术语", source: "auto_distilled", confidence: 0.5 }, dir);
    const p = ((await run("start", { inspiration: "x" })).context as { profile: Record<string, unknown> }).profile;
    expect(p.rules).toEqual(["口语化"]);
    expect(p.rules_detail).toEqual([{ id: expect.any(String), scope: "voice_core", rule: "口语化" }]);
    expect(p.pending_rules).toEqual([{ id: expect.any(String), scope: "voice_core", rule: "少用术语" }]);
    expect(p.active_rule_count).toBe(1);
  });

  it("第一版不收 feedback（bad_param），什么都没存", async () => {
    const s = await run("start", { inspiration: "x" });
    const id = s.content_id as string, v = (s.progress as { version: number }).version;
    await run("angle", { content_id: id, base_version: v, ...ANGLE });
    const r = await run("save", { content_id: id, base_version: v, body: BODY, feedback: { founder_words: "x" } });
    expect(r).toMatchObject({ ok: false, code: "bad_param" });
    expect((await getContent(id, dir))!.body).toBe("");
  });

  it("边界 9：档案写失败 → 这一版已存，回执带原始错误 lessons_error", async () => {
    const { id, version } = await firstVersion();
    failProfile = true;
    const r = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "开头别先说结论", lessons: [{ rule: "开头不先抛结论", scope: "voice_core", relation: "new" }] } });
    failProfile = false;
    expect(r).toMatchObject({ ok: true, version: version + 1, lessons: [] });
    expect(String(r.lessons_error)).toContain("EACCES: disk full");
    expect((await getContent(id, dir))!.body).toBe(BODY2);
  });

  it("边界 10：字符串化 JSON / 引号坏了能修就修；修不了或 lessons 不是数组才拒（不当空数组）", async () => {
    const { id, version } = await firstVersion();
    const broken = '{"founder_words":"他说"别铺垫"","lessons":"[{\\"rule\\":\\"开头不铺垫\\",\\"scope\\":\\"voice_core\\",\\"relation\\":\\"new\\"}]"}';
    const ok = await run("save", { content_id: id, base_version: version, body: BODY2, feedback: broken });
    expect(ok).toMatchObject({ ok: true, lessons: [{ outcome: "created_pending" }] });
    const v = ok.version as number;
    expect(await run("save", { content_id: id, base_version: v, body: BODY, feedback: "{founder_words: ???" })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("save", { content_id: id, base_version: v, body: BODY, feedback: { founder_words: "x", lessons: { rule: "a" } } })).toMatchObject({ ok: false, code: "bad_param", error: expect.stringContaining("数组") });
    expect(await run("save", { content_id: id, base_version: v, body: BODY, feedback: { founder_words: "x", lessons: [{ rule: "a", relation: "conflict" }] } })).toMatchObject({ ok: false, code: "bad_param", error: expect.stringContaining("relates_to") });
    expect(await run("save", { content_id: id, base_version: v, body: BODY, feedback: { lessons: [] } })).toMatchObject({ ok: false, code: "bad_param" });
    expect((await getContent(id, dir))!.body).toBe(BODY2);
  });

  it("边界 11：不带 feedback 的 save 行为不变（无 lessons 字段、不碰档案、不记 feedback）", async () => {
    const { id, version } = await firstVersion();
    const before = JSON.stringify(await rules());
    const r = await run("save", { content_id: id, base_version: version, body: BODY2 });
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("lessons");
    expect(JSON.stringify(await rules())).toBe(before);
    expect((await getContent(id, dir))!.draftPath!.feedback).toBeUndefined();
  });

  it("边界 7：AI 误把一次性意见当长期规则 → 创始人否决后留墓碑", async () => {
    const { id, version } = await firstVersion();
    await run("save", { content_id: id, base_version: version, body: BODY2, feedback: { founder_words: "这篇结尾短一点", lessons: [{ rule: "结尾都要短", scope: "voice_core", relation: "new" }] } });
    const r = (await rules()).find((x) => x.rule === "结尾都要短")!;
    await decideWritingRule({ ruleId: r.id!, revision: r.revision!, decision: "rejected", eventId: "evt-reject-2" }, dir);
    expect(ruleStatus((await rules()).find((x) => x.id === r.id)!)).toBe("rejected");
    const again = await addWritingRule({ rule: "结尾都要短", source: "user_explicit", confidence: 1 }, dir);
    expect(again.lastRuleOutcome).toBe("blocked_by_tombstone");
  });

  it("Codex P2：正文没变的带意见 save → no_change，重放不会重复记原话和出处", async () => {
    const { id, version } = await firstVersion();
    const fb = { founder_words: "开头别铺垫", lessons: [{ rule: "开头不铺垫", scope: "voice_core", relation: "new" }] };
    expect(await run("save", { content_id: id, base_version: version, body: BODY, feedback: fb })).toMatchObject({ ok: false, code: "no_change" });
    expect((await getContent(id, dir))!.draftPath!.feedback).toBeUndefined();
    expect((await rules()).some((x) => x.rule === "开头不铺垫")).toBe(false);
  });

  it("Codex P2：rejected_rules 按否决时间取最近的", async () => {
    const add = async (t: string) => (await addWritingRule({ rule: t, source: "auto_distilled", confidence: 0.5 }, dir)).writingRules.find((x) => x.rule === t)!;
    const a = await add("早建的规则"), b = await add("晚建的规则");
    await decideWritingRule({ ruleId: b.id!, revision: b.revision!, decision: "rejected", eventId: "evt-rej-b" }, dir);
    await new Promise((r) => setTimeout(r, 5));
    await decideWritingRule({ ruleId: a.id!, revision: a.revision!, decision: "rejected", eventId: "evt-rej-a" }, dir);
    const p = ((await run("start", { inspiration: "x" })).context as { profile: Record<string, unknown> }).profile;
    expect(p.rejected_rules).toEqual(["晚建的规则", "早建的规则"]);
  });
});

