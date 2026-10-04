/**
 * 选题会闸口的验收清单（创始人 2026-10-04 规则 1–9）：每条绕过都被拒、豁免照常放行、
 * 读失败明确报错。各开写入口都在这里走一遍真闸口（不注入替身）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPlatformVariant, getContent, getTopic, listContents, listContentsStrict, listTopics, updateTopic, saveContent, updateContent,
} from "../../storage/local-store.js";
import { executeWorkflow } from "../../tools/workflow.js";
import { executeWriter } from "../../tools/writer.js";
import { executeGenerate } from "../../tools/generate.js";
import { executeContentSave } from "../../tools/content-save.js";
import { executeHumanize } from "../../tools/humanize.js";
import { executeHostRewrite, executeRewrite } from "../../tools/rewrite.js";
import { FirstBodyRefusedError, HUMAN_WRITE, modelWrite } from "../../storage/first-body-guard.js";
import { startWriting } from "../../desktop/board-actions.js";
import { buildIpcHandlers } from "../../desktop/ipc.js";
import { buildChatTools } from "../../desktop/chat-router.js";
import { saveBrief, BRIEF_SCHEMA_VERSION, type AngleCardV3 } from "./brief-store.js";
import { topicHashOf, upsertJob } from "./research-job-store.js";
import { createCreativeTask } from "../writing/creative-task.js";
import { ANGLE_GATE_COPY, aiContentWriteRefusal, newDraftAngleRefusal, recordFounderAngle } from "./angle-gate.js";
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
    await withCards(b.id);
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

  it("创始人选的卡过期（选题文本改了 / 生效简报重跑换了版）→ 拒，提示重新定", async () => {
    const t = await makeTopic(f.data, "题");
    await withCards(t.id);
    await updateTopic(t.id, { selectedAngle: { briefRevision: 1, angleId: "angle-1", card: CARD, selectedAt: "2026-10-04T00:00:00.000Z", chosenBy: "founder", founderWords: "就这张" } }, f.data);
    expect(await newDraftAngleRefusal(t.id, f.data)).toBeNull();
    const topic = (await getTopic(t.id, f.data))!;
    await upsertJob({ topicId: t.id, status: "succeeded", startedAt: "2026-10-05T00:00:00.000Z", perspectives: [], briefRevision: 2, topicHash: topicHashOf(topic.title, topic.description) }, f.data);
    await saveBrief(t.id, { ...(await import("./brief-store.js").then((m) => m.loadBrief(t.id, 1, f.data)))!, revision: 2 }, f.data);
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle", error: ANGLE_GATE_COPY.staleChoice });
    const t2 = await makeTopic(f.data, "题2");
    await withCards(t2.id);
    await updateTopic(t2.id, { selectedAngle: { briefRevision: 1, angleId: "angle-1", card: CARD, selectedAt: "2026-10-04T00:00:00.000Z", chosenBy: "founder", founderWords: "就这张" } }, f.data);
    await updateTopic(t2.id, { title: "题2 改了名" }, f.data);
    expect(await newDraftAngleRefusal(t2.id, f.data)).toMatchObject({ code: "needs_founder_angle", error: ANGLE_GATE_COPY.staleChoice });
  });

  it("选题记录读坏 → angle_gate_read_failed，不当成「没定角度」", async () => {
    const t = await makeTopic(f.data, "题");
    await fs.writeFile(path.join(f.data, "topics", `${t.id}.json`), "{ 坏");
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ ok: false, code: "angle_gate_read_failed" });
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
    await executeContentSave({ _provenance: HUMAN_WRITE, action: "transition", id: placeholder.id, target_status: "drafting", force: true, _dataDir: f.data });
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

  it("content：模型 create_variant 开第一篇 / 模型非导入新建 / 模型（_host 或 OpenClaw _modelCall）填占位正文 → 拒", async () => {
    const t = await makeTopic(f.data, "没开会");
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "create_variant", topicId: t.id, platform: "douyin", _dataDir: f.data, _modelCall: true })).toMatchObject(NEEDS);
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "save", title: "直接存", body: "正文", topicId: t.id, status: "drafting", _dataDir: f.data, _host: "claude" })).toMatchObject({ ok: false, code: "writer_submission_required" });
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "save", title: "模型直接存", body: "正文", _dataDir: f.data, _modelCall: true })).toMatchObject({ ok: false, code: "writer_submission_required" });
    const placeholder = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    for (const marker of [{ _host: "claude" }, { _modelCall: true }]) {
      expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "update", id: placeholder.id, body: "模型填的正文", _dataDir: f.data, ...marker })).toMatchObject({ ok: false, code: "writer_submission_required" });
    }
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });

  it("交稿也过闸口：领包后创始人撤了选择 → 第一份正文交不进去", async () => {
    const t = await makeTopic(f.data, "撤回题");
    await founderAuthored(f.data, t.id, "我自己的角度");
    const packed = await executeWriter({ action: "pack", topic_id: t.id, platform: "douyin", research_mode: "provided", research: "我的笔记", direction: "我自己的角度", _dataDir: f.data, _host: "claude" }, { onWarn: () => {} });
    expect(packed).toMatchObject({ ok: true, status: "ready" });
    await updateTopic(t.id, { founderAngle: undefined }, f.data);
    const submitted = await executeWriter({ action: "submit", content_id: packed.content_id, pack_id: packed.pack_id, claim_token: packed.claim_token, attempt: 1,
      title: "标题", body: "正文第一段。\n\n正文第二段。", hashtags: [], review: "none", _dataDir: f.data, _host: "claude" }, { onWarn: () => {} });
    expect(submitted).toMatchObject(NEEDS);
    expect((await getContent(packed.content_id as string, f.data))?.body ?? "").toBe("");
  });

  it("占位行被 transition 或 update 改成 drafting 也解锁不了（判定看正文，不看状态）", async () => {
    const t = await makeTopic(f.data, "没开会");
    const ph = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    await executeContentSave({ _provenance: HUMAN_WRITE, action: "transition", id: ph.id, target_status: "drafting", force: true, _dataDir: f.data });
    expect((await getContent(ph.id, f.data))?.status).toBe("drafting");
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });
});

describe("豁免照常放行", () => {
  it("人手（不带模型标记）给新选题存正文 / 建变体：不用标 manual_import，也不过闸口", async () => {
    const t = await makeTopic(f.data, "人手新题");
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "save", title: "我自己写的", body: "创始人自己写的正文", topicId: t.id, _dataDir: f.data })).toMatchObject({ ok: true });
    const t2 = await makeTopic(f.data, "人手新题2");
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "create_variant", topicId: t2.id, platform: "douyin", body: "人手正文", _dataDir: f.data })).toMatchObject({ ok: true });
  });

  it("已有真稿：改稿重领包、真稿的平台变体、手动导入成稿、人手编辑", async () => {
    const t = await makeTopic(f.data, "老题");
    const c = await makeContent(f.data, "老题", { topicId: t.id }, "draft_ready");
    expect(await executeWriter({ action: "pack", content_id: c.id, platform: "douyin", force: true, research_mode: "provided", research: "补的材料", _dataDir: f.data }, { onWarn: () => {} }))
      .not.toMatchObject({ code: "needs_founder_angle" });
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "create_variant", topicId: t.id, platform: "xiaohongshu", _dataDir: f.data })).toMatchObject({ ok: true });
    const fresh = await makeTopic(f.data, "新题没开会");
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "save", title: "我自己写好的", body: "成稿正文。", topicId: fresh.id, source: "manual_import", import_reason: "用户给的旧稿", _dataDir: f.data, _host: "claude" })).toMatchObject({ ok: true });
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "create_variant", topicId: (await makeTopic(f.data, "导入题")).id, platform: "douyin", body: "用户自己的成稿", source: "manual_import", import_reason: "用户给的旧稿", _dataDir: f.data, _host: "claude" })).toMatchObject({ ok: true });
    const ph = (await createPlatformVariant((await makeTopic(f.data, "人手题")).id, "douyin", undefined, f.data)).content!;
    expect(await executeContentSave({ _provenance: HUMAN_WRITE, action: "update", id: ph.id, body: "创始人自己在编辑器里写的", _dataDir: f.data })).toMatchObject({ ok: true });
  });

  it("content update 不能把稿改挂到别的选题", async () => {
    const [a, b] = await Promise.all([makeTopic(f.data, "A"), makeTopic(f.data, "B")]);
    const c = await makeContent(f.data, "A 稿", { topicId: a.id }, "draft_ready");
    await executeContentSave({ _provenance: HUMAN_WRITE, action: "update", id: c.id, topicId: b.id, topic_id: b.id, title: "A 稿改名", _dataDir: f.data });
    await executeContentSave({ _provenance: HUMAN_WRITE, action: "update", id: c.id, topicId: b.id, topic_id: b.id, _dataDir: f.data, _host: "claude" });
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

describe("存储层唯一卡口（第一份真正文）", () => {
  it("绕过所有入口直接写存储：模型来源没定角度 → 拒；来源不明 → 拒；人手 / 导入 → 放行", async () => {
    const t = await makeTopic(f.data, "直写题");
    await expect(saveContent({ _provenance: HUMAN_WRITE, title: "模型直写", body: "正文", topicId: t.id, status: "drafting", tags: [], _provenance: modelWrite("claude") }, f.data))
      .rejects.toMatchObject({ refusal: { code: "needs_founder_angle" } });
    await expect(saveContent({ title: "没标来源", body: "正文", topicId: t.id, status: "drafting", tags: [] }, f.data))
      .rejects.toMatchObject({ refusal: { code: "unknown_write_provenance" } });
    const ph = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    await expect(updateContent(ph.id, { _provenance: HUMAN_WRITE, body: "模型填实", _provenance: modelWrite() }, f.data)).rejects.toBeInstanceOf(FirstBodyRefusedError);
    await expect(updateContent(ph.id, { body: "没标来源填实" }, f.data)).rejects.toMatchObject({ refusal: { code: "unknown_write_provenance" } });
    expect((await getContent(ph.id, f.data))?.body).toBe(ph.body);
    expect(await updateContent(ph.id, { _provenance: HUMAN_WRITE, body: "创始人自己写的", _provenance: HUMAN_WRITE }, f.data)).toMatchObject({ body: "创始人自己写的" });
    // 已经是真稿 → 先于一切来源判定放行（来源不明的改稿、回滚照常）
    expect(await updateContent(ph.id, { body: "再改一版" }, f.data)).toMatchObject({ body: "再改一版" });
    // 没挂选题也一样：来源不明 → 拒
    await expect(saveContent({ title: "没挂选题没标来源", body: "正文", status: "drafting", tags: [] }, f.data)).rejects.toMatchObject({ refusal: { code: "unknown_write_provenance" } });
    // 没挂选题：模型写拒，人手放行
    await expect(saveContent({ _provenance: HUMAN_WRITE, title: "模型裸写", body: "正文", status: "drafting", tags: [], _provenance: modelWrite() }, f.data)).rejects.toBeInstanceOf(FirstBodyRefusedError);
    expect(await saveContent({ _provenance: HUMAN_WRITE, title: "人手裸写", body: "正文", status: "drafting", tags: [], _provenance: HUMAN_WRITE }, f.data)).toMatchObject({ title: "人手裸写" });
  });

  it("模型来源 + 创始人定过且仍作数的角度 → 放行", async () => {
    const t = await makeTopic(f.data, "定过题");
    await founderAuthored(f.data, t.id);
    expect(await saveContent({ _provenance: HUMAN_WRITE, title: "模型写", body: "正文", topicId: t.id, status: "drafting", tags: [], _provenance: modelWrite() }, f.data)).toMatchObject({ topicId: t.id });
  });

  it("平台改写（autocrew_rewrite / batch_adapt）从占位稿起步 → 准入就拒，不调模型", async () => {
    const t = await makeTopic(f.data, "改写题");
    const ph = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    for (const action of ["adapt_platform", "batch_adapt"]) {
      const r = await executeRewrite({ action, content_id: ph.id, target_platform: "xiaohongshu", target_platforms: ["xiaohongshu"], _dataDir: f.data, _modelCall: true });
      expect(r, action).toMatchObject(NEEDS);
    }
    expect(await executeHostRewrite({ action: "adapt_platform", content_id: ph.id, target_platform: "xiaohongshu", execution: "engine", _dataDir: f.data, _host: "claude" })).toMatchObject(NEEDS);
    expect(await executeRewrite({ action: "adapt_platform", title: "裸标题", body: "裸正文", target_platform: "xiaohongshu", save_as_draft: true, _dataDir: f.data, _modelCall: true })).toMatchObject(NEEDS);
  });
});

describe("只认创始人最近一次角度决定", () => {
  it("自定角度之后改选卡 → 自定角度作废；撤回 → 两样都清", async () => {
    const t = await makeTopic(f.data, "改主意题");
    await withCards(t.id);
    await executeWorkflow({ action: "select_angle", topic_id: t.id, direction: "我先想的角度", founder_words: "先这么写", _dataDir: f.data });
    await executeWorkflow({ action: "select_angle", topic_id: t.id, angle_id: "angle-2", brief_revision: 1, founder_words: "还是第二张", _dataDir: f.data });
    const after = (await getTopic(t.id, f.data))!;
    expect(after.founderAngle).toBeUndefined();
    expect(after.selectedAngle).toMatchObject({ angleId: "angle-2", chosenBy: "founder" });
    // 卡后来过期了，不能退回去拿之前那句自定角度当放行理由
    await updateTopic(t.id, { title: "改主意题（改名）" }, f.data);
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
    const t2 = await makeTopic(f.data, "撤回题");
    await founderAuthored(f.data, t2.id);
    expect(await buildIpcHandlers()["topic:clear_angle"]({ topic_id: t2.id, _dataDir: f.data })).toMatchObject({ ok: true });
    expect(await newDraftAngleRefusal(t2.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });

  it("旧数据两样都在：按时间取最新的那次（旧的自定角度不能盖过新选的、已过期的卡）", async () => {
    const t = await makeTopic(f.data, "旧数据题");
    await withCards(t.id);
    await founderAuthored(f.data, t.id);
    await updateTopic(t.id, { selectedAngle: { briefRevision: 9, angleId: "angle-1", card: CARD, selectedAt: "2099-01-01T00:00:00.000Z", chosenBy: "founder", founderWords: "后来选的" } }, f.data);
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle", error: ANGLE_GATE_COPY.staleChoice });
  });
});

describe("严格读取", () => {
  it("旧版存储里稿件 meta 读坏：aiContentWriteRefusal 报读失败，不退回平铺旧副本、不当成「没有这篇」", async () => {
    const legacy = await fs.mkdtemp(path.join(f.temp, "legacy-meta-"));
    const id = "content-1700000000000-broken";
    await fs.mkdir(path.join(legacy, "contents", id), { recursive: true });
    await fs.writeFile(path.join(legacy, "contents", id, "meta.json"), "{ 坏");
    await fs.writeFile(path.join(legacy, "contents", `${id}.json`), JSON.stringify({ id, title: "旧副本", body: "旧副本有正文", status: "draft_ready", tags: [], versions: [], createdAt: "2026-01-01" }));
    expect(await aiContentWriteRefusal(id, legacy)).toMatchObject({ code: "angle_gate_read_failed" });
  });

  it("简报 / 台账读坏：创始人选的卡判不了新旧 → 报读失败，不冒充「选择过期」", async () => {
    const t = await makeTopic(f.data, "简报坏题");
    await withCards(t.id);
    await updateTopic(t.id, { selectedAngle: { briefRevision: 1, angleId: "angle-1", card: CARD, selectedAt: new Date().toISOString(), chosenBy: "founder", founderWords: "就这张" } }, f.data);
    const briefFile = (await fs.readdir(path.join(f.data, "research"), { recursive: true }) as string[]).find((p) => /brief.*v?1.*\.json$|\/1\.json$/.test(p) && p.includes(t.id));
    expect(briefFile).toBeTruthy();
    await fs.writeFile(path.join(f.data, "research", briefFile!), "{ 坏");
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "angle_gate_read_failed" });
  });
});

describe("存量稿修订不受新规则影响（创始人 backlog）", () => {
  it("0927 导入稿式记录：provided、真正文、没有选卡也没有原话 → pack{content_id, force} → submit 照常", async () => {
    const t = await makeTopic(f.data, "导入修订题");
    const c = await makeContent(f.data, "导入修订题", { topicId: t.id, genRequest: { topic: "导入修订题", platform: "douyin", researchMode: "provided", research: "原稿材料" } as never }, "draft_ready");
    const packed = await executeWriter({ action: "pack", content_id: c.id, platform: "douyin", force: true, research_mode: "provided", research: "原稿材料", requirements: "按反馈改短", _dataDir: f.data, _host: "claude" }, { onWarn: () => {} });
    expect(packed).toMatchObject({ ok: true, status: "ready" });
    const submitted = await executeWriter({ action: "submit", content_id: c.id, pack_id: packed.pack_id, claim_token: packed.claim_token, attempt: 1,
      title: "导入修订题", body: "改短后的第一段。\n\n改短后的第二段。", hashtags: [], review: "none", _dataDir: f.data, _host: "claude",
      outline: { thesis: "改短", points: [{ text: "第一段", kind: "case", seconds: 20 }], structure: { opening: "开头", progression: "推进", ending: "结尾" }, said: [{ id: "a", kind: "concept", text: "第一段" }] } }, { onWarn: () => {} });
    expect(submitted).toMatchObject({ saved: true });
    expect((await getContent(c.id, f.data))?.body).toContain("改短后的第一段");
  });

  it("旧 skip 路径建的真稿：带着 skip 元数据重领包修订照常（不被「跳过已关闭」卡死）", async () => {
    const t = await makeTopic(f.data, "旧skip题");
    const c = await makeContent(f.data, "旧skip题", { topicId: t.id }, "draft_ready");
    const packed = await executeWriter({ action: "pack", content_id: c.id, platform: "douyin", force: true, research_mode: "skip", research_reason: "本人日记", skip_reason: "当时说直接写", _dataDir: f.data, _host: "claude" }, { onWarn: () => {} });
    expect(packed).toMatchObject({ ok: true, status: "ready" });
  });

  it("创始人原话出现之前选卡的 auto 稿：修订照常", async () => {
    const t = await makeTopic(f.data, "旧选卡题");
    await withCards(t.id);
    await updateTopic(t.id, { selectedAngle: { briefRevision: 1, angleId: "angle-1", card: CARD, selectedAt: "2026-09-20T00:00:00.000Z" } }, f.data);
    const c = await makeContent(f.data, "旧选卡题", { topicId: t.id }, "draft_ready");
    const packed = await executeWriter({ action: "pack", content_id: c.id, platform: "douyin", force: true, _dataDir: f.data, _host: "claude" }, { onWarn: () => {} });
    expect(packed).toMatchObject({ ok: true, status: "ready" });
  });
});

describe("聊天：存量稿先判豁免", () => {
  it("已有真稿的选题：带 direction / skip_reason、不带原话也能重写；中断稿照常原地重写", async () => {
    const t = await makeTopic(f.data, "存量题");
    const real = await makeContent(f.data, "存量题", { topicId: t.id }, "draft_ready");
    const startGenerate = vi.fn(async () => ({ contentId: "c-new", runId: "r", completion: Promise.resolve() }));
    const chat = buildChatTools([], f.data, { startGenerate, content: vi.fn(async () => ({ ok: true, contents: [] })) });
    const exec = (args: Record<string, unknown>) => chat.find((x) => x.name === "generate_script")!.execute(args) as Promise<string>;
    expect(JSON.parse(await exec({ topic: t.title, platform: "douyin", topic_id: t.id, direction: "换个讲法", skip_reason: "旧习惯" }))).toMatchObject({ ok: true, pending: true });
    const retryGenerate = vi.fn(async () => ({ contentId: real.id, runId: "r2", completion: Promise.resolve() }));
    const retryChat = buildChatTools([], f.data, { retryGenerate, content: vi.fn(async () => ({ ok: true, contents: [{ id: real.id, topicId: t.id, platform: "douyin", lastError: "断流" }] })) });
    expect(JSON.parse(await retryChat.find((x) => x.name === "generate_script")!.execute({ topic: t.title, platform: "douyin", topic_id: t.id, direction: "换个讲法" }) as string))
      .toMatchObject({ ok: true, pending: true, contentId: real.id });
  });
});

describe("第六轮：来源显式 + 严格读", () => {
  it("桌面令牌调 content:update 填占位稿 → 按模型算、没定角度被拒；浏览器会话里人改 → 放行", async () => {
    const t = await makeTopic(f.data, "令牌填稿题");
    const ph = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    const update = buildIpcHandlers()["content:update"];
    expect(await update({ id: ph.id, body: "令牌塞进来的正文", _dataDir: f.data }, { authMethod: "bearer" })).toMatchObject({ ok: false, code: "needs_founder_angle" });
    expect(await update({ id: ph.id, body: "没有认证上下文", _dataDir: f.data })).toMatchObject({ ok: false, code: "needs_founder_angle" });
    expect((await getContent(ph.id, f.data))?.body).toBe(ph.body);
    expect(await update({ id: ph.id, body: "创始人在编辑器里写的", _dataDir: f.data }, { authMethod: "session" })).toMatchObject({ ok: true });
  });

  it("调研台账最新一行损坏 → 不让旧记录复活：angle_gate_read_failed", async () => {
    const t = await makeTopic(f.data, "台账坏题");
    await withCards(t.id);
    await updateTopic(t.id, { selectedAngle: { briefRevision: 1, angleId: "angle-1", card: CARD, selectedAt: new Date().toISOString(), chosenBy: "founder", founderWords: "就这张" } }, f.data);
    expect(await newDraftAngleRefusal(t.id, f.data)).toBeNull();
    const journal = (await fs.readdir(path.join(f.data, "research"))).find((n) => n.endsWith(".jsonl"))!;
    await fs.appendFile(path.join(f.data, "research", journal), `{"topicId":"${t.id}","briefRevision":2,`);
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "angle_gate_read_failed" });
  });

  it("模型由一篇没挂选题的真稿改写出新稿：凭可核验的源稿放行；源稿是占位就拒", async () => {
    const source = await saveContent({ _provenance: HUMAN_WRITE, title: "裸真稿", body: "真正文", status: "draft_ready", tags: [] }, f.data);
    expect(await saveContent({ title: "适配稿", body: "适配后的正文", status: "draft", tags: [], _provenance: { kind: "model", derivedFrom: source.id } }, f.data)).toMatchObject({ title: "适配稿" });
    const t = await makeTopic(f.data, "占位源题");
    const ph = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    await expect(saveContent({ title: "占位改写", body: "正文", status: "draft", tags: [], _provenance: { kind: "model", derivedFrom: ph.id } }, f.data)).rejects.toBeInstanceOf(FirstBodyRefusedError);
  });

  it("存量稿带旧 skip 参数 prepare → 不报 skip_removed；brief 没卡 + 旧 skip_reason 的存量 auto 稿 → 照常就绪", async () => {
    const t = await makeTopic(f.data, "存量skip题");
    await makeContent(f.data, "存量skip题", { topicId: t.id }, "draft_ready");
    const prep = await executeWorkflow({ action: "prepare", topic_id: t.id, platform: "douyin", research_mode: "skip", research_reason: "本人日记", skip_reason: "直接写", _dataDir: f.data, _host: "claude" });
    expect(prep).not.toMatchObject({ code: "skip_removed" });
    const t2 = await makeTopic(f.data, "存量无卡题");
    const topic2 = (await getTopic(t2.id, f.data))!;
    const hash = topicHashOf(topic2.title, topic2.description);
    await saveBrief(t2.id, { schemaVersion: BRIEF_SCHEMA_VERSION, summary: "s", perspectives: [], tensions: [], angleSuggestions: [], angleCards: [], evidence: [], assetPicks: [], missingPerspectives: [], gaps: [], generatedAt: "2026-10-01T00:00:00.000Z", revision: 1, topicHash: hash }, f.data);
    await upsertJob({ topicId: t2.id, status: "succeeded", startedAt: "2026-10-01T00:00:00.000Z", perspectives: [], briefRevision: 1, topicHash: hash }, f.data);
    await makeContent(f.data, "存量无卡题", { topicId: t2.id }, "draft_ready");
    const { inspectWritingReadiness } = await import("../../tools/writing-readiness.js");
    expect(await inspectWritingReadiness(t2.id, { platform: "douyin", angleSkipReason: "当时说直接写" }, f.data)).toMatchObject({ ready: true });
  });
});

describe("账号数据视角：发布计划读坏", () => {
  it("某篇 06-publish/publish-plan.json 解析不了 → 账号数据记失败，不冒充数据齐了", async () => {
    const { buildAccountData } = await import("../../tools/scout-parallel.js");
    const { writePlan } = await import("../meetings/meeting-fixture.test-helper.js");
    const c = await makeContent(f.data, "有计划的稿", {}, "published");
    await writePlan(f.data, c.id, [{ platform: "douyin", title: "t", scheduled_at: "2026-09-01T20:00:00+08:00" }]);
    expect(await buildAccountData(f.data)).toMatchObject({ status: "ok" });
    const { resolveContentProject } = await import("../../storage/content-project.js");
    await fs.writeFile(path.join(resolveContentProject(c.id, f.data)!.project_root, "06-publish/publish-plan.json"), "{ 坏");
    expect(await buildAccountData(f.data)).toMatchObject({ status: "failed", reason: expect.stringContaining("publish-plan.json") });
  });
});

describe("第七轮", () => {
  it("OpenClaw 后台代写（_modelCall）：方向必须是创始人自定那句；第一篇带跳过参数拒", async () => {
    const t = await makeTopic(f.data, "开爪题");
    await founderAuthored(f.data, t.id, "创始人的那句");
    const generateScriptImpl = vi.fn();
    const call = (extra: Record<string, unknown>) => executeGenerate({ action: "script", topic: t.title, topic_id: t.id, platform: "douyin", _modelCall: true, _dataDir: f.data, ...extra }, { generateScriptImpl });
    expect(await call({ direction: "模型自己换的方向" })).toMatchObject({ ok: false, code: "needs_founder_angle" });
    expect(await call({ research_mode: "skip", research_reason: "不想查" })).toMatchObject({ ok: false, code: "skip_removed" });
    expect(await call({ skip_reason: "直接写" })).toMatchObject({ ok: false, code: "skip_removed" });
    expect(generateScriptImpl).not.toHaveBeenCalled();
    generateScriptImpl.mockResolvedValue({ contentId: "c", title: "t", body: "b", hashtags: [], violations: [], tokensUsed: 1 });
    expect(await call({ direction: "创始人的那句" })).toMatchObject({ ok: true });
  });

  it("聊天：存量稿的选题有未选的立意卡也照常重写（不弹选卡）", async () => {
    const t = await makeTopic(f.data, "存量有卡题");
    await withCards(t.id);
    await makeContent(f.data, "存量有卡题", { topicId: t.id }, "draft_ready");
    const startGenerate = vi.fn(async () => ({ contentId: "c-new", runId: "r", completion: Promise.resolve() }));
    const chat = buildChatTools([], f.data, { startGenerate, content: vi.fn(async () => ({ ok: true, contents: [] })) });
    const out = JSON.parse(await chat.find((x) => x.name === "generate_script")!.execute({ topic: t.title, platform: "douyin", topic_id: t.id, skip_reason: "旧习惯" }) as string);
    expect(out).toMatchObject({ ok: true, pending: true });
    expect(startGenerate).toHaveBeenCalledOnce();
  });

  it("空的 publish-plan.json 也算读坏：账号数据记失败", async () => {
    const { buildAccountData } = await import("../../tools/scout-parallel.js");
    const { writePlan } = await import("../meetings/meeting-fixture.test-helper.js");
    const c = await makeContent(f.data, "空计划稿", {}, "published");
    await writePlan(f.data, c.id, []);
    const { resolveContentProject } = await import("../../storage/content-project.js");
    await fs.writeFile(path.join(resolveContentProject(c.id, f.data)!.project_root, "06-publish/publish-plan.json"), "");
    expect(await buildAccountData(f.data)).toMatchObject({ status: "failed" });
  });
});

describe("第八轮：冻结的请求对照最新决定 + 占位核验", () => {
  const OUTLINE = { thesis: "t", points: [{ text: "p", kind: "case", seconds: 20 }], structure: { opening: "o", progression: "p", ending: "e" }, said: [{ id: "a", kind: "concept", text: "p" }] };

  it("按角度 A 领的包，创始人后来改成 B → 原包交稿被拒，第一份正文不落盘", async () => {
    const t = await makeTopic(f.data, "改角度题");
    await founderAuthored(f.data, t.id, "角度A");
    const packed = await executeWriter({ action: "pack", topic_id: t.id, platform: "douyin", research_mode: "provided", research: "材料", direction: "角度A", _dataDir: f.data, _host: "claude" }, { onWarn: () => {} });
    expect(packed).toMatchObject({ ok: true, status: "ready" });
    await recordFounderAngle((await getTopic(t.id, f.data))!, "角度B", "改成B", f.data);
    const submitted = await executeWriter({ action: "submit", content_id: packed.content_id, pack_id: packed.pack_id, claim_token: packed.claim_token, attempt: 1,
      title: "标题", body: "第一段。\n\n第二段。", hashtags: [], review: "none", outline: OUTLINE, _dataDir: f.data, _host: "claude" }, { onWarn: () => {} });
    expect(submitted).toMatchObject({ ok: false, code: "needs_founder_angle" });
    expect((await getContent(packed.content_id as string, f.data))?.body ?? "").toBe("");
  });

  it("中断的空稿重写：旧请求是角度 A、创始人已改成 B → 开跑前拒", async () => {
    const t = await makeTopic(f.data, "重写改角度题");
    await recordFounderAngle((await getTopic(t.id, f.data))!, "角度B", "改成B", f.data);
    const stale = await saveContent({ _provenance: HUMAN_WRITE, title: "［生成中断］重写改角度题", body: "", platform: "douyin", topicId: t.id, status: "drafting", tags: [],
      lastError: "断流", genRequest: { topic: "重写改角度题", platform: "douyin", topicId: t.id, direction: "角度A" } } as never, f.data);
    const { retryGenerateScript } = await import("../writing/generate-script.js");
    await expect(retryGenerateScript(stale.id, f.data)).rejects.toMatchObject({ refusal: { code: "needs_founder_angle" } });
  });

  it("在占位前缀后面接正文不算占位：令牌改写占位稿被拒；一字不差的系统占位才算", async () => {
    const t = await makeTopic(f.data, "伪造占位题");
    const ph = (await createPlatformVariant(t.id, "douyin", undefined, f.data)).content!;
    expect(ph.generatedPlaceholder).toBe(ph.body);
    const update = buildIpcHandlers()["content:update"];
    const forged = `<!-- Generated from topic: ${t.id} -->\n\n一整篇模型写的正文`;
    expect(await update({ id: ph.id, body: forged, _dataDir: f.data }, { authMethod: "bearer" })).toMatchObject({ ok: false, code: "needs_founder_angle" });
    expect((await getContent(ph.id, f.data))?.body).toBe(ph.body);
    await expect(saveContent({ title: "伪造", body: forged, topicId: t.id, status: "drafting", tags: [], _provenance: modelWrite() }, f.data)).rejects.toBeInstanceOf(FirstBodyRefusedError);
    expect(await newDraftAngleRefusal(t.id, f.data)).toMatchObject({ code: "needs_founder_angle" });
  });

  it("回流状态文件 metrics-pull.json 坏了 → 账号数据记失败", async () => {
    const { buildAccountData } = await import("../../tools/scout-parallel.js");
    await fs.writeFile(path.join(f.data, "metrics-pull.json"), "");
    expect(await buildAccountData(f.data)).toMatchObject({ status: "failed" });
    await fs.writeFile(path.join(f.data, "metrics-pull.json"), "{ 坏");
    expect(await buildAccountData(f.data)).toMatchObject({ status: "failed" });
  });
});
