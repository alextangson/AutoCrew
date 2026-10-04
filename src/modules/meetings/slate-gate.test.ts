import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { listContents } from "../../storage/local-store.js";
import { listHypotheses } from "../retro/hypotheses.js";
import { executeInsights } from "../../tools/insights.js";
import { executeWorkflow } from "../../tools/workflow.js";
import { executeWriter } from "../../tools/writer.js";
import { executeGenerate } from "../../tools/generate.js";
import { executeContentSave } from "../../tools/content-save.js";
import { startWriting } from "../../desktop/board-actions.js";
import { buildIpcHandlers } from "../../desktop/ipc.js";
import { buildChatTools } from "../../desktop/chat-router.js";
import { readMeeting } from "./meeting-store.js";
import { SLATE_GATE_COPY, newDraftSlateRefusal } from "./slate-gate.js";
import { putOnSlate } from "./slate.test-helper.js";
import { dropFixture, makeContent, makeFixture, makeTopic, type Fixture } from "./meeting-fixture.test-helper.js";

let f: Fixture;
beforeEach(async () => { f = await makeFixture(); });
afterEach(async () => { await dropFixture(f); });

const slot = (topicId: string, over: Record<string, unknown> = {}) => ({
  topic_id: topicId, persona: { key: "core", name: "小林" }, payoff: "看完能判断自己该不该给团队买 AI 助手",
  format: "观点", why_now: "今天的热点", data_basis: "无数据依据，纯判断", bet: "D+3 播放高于抖音同龄中位数",
  watch: { platform: "douyin", metric: "views", day: 3 }, probability: 40, premortem: "热度过得太快", ...over,
});
const save = (date: string, meeting: Record<string, unknown>) =>
  executeInsights({ action: "meeting_save", date, meeting, _dataDir: f.data });
const MEETING_NEXT = { skill: "topic-meeting", tool: "autocrew_insights", params: { action: "meeting_brief" } };

describe("片单判定 newDraftSlateRefusal", () => {
  it("从没开过会 → 拦，提示先开会（不是放行）", async () => {
    const t = await makeTopic(f.data, "热点");
    expect(await newDraftSlateRefusal(t.id, f.data)).toMatchObject({ ok: false, code: "not_on_slate", error: SLATE_GATE_COPY.noMeeting, next_action: MEETING_NEXT });
  });

  it("在最近一场会的片单上 → 放行；只在上一场 → 拦", async () => {
    const [a, b] = await Promise.all([makeTopic(f.data, "A"), makeTopic(f.data, "B")]);
    expect(await save("2026-10-01", { expected_revision: 0, slots: [slot(a.id), slot(b.id)] })).toMatchObject({ ok: true });
    expect(await newDraftSlateRefusal(a.id, f.data)).toBeNull();
    expect(await save("2026-10-03", { expected_revision: 0, slots: [slot(b.id)] })).toMatchObject({ ok: true });
    expect(await newDraftSlateRefusal(b.id, f.data)).toBeNull();
    expect(await newDraftSlateRefusal(a.id, f.data)).toMatchObject({ code: "not_on_slate", error: SLATE_GATE_COPY.notOnSlate, current_meeting: "2026-10-03" });
  });

  it("会议记录读坏 → slate_read_failed：既不放行，也不冒充空片单", async () => {
    const t = await makeTopic(f.data, "题");
    await putOnSlate(f.data, t.id, "2026-10-01");
    await fs.writeFile(path.join(f.data, "meetings/2026-10-02.json"), "{ 坏的");
    const r = await newDraftSlateRefusal(t.id, f.data);
    expect(r).toMatchObject({ ok: false, code: "slate_read_failed" });
    expect(r?.error).toContain(SLATE_GATE_COPY.readFailed);
    expect(r?.error).not.toContain(SLATE_GATE_COPY.noMeeting);
  });

  it("已有稿的选题（改稿、补证、重领包）不算新稿 → 不查片单", async () => {
    const t = await makeTopic(f.data, "老题");
    await makeContent(f.data, "老题", { topicId: t.id }, "draft_ready");
    expect(await newDraftSlateRefusal(t.id, f.data)).toBeNull();
    // 归档稿不算「已有稿」
    const t2 = await makeTopic(f.data, "归档题");
    await makeContent(f.data, "归档题", { topicId: t2.id }, "archived");
    expect(await newDraftSlateRefusal(t2.id, f.data)).toMatchObject({ code: "not_on_slate" });
  });

  it("没有选题的新稿 → 拦", async () => {
    expect(await newDraftSlateRefusal(undefined, f.data)).toMatchObject({ code: "not_on_slate", error: SLATE_GATE_COPY.noTopic });
  });
});

