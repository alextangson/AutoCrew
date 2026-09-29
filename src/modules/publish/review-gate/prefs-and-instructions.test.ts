/** 发布偏好（§3、E6）、指令留底（§6）、字幕底稿（§8、E9）、平台名词表（§4）的单元边界 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeEnv, videoContent, type Env } from "../../production/testkit.js";
import { contentRoot } from "../../../storage/content-project.js";
import { addPublishRule, decideProposal, pendingProposals, prefsVersion, proposePreference, readPublishPrefs, removePublishRule, setCoverRatios } from "./preferences.js";
import { INSTRUCTION_LINE_PREFIX, readInstruction, saveInstruction, splitInstruction } from "./instructions.js";
import { basisFromDraft, basisFromSrt } from "./subtitles.js";
import { platformsNamedIn, normalizePlatform } from "./platforms.js";
import { buildA, interpret } from "./semantic.js";

let env: Env;
beforeEach(async () => { env = await makeEnv(); });
afterEach(async () => { await env.cleanup(); });

describe("偏好：agent 提议、创始人确认才生效", () => {
  it("提议不改现行规则；确认写进 coverRatios，版本随之变；重复提议合并；已处理再点报冲突", async () => {
    const v0 = prefsVersion(await readPublishPrefs(env.dir));
    const a = await proposePreference({ kind: "cover_ratio", platform: "B站", value: ["4:3", "16:9"], founder_quote: "B站两种都传" }, "codex", env.dir);
    const again = await proposePreference({ kind: "cover_ratio", platform: "bilibili", value: "4:3, 16:9", founder_quote: "B站两种都传" }, "codex", env.dir);
    expect(a).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect((await readPublishPrefs(env.dir)).coverRatios).toEqual({});
    expect(await pendingProposals(env.dir)).toHaveLength(1);
    const id = (a as { proposal: { id: string } }).proposal.id;
    expect(await decideProposal(id, "confirm", env.dir)).toMatchObject({ ok: true });
    expect((await readPublishPrefs(env.dir)).coverRatios).toEqual({ bilibili: ["4:3", "16:9"] });
    expect(prefsVersion(await readPublishPrefs(env.dir))).not.toBe(v0);
    expect(await decideProposal(id, "dismiss", env.dir)).toMatchObject({ ok: false });
    expect(await pendingProposals(env.dir)).toHaveLength(0);
  });

  it("rule 提议确认后进 publishRules；「不要」不写；参数不对明确拒", async () => {
    const r = await proposePreference({ kind: "rule", value: "标题不要带表情", founder_quote: "标题别加表情了" }, "codex", env.dir);
    const d = await proposePreference({ kind: "rule", value: "别的", founder_quote: "x" }, "codex", env.dir);
    await decideProposal((r as { proposal: { id: string } }).proposal.id, "confirm", env.dir);
    await decideProposal((d as { proposal: { id: string } }).proposal.id, "dismiss", env.dir);
    expect((await readPublishPrefs(env.dir)).publishRules.map((x) => x.text)).toEqual(["标题不要带表情"]);
    expect(await proposePreference({ kind: "cover_ratio", value: ["3:4"], founder_quote: "x" }, "codex", env.dir)).toMatchObject({ ok: false, code: "platform_required" });
    expect(await proposePreference({ kind: "cover_ratio", platform: "douyin", value: ["竖"], founder_quote: "x" }, "codex", env.dir)).toMatchObject({ ok: false, code: "bad_value" });
    expect(await proposePreference({ kind: "rule", value: "x" }, "codex", env.dir)).toMatchObject({ ok: false, code: "quote_required" });
  });

  it("设置页直接改：比例、恢复默认、加删规则", async () => {
    expect(await setCoverRatios("小红书", "3:4, 4:3", env.dir)).toMatchObject({ ok: true, prefs: { coverRatios: { xiaohongshu: ["3:4", "4:3"] } } });
    expect(await setCoverRatios("xiaohongshu", [], env.dir)).toMatchObject({ ok: true, prefs: { coverRatios: {} } });
    expect(await setCoverRatios("快手", ["3:4"], env.dir)).toMatchObject({ ok: false });
    const added = await addPublishRule("抖音发布时间晚上 8 点", "抖音", env.dir);
    const rule = (added as { prefs: { publishRules: Array<{ id: string; platform: string }> } }).prefs.publishRules[0];
    expect(rule.platform).toBe("douyin");
    expect(await removePublishRule(rule.id, env.dir)).toMatchObject({ ok: true, prefs: { publishRules: [] } });
    expect(await removePublishRule("nope", env.dir)).toMatchObject({ ok: false });
  });
});

describe("指令留底（§6）", () => {
  it("存编辑后的文本，末行写编号；编辑框里残留的旧编号行不重复；按编号读回", async () => {
    const c = await videoContent(env, "一条稿");
    const first = await saveInstruction(c.id, "发布这条视频。\n平台：抖音", "copy", env.dir);
    if (!first.ok) throw new Error(first.error);
    expect(first.copy_text).toBe(`发布这条视频。\n平台：抖音\n${INSTRUCTION_LINE_PREFIX}${first.instruction.id}`);
    const second = await saveInstruction(c.id, `${first.copy_text}\n我改了一句`, "copy_open", env.dir);
    if (!second.ok) throw new Error(second.error);
    expect(second.instruction.text).toBe("发布这条视频。\n平台：抖音\n我改了一句");
    expect(second.instruction.via).toBe("copy_open");
    expect(await readInstruction(c.id, first.instruction.id, env.dir)).toMatchObject({ ok: true, instruction: { text: "发布这条视频。\n平台：抖音" } });
    const files = await fs.readdir(path.join(contentRoot(c.id, env.dir), "06-publish/instructions"));
    expect(files).toHaveLength(2);
  });

  it("编号格式不对 / 不属于这条 / 空文本 / 稿件不存在 → 明确拒", async () => {
    const c = await videoContent(env, "一条稿");
    const d = await videoContent(env, "另一条");
    const s = await saveInstruction(c.id, "x。", "copy", env.dir);
    if (!s.ok) throw new Error(s.error);
    expect(await readInstruction(d.id, s.instruction.id, env.dir)).toMatchObject({ ok: false, code: "instruction_not_found" });
    expect(await readInstruction(c.id, "../../x", env.dir)).toMatchObject({ ok: false, code: "bad_instruction_id" });
    expect(await saveInstruction(c.id, "  ", "copy", env.dir)).toMatchObject({ ok: false });
    expect(await saveInstruction(c.id, "x", "send", env.dir)).toMatchObject({ ok: false });
    expect(await saveInstruction("content-1-nosuch", "x", "copy", env.dir)).toMatchObject({ ok: false });
  });

  it("按句切，去掉编号行", () => {
    expect(splitInstruction(`发布这条视频。封面用 3:4！\n平台：抖音\n${INSTRUCTION_LINE_PREFIX}ins-1`)).toEqual(["发布这条视频。", "封面用 3:4！", "平台：抖音"]);
  });
});

describe("平台名词表（§4）", () => {
  it("中英文别名", () => {
    expect(platformsNamedIn("发抖音、小红书和 B站，视频号先不发")).toEqual(["douyin", "xiaohongshu", "bilibili", "wechat_video"]);
    expect(platformsNamedIn("post to Bilibili and XHS")).toEqual(["bilibili", "xiaohongshu"]);
    expect(normalizePlatform("视频号")).toBe("wechat_video");
    expect(normalizePlatform("kuaishou")).toBeNull();
  });
});

describe("字幕底稿（§8、E9）", () => {
  const cue = (i: number, text: string) => `${i}\n00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")},000 --> 00:${String(Math.floor((i + 1) / 60)).padStart(2, "0")}:${String((i + 1) % 60).padStart(2, "0")},000\n${text}`;
  it("超预算只比对前段并写明「只比对了前 N 分钟」；此时 A2 的「不支持」只算未覆盖", () => {
    const srt = Array.from({ length: 200 }, (_, i) => cue(i, `第 ${i} 句字幕内容`)).join("\n\n");
    const b = basisFromSrt(srt, 300);
    expect(b.truncated).toBe(true);
    expect(b.note).toMatch(/只比对了前 \d+ 分钟/);
    const { request } = buildA({ platform: "抖音", title: "效率提升 80%", caption: "", coverText: null, scriptTitle: "t", basis: b });
    const items = interpret(request!, { a1: { type: "choice", choice: "准确", probabilities: { 准确: 1 }, confidence: 1 }, a2_0: { type: "noul", noul: 0.1 } }, { basis: b });
    expect(items.find((i) => i.check === "A2 说法有据")).toMatchObject({ result: "unchecked" });
  });
  it("没有字幕用定稿正文并写明", () => {
    expect(basisFromDraft("正文").note).toContain("没有登记字幕，用定稿正文比对");
  });
});
