/**
 * 选题会闸口的验收清单（创始人 2026-10-04 规则 1–9）：每条绕过都被拒、豁免照常放行、
 * 读失败明确报错。各开写入口都在这里走一遍真闸口（不注入替身）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPlatformVariant, getContent, getTopic, listContents, listContentsStrict, listTopics, updateTopic,
} from "../../storage/local-store.js";
import { executeWorkflow } from "../../tools/workflow.js";
import { executeWriter } from "../../tools/writer.js";
import { executeGenerate } from "../../tools/generate.js";
import { executeContentSave } from "../../tools/content-save.js";
import { executeHumanize } from "../../tools/humanize.js";
import { startWriting } from "../../desktop/board-actions.js";
import { buildIpcHandlers } from "../../desktop/ipc.js";
import { buildChatTools } from "../../desktop/chat-router.js";
import { saveBrief, BRIEF_SCHEMA_VERSION, type AngleCardV3 } from "./brief-store.js";
import { topicHashOf, upsertJob } from "./research-job-store.js";
import { createCreativeTask } from "../writing/creative-task.js";
import { ANGLE_GATE_COPY, aiContentWriteRefusal, newDraftAngleRefusal } from "./angle-gate.js";
import { TEST_FOUNDER_WORDS, founderAuthored, founderStamped } from "./angle-gate.test-helper.js";
import { dropFixture, makeContent, makeFixture, makeTopic, type Fixture } from "../meetings/meeting-fixture.test-helper.js";

let f: Fixture;
beforeEach(async () => { f = await makeFixture(); });
afterEach(async () => { await dropFixture(f); });

const NEEDS = { ok: false, code: "needs_founder_angle", next_action: { skill: "topic-meeting", tool: "autocrew_workflow" } };

const CARD: AngleCardV3 = {
  cardVersion: 3, id: "angle-1", angle: "算一笔维护账", thesis: "省下的编码时间被维护成本吃回去了", evidenceLevel: "grounded",
  coreEvidenceIds: ["ev-1"], antiScope: "不写工具横评", hookDraft: "提效是真的，只是账没算完。", primaryPersona: "grow",
  misconception: "提效数字就是净收益", mechanism: "返工落回人身上", payoff: "把返工工时也记进去", nextAction: "记一次返工工时",
  counterResponse: "熟练组也没降", personaGains: { grow: "a", trust: "b", convert: "c" }, elements: [], evidenceNeeds: [],
  structure: "myth-busting", score: 4, whyMayPerform: "无数据依据",
};

/** 一份带 3 张卡的生效简报（选题会已出卡、还没人选） */
async function withCards(topicId: string, direction?: string) {
  const topic = (await getTopic(topicId, f.data))!;
  const hash = topicHashOf(topic.title, topic.description);
  const creativeTask = createCreativeTask({ platform: "douyin", direction });
  const cards = [CARD, { ...CARD, id: "angle-2", thesis: "工具省时但要另算审稿" }, { ...CARD, id: "angle-3", thesis: "第三种讲法" }];
  await saveBrief(topicId, {
    schemaVersion: BRIEF_SCHEMA_VERSION, summary: "s", perspectives: [], tensions: [], angleSuggestions: [], angleCards: cards,
    evidence: [{ claim: "c", quote: "q", sourceUrl: "https://example.com/r" }], assetPicks: [], missingPerspectives: [], gaps: [],
    generatedAt: "2026-10-04T00:00:00.000Z", revision: 1, topicHash: hash, ...(direction ? { creativeTask } : {}),
  }, f.data);
  await upsertJob({ topicId, status: "succeeded", startedAt: "2026-10-04T00:00:00.000Z", perspectives: [], briefRevision: 1, topicHash: hash, ...(direction ? { creativeTask } : {}) }, f.data);
}