describe("单题会：meeting_save append", () => {
  it("同日追加一个位：当日原片单、原下注原样保留，新题放行，只多一条下注", async () => {
    const [a, hot] = await Promise.all([makeTopic(f.data, "周会题"), makeTopic(f.data, "热点")]);
    await save("2026-10-04", { expected_revision: 0, slots: [slot(a.id)] });
    expect(await newDraftSlateRefusal(hot.id, f.data)).toMatchObject({ code: "not_on_slate" });
    const res = await save("2026-10-04", { expected_revision: 1, slots: [slot(hot.id)], append: true });
    expect(res).toMatchObject({ ok: true, record: { revision: 2, slots: [{ topicId: a.id, slotId: "s1" }, { topicId: hot.id, slotId: "s2" }] } });
    expect(await newDraftSlateRefusal(hot.id, f.data)).toBeNull();
    expect(await newDraftSlateRefusal(a.id, f.data)).toBeNull();
    const bets = await listHypotheses(f.data);
    expect(bets.map((h) => h.id).sort()).toEqual(["hyp-meeting-2026-10-04-s1", "hyp-meeting-2026-10-04-s2"]);
    expect(bets.every((h) => h.status === "open")).toBe(true);
  });

  it("append 也走 CAS：带旧 revision 报 conflict，不静默覆盖", async () => {
    const [a, hot] = await Promise.all([makeTopic(f.data, "周会题"), makeTopic(f.data, "热点")]);
    await save("2026-10-04", { expected_revision: 0, slots: [slot(a.id)] });
    const late = await save("2026-10-04", { expected_revision: 0, slots: [slot(hot.id)], append: true });
    expect(late).toMatchObject({ ok: false, conflict: true, current_revision: 1 });
    expect((await readMeeting("2026-10-04", f.data))?.slots.map((s) => s.topicId)).toEqual([a.id]);
    expect(await newDraftSlateRefusal(hot.id, f.data)).toMatchObject({ code: "not_on_slate" });
  });

  it("单题会照样要下注字段；空 append、重复追加都打回", async () => {
    const hot = await makeTopic(f.data, "热点");
    expect(await save("2026-10-04", { expected_revision: 0, slots: [slot(hot.id, { probability: undefined })], append: true })).toMatchObject({ ok: false, error: expect.stringContaining("probability") });
    expect(await save("2026-10-04", { expected_revision: 0, slots: [], append: true })).toMatchObject({ ok: false });
    expect(await save("2026-10-04", { expected_revision: 0, slots: [slot(hot.id)], append: true })).toMatchObject({ ok: true, record: { revision: 1 } });
    expect(await save("2026-10-04", { expected_revision: 1, slots: [slot(hot.id)], append: true })).toMatchObject({ ok: false, error: expect.stringContaining("已在") });
  });
});