describe("判定 newDraftAngleRefusal", () => {
  it("没开过选题会 → 拒；创始人原话选卡 / 自定角度 → 放行", async () => {
    const [a, b] = await Promise.all([makeTopic(f.data, "A"), makeTopic(f.data, "B")]);
    expect(await newDraftAngleRefusal(a.id, f.data)).toMatchObject({ ...NEEDS, error: ANGLE_GATE_COPY.noChoice });
    await founderAuthored(f.data, a.id);
    expect(await newDraftAngleRefusal(a.id, f.data)).toBeNull();
    await updateTopic(b.id, { selectedAngle: { briefRevision: 1, angleId: "angle-1", card: CARD, selectedAt: "2026-10-04T00:00:00.000Z" } }, f.data);
    expect(await newDraftAngleRefusal(b.id, f.data)).toMatchObject({ code: "needs_founder_angle", error: ANGLE_GATE_COPY.notFounderChoice });
    await founderStamped(f.data, b.id);
    expect(await newDraftAngleRefusal(b.id, f.data)).toBeNull();
  });

  it("自定角度之后选题文本改了 → 那句角度作废，重新拦", async () => {
    const t = await makeTopic(f.data, "A");
    await founderAuthored(f.data, t.id);
    await updateTopic(t.id, { title: "A 改了名" }, f.data);
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });

  it("没有选题的新稿 → 拒", async () => {
    expect(await newDraftAngleRefusal(undefined, f.data)).toMatchObject({ code: "needs_founder_angle", error: ANGLE_GATE_COPY.noTopic });
  });

  it("豁免：已有真稿的选题（存量稿）不查；空白/占位稿、归档稿不算真稿", async () => {
    const t = await makeTopic(f.data, "老题");
    await makeContent(f.data, "老题", { topicId: t.id }, "draft_ready");
    expect(await newDraftAngleRefusal(t.id, f.data)).toBeNull();
    const t2 = await makeTopic(f.data, "归档题");
    await makeContent(f.data, "归档题", { topicId: t2.id }, "archived");
    expect(await newDraftAngleRefusal(t2.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
    const t3 = await makeTopic(f.data, "占位题");
    await createPlatformVariant(t3.id, "douyin", undefined, f.data);
    expect(await newDraftAngleRefusal(t3.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });

  it("存储读失败 → angle_gate_read_failed：既不放行，也不当成「没定角度」", async () => {
    const legacy = await fs.mkdtemp(path.join(f.temp, "legacy-"));
    await fs.mkdir(path.join(legacy, "contents/content-broken"), { recursive: true });
    await fs.writeFile(path.join(legacy, "contents/content-broken/meta.json"), "{ 坏");
    const r = await newDraftAngleRefusal("topic-x", legacy);
    expect(r).toMatchObject({ ok: false, code: "angle_gate_read_failed" });
    expect(r?.error).toContain(ANGLE_GATE_COPY.readFailed);
  });

  it("旧版存储目录稿优先于同 id 的平铺旧副本（目录里是占位 → 仍算没稿）", async () => {
    const legacy = await fs.mkdtemp(path.join(f.temp, "legacy-dup-"));
    const base = { id: "content-1-dup", topicId: "topic-dup", title: "t", platform: "douyin", tags: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", versions: [] };
    await fs.mkdir(path.join(legacy, "contents/content-1-dup"), { recursive: true });
    await fs.writeFile(path.join(legacy, "contents/content-1-dup/meta.json"), JSON.stringify({ ...base, status: "topic_saved", body: "" }));
    await fs.writeFile(path.join(legacy, "contents/content-1-dup.json"), JSON.stringify({ ...base, status: "draft_ready", body: "旧副本正文" }));
    expect(await listContentsStrict(legacy)).toHaveLength(1);
    expect(await newDraftAngleRefusal("topic-dup", legacy)).not.toBeNull();
  });
});

describe("绕过一律被拒", () => {
  it("宿主自带 direction（没经创始人原话）→ pack / prepare 都不当成定了角度", async () => {
    const t = await makeTopic(f.data, "题");
    await withCards(t.id, "我替他想的角度");
    expect(await executeWriter({ action: "pack", topic_id: t.id, platform: "douyin", direction: "我替他想的角度", _dataDir: f.data }, { onWarn: () => {} }))
      .toMatchObject({ ok: false, gate: "needs_founder_angle" });
    expect(await executeWorkflow({ action: "prepare", topic_id: t.id, platform: "douyin", direction: "我替他想的角度", _dataDir: f.data }))
      .toMatchObject({ status: "needs_angle", note: ANGLE_GATE_COPY.bareDirection });
    expect(await listContents(f.data)).toHaveLength(0);
  });

  it("skip_reason / research_mode:skip → 明确拒绝", async () => {
    const t = await makeTopic(f.data, "题");
    await founderAuthored(f.data, t.id);
    for (const extra of [{ skip_reason: "他说直接写" }, { research_mode: "skip", research_reason: "本人日记" }]) {
      const r = await executeWorkflow({ action: "prepare", topic_id: t.id, platform: "douyin", ...extra, _dataDir: f.data });
      expect(r).toMatchObject({ ok: false, code: "skip_removed", error: ANGLE_GATE_COPY.skipRemoved });
    }
  });

  it("select_angle 不带创始人原话 → 拒；带原话 → 记成创始人选定（谁、原话、时间）", async () => {
    const t = await makeTopic(f.data, "题");
    await withCards(t.id);
    expect(await executeWorkflow({ action: "select_angle", topic_id: t.id, angle_id: "angle-2", brief_revision: 1, _dataDir: f.data }))
      .toMatchObject({ ok: false, code: "founder_words_required" });
    expect((await getTopic(t.id, f.data))?.selectedAngle).toBeUndefined();
    const ok = await executeWorkflow({ action: "select_angle", topic_id: t.id, angle_id: "angle-2", brief_revision: 1, founder_words: "第二张，审稿那条最戳我", _dataDir: f.data });
    expect(ok).toMatchObject({ ok: true, status: "ready_to_write" });
    expect((await getTopic(t.id, f.data))?.selectedAngle).toMatchObject({ angleId: "angle-2", chosenBy: "founder", founderWords: "第二张，审稿那条最戳我", selectedAt: expect.any(String) });
    expect(await newDraftAngleRefusal(t.id, f.data)).toBeNull();
  });

  it("创始人自定角度：select_angle{direction, founder_words} 记下，之后带同一句放行", async () => {
    const t = await makeTopic(f.data, "题");
    const r = await executeWorkflow({ action: "select_angle", topic_id: t.id, direction: "从我被返工的那一周讲", founder_words: "就写我那周的事", _dataDir: f.data });
    expect(r).toMatchObject({ ok: true, founder_angle: { direction: "从我被返工的那一周讲", founderWords: "就写我那周的事" } });
    expect(await newDraftAngleRefusal(t.id, f.data)).toBeNull();
    expect(await executeWorkflow({ action: "select_angle", topic_id: t.id, direction: "换个角度", _dataDir: f.data })).toMatchObject({ code: "founder_words_required" });
  });

  it("provided（自带材料）也要出卡 + 创始人定：没定就派宿主调研出卡，领包被拒", async () => {
    const t = await makeTopic(f.data, "题");
    const prep = await executeWorkflow({ action: "prepare", topic_id: t.id, platform: "douyin", research_mode: "provided", research: "我自己的笔记", _dataDir: f.data, _host: "claude" });
    expect(prep).toMatchObject({ ok: true, status: "awaiting_host_research", provided_material_note: expect.any(String) });
    expect(await executeWriter({ action: "pack", topic_id: t.id, platform: "douyin", research_mode: "provided", research: "我自己的笔记", _dataDir: f.data, _host: "claude" }, { onWarn: () => {} }))
      .toMatchObject({ ok: false });
    expect(await listContents(f.data)).toHaveLength(0);
  });

  it("只有一句灵感：prepare 自动建选题并开选题会", async () => {
    const r = await executeWorkflow({ action: "prepare", inspiration: "AI 写代码省下的时间去哪了", platform: "douyin", _dataDir: f.data, _host: "claude" });
    expect(r).toMatchObject({ ok: true, status: "awaiting_host_research", topic_id: expect.stringMatching(/^topic-/) });
    const topics = await listTopics(f.data);
    expect(topics).toEqual([expect.objectContaining({ title: "AI 写代码省下的时间去哪了", source: "inspiration" })]);
  });
});

describe("每个开写入口走同一判定", () => {
  it("workflow write(engine) / writer pack（含占位稿 content_id）/ generate（宿主与非宿主）", async () => {
    const t = await makeTopic(f.data, "没开会");
    const startGenerateScriptImpl = vi.fn();
    const generateScriptImpl = vi.fn();
    expect(await executeWorkflow({ action: "write", topic_id: t.id, platform: "douyin", execution: "engine", _dataDir: f.data }, { startGenerateScriptImpl, onWarn: () => {} })).toMatchObject({ ok: false });
    expect(await executeWriter({ action: "pack", topic_id: t.id, platform: "douyin", _dataDir: f.data }, { onWarn: () => {} })).toMatchObject({ ok: false, gate: "needs_founder_angle" });
    const placeholder = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    await executeContentSave({ action: "transition", id: placeholder.id, target_status: "drafting", force: true, _dataDir: f.data });
    expect(await executeWriter({ action: "pack", content_id: placeholder.id, platform: "douyin", force: true, _dataDir: f.data }, { onWarn: () => {} })).toMatchObject({ ok: false });
    expect(await executeGenerate({ action: "script", topic: t.title, topic_id: t.id, platform: "douyin", _dataDir: f.data }, { generateScriptImpl })).toMatchObject(NEEDS);
    expect(await executeGenerate({ action: "script", topic: t.title, topic_id: t.id, platform: "douyin", execution: "engine", _host: "claude", _dataDir: f.data }, { generateScriptImpl })).toMatchObject({ ok: false });
    expect(startGenerateScriptImpl).not.toHaveBeenCalled();
    expect(generateScriptImpl).not.toHaveBeenCalled();
    expect((await getContent(placeholder.id, f.data))?.pack).toBeUndefined();
  });

  it("看板「开始写」/ 桌面后台写稿 / 桌面重写空占位 / 聊天 generate_script", async () => {
    const t = await makeTopic(f.data, "没开会");
    const spawnImpl = vi.fn();
    expect(await startWriting(t.id, "douyin", f.data, { platform: "darwin", spawnImpl: spawnImpl as never })).toMatchObject(NEEDS);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(await buildIpcHandlers()["generate:script"]({ topic: t.title, platform: "douyin", topic_id: t.id, _dataDir: f.data })).toMatchObject(NEEDS);
    const placeholder = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    expect(await buildIpcHandlers()["generate:retry"]({ content_id: placeholder.id, _dataDir: f.data })).toMatchObject(NEEDS);
    const startGenerate = vi.fn();
    const retryGenerate = vi.fn();
    const chat = buildChatTools([], f.data, { startGenerate, retryGenerate, content: vi.fn(async () => ({ ok: true, contents: [{ id: placeholder.id, topicId: t.id, platform: "douyin", lastError: "断流" }] })) });
    const out = JSON.parse(await chat.find((x) => x.name === "generate_script")!.execute({ topic: t.title, platform: "douyin", topic_id: t.id }) as string);
    expect(out).toMatchObject(NEEDS);
    expect(startGenerate).not.toHaveBeenCalled();
    expect(retryGenerate).not.toHaveBeenCalled();
    expect((await listContents(f.data)).map((c) => c.id)).toEqual([placeholder.id]);
  });

  it("聊天 revise_draft / revise_focus 外的 adapt_platform、MCP 润色存回、后台改稿：动占位稿一律过闸口", async () => {
    const t = await makeTopic(f.data, "没开会");
    const placeholder = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    const reviseDraftImpl = vi.fn();
    const rewrite = vi.fn();
    const chat = buildChatTools([], f.data, { reviseDraftImpl, rewrite });
    expect(JSON.parse(await chat.find((x) => x.name === "revise_draft")!.execute({ content_id: placeholder.id, instruction: "写成正文" }) as string)).toMatchObject(NEEDS);
    expect(JSON.parse(await chat.find((x) => x.name === "adapt_platform")!.execute({ content_id: placeholder.id, target_platform: "xiaohongshu" }) as string)).toMatchObject(NEEDS);
    expect(reviseDraftImpl).not.toHaveBeenCalled();
    expect(rewrite).not.toHaveBeenCalled();
    expect(await executeHumanize({ action: "humanize_zh", content_id: placeholder.id, save_back: true, _dataDir: f.data, _host: "claude" })).toMatchObject(NEEDS);
    expect(await aiContentWriteRefusal(placeholder.id, f.data)).toMatchObject(NEEDS);
    expect((await getContent(placeholder.id, f.data))?.body).toBe(placeholder.body);
  });

  it("content：create_variant 开第一篇 / 非导入新建 / 模型（_host 或 OpenClaw _modelCall）填占位正文 → 拒", async () => {
    const t = await makeTopic(f.data, "没开会");
    expect(await executeContentSave({ action: "create_variant", topicId: t.id, platform: "douyin", _dataDir: f.data })).toMatchObject(NEEDS);
    expect(await executeContentSave({ action: "save", title: "直接存", body: "正文", topicId: t.id, status: "drafting", _dataDir: f.data })).toMatchObject(NEEDS);
    expect(await executeContentSave({ action: "save", title: "模型直接存", body: "正文", _dataDir: f.data, _modelCall: true })).toMatchObject({ ok: false, code: "writer_submission_required" });
    const placeholder = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    for (const marker of [{ _host: "claude" }, { _modelCall: true }]) {
      expect(await executeContentSave({ action: "update", id: placeholder.id, body: "模型填的正文", _dataDir: f.data, ...marker })).toMatchObject({ ok: false, code: "writer_submission_required" });
    }
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });

  it("占位行被 transition 或 update 改成 drafting 也解锁不了（判定看正文，不看状态）", async () => {
    const t = await makeTopic(f.data, "没开会");
    const ph = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    await executeContentSave({ action: "transition", id: ph.id, target_status: "drafting", force: true, _dataDir: f.data });
    expect((await getContent(ph.id, f.data))?.status).toBe("drafting");
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });
});

describe("豁免照常放行", () => {
  it("已有真稿：改稿重领包、真稿的平台变体、手动导入成稿、人手编辑", async () => {
    const t = await makeTopic(f.data, "老题");
    const c = await makeContent(f.data, "老题", { topicId: t.id }, "draft_ready");
    expect(await executeWriter({ action: "pack", content_id: c.id, platform: "douyin", force: true, research_mode: "provided", research: "补的材料", _dataDir: f.data }, { onWarn: () => {} }))
      .not.toMatchObject({ code: "needs_founder_angle" });
    expect(await executeContentSave({ action: "create_variant", topicId: t.id, platform: "xiaohongshu", _dataDir: f.data })).toMatchObject({ ok: true });
    const fresh = await makeTopic(f.data, "新题没开会");
    expect(await executeContentSave({ action: "save", title: "我自己写好的", body: "成稿正文。", topicId: fresh.id, source: "manual_import", import_reason: "用户给的旧稿", _dataDir: f.data, _host: "claude" })).toMatchObject({ ok: true });
    expect(await executeContentSave({ action: "create_variant", topicId: (await makeTopic(f.data, "导入题")).id, platform: "douyin", body: "用户自己的成稿", source: "manual_import", import_reason: "用户给的旧稿", _dataDir: f.data, _host: "claude" })).toMatchObject({ ok: true });
    const ph = (await createPlatformVariant((await makeTopic(f.data, "人手题")).id, "douyin", undefined, f.data)).content!;
    expect(await executeContentSave({ action: "update", id: ph.id, body: "创始人自己在编辑器里写的", _dataDir: f.data })).toMatchObject({ ok: true });
  });

  it("content update 不能把稿改挂到别的选题", async () => {
    const [a, b] = await Promise.all([makeTopic(f.data, "A"), makeTopic(f.data, "B")]);
    const c = await makeContent(f.data, "A 稿", { topicId: a.id }, "draft_ready");
    await executeContentSave({ action: "update", id: c.id, topicId: b.id, topic_id: b.id, title: "A 稿改名", _dataDir: f.data });
    await executeContentSave({ action: "update", id: c.id, topicId: b.id, topic_id: b.id, _dataDir: f.data, _host: "claude" });
    expect((await getContent(c.id, f.data))?.topicId).toBe(a.id);
    expect(await newDraftAngleRefusal(b.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });

  it("创始人定了角度 → 看板开始写放行并建稿", async () => {
    const t = await makeTopic(f.data, "开过会");
    await founderAuthored(f.data, t.id);
    const r = await startWriting(t.id, "douyin", f.data, { platform: "linux" });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(TEST_FOUNDER_WORDS).toBeTruthy();
  });
});