describe("每个开写入口走同一判定", () => {
  const offSlate = { ok: false, code: "not_on_slate", next_action: MEETING_NEXT };

  it("workflow prepare / workflow write(engine) / writer pack / generate", async () => {
    const t = await makeTopic(f.data, "不在片单");
    const startGenerateScriptImpl = vi.fn();
    expect(await executeWorkflow({ action: "prepare", topic_id: t.id, platform: "douyin", _dataDir: f.data })).toMatchObject(offSlate);
    expect(await executeWorkflow({ action: "write", topic_id: t.id, platform: "douyin", execution: "engine", _dataDir: f.data }, { startGenerateScriptImpl, onWarn: () => {} })).toMatchObject(offSlate);
    expect(await executeWriter({ action: "pack", topic_id: t.id, platform: "douyin", research_mode: "provided", research: "材料", _dataDir: f.data }, { onWarn: () => {} })).toMatchObject(offSlate);
    const generateScriptImpl = vi.fn();
    expect(await executeGenerate({ action: "script", topic: t.title, topic_id: t.id, platform: "douyin", _dataDir: f.data }, { generateScriptImpl })).toMatchObject(offSlate);
    expect(await executeGenerate({ action: "script", topic: t.title, topic_id: t.id, platform: "douyin", execution: "engine", _host: "claude", _dataDir: f.data }, { generateScriptImpl })).toMatchObject(offSlate);
    expect(startGenerateScriptImpl).not.toHaveBeenCalled();
    expect(generateScriptImpl).not.toHaveBeenCalled();
    expect(await listContents(f.data)).toHaveLength(0);
  });

  it("看板「开始写」/ 桌面后台写稿 / 聊天 generate_script", async () => {
    const t = await makeTopic(f.data, "不在片单");
    const spawnImpl = vi.fn();
    expect(await startWriting(t.id, "douyin", f.data, { platform: "darwin", spawnImpl: spawnImpl as never })).toMatchObject(offSlate);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(await buildIpcHandlers()["generate:script"]({ topic: t.title, platform: "douyin", topic_id: t.id, _dataDir: f.data })).toMatchObject(offSlate);
    const startGenerate = vi.fn();
    const chat = buildChatTools([], f.data, { startGenerate, content: vi.fn(async () => ({ ok: true, contents: [] })) });
    const out = JSON.parse(await chat.find((x) => x.name === "generate_script")!.execute({ topic: t.title, platform: "douyin", topic_id: t.id }) as string);
    expect(out).toMatchObject(offSlate);
    expect(startGenerate).not.toHaveBeenCalled();
    expect(await listContents(f.data)).toHaveLength(0);
  });

  it("进了片单 → workflow prepare 不再被片单拦（放行到原有流程）", async () => {
    const t = await makeTopic(f.data, "片单题");
    await save("2026-10-04", { expected_revision: 0, slots: [slot(t.id)] });
    const r = await executeWorkflow({ action: "prepare", topic_id: t.id, platform: "douyin", research_mode: "provided", research: "材料", direction: "方向", _dataDir: f.data });
    expect(r).not.toMatchObject({ code: "not_on_slate" });
    expect(r.ok).toBe(true);
  });

  it("改已有稿 / 平台改写 / 手动导入成稿 → 放行（不在片单也不拦）", async () => {
    const t = await makeTopic(f.data, "老题");
    const c = await makeContent(f.data, "老题", { topicId: t.id }, "draft_ready");
    const pack = await executeWriter({ action: "pack", content_id: c.id, platform: "douyin", force: true, research_mode: "provided", research: "补的材料", _dataDir: f.data }, { onWarn: () => {} });
    expect(pack).not.toMatchObject({ code: "not_on_slate" });
    const variant = await executeContentSave({ action: "create_variant", topicId: t.id, platform: "xiaohongshu", _dataDir: f.data });
    expect(variant).not.toMatchObject({ code: "not_on_slate" });
    expect(variant.ok).toBe(true);
    const fresh = await makeTopic(f.data, "新题不在片单");
    const imported = await executeContentSave({ action: "save", title: "我自己写好的", body: "成稿正文。", topicId: fresh.id, source: "manual_import", import_reason: "用户给的旧稿", _dataDir: f.data, _host: "claude" });
    expect(imported).toMatchObject({ ok: true });
  });
});
