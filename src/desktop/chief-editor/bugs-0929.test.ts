/** 2026-09-29 创始人真机 bug 轮：A（选了角度总编辑不知道）、B（调研刷卡） */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveTopic, updateTopic } from "../../storage/local-store.js";
import { saveBrief, type AngleCard, type ResearchBrief } from "../../modules/research/brief-store.js";
import { pendingPerspectives, topicHashOf, upsertJob } from "../../modules/research/research-job-store.js";
import { buildDispatchContext } from "../dispatch-context.js";
import { appendAction, readRecentActions, recentActionsBlock } from "../recent-actions.js";
import { buildIpcHandlers } from "../ipc.js";
import { makeHarness, type Harness } from "./fake-agent.test-helper.js";
import { resultCard } from "./redact.js";
import { maybeRunLocalTurn } from "./ipc-handlers.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.cleanup(); });

const card: AngleCard = {
  id: "angle-1", angle: "从工具链换代看裁员", thesis: "裁的不是人是工作流", coreEvidenceIds: ["ev-1"],
  antiScope: "不写宏观", audiencePain: "怕", holdTrigger: "清单", hookDraft: "上周",
} as AngleCard;

async function topicWithBrief() {
  const topic = await saveTopic({ title: "测试", description: "描述", tags: [] }, h.dataDir);
  const brief = {
    schemaVersion: 1, summary: "s", perspectives: [], tensions: [], angleSuggestions: [], angleCards: [card],
    evidence: [{ id: "ev-1", claim: "c", quote: "q", sourceUrl: "https://e.com" }], assetPicks: [], missingPerspectives: [], gaps: [],
    generatedAt: "2026-09-29T00:00:00Z", revision: 1, topicHash: topicHashOf(topic.title, topic.description),
  } as unknown as ResearchBrief;
  await upsertJob({ topicId: topic.id, status: "succeeded", startedAt: "", perspectives: pendingPerspectives(), topicHash: brief.topicHash, briefRevision: 1 } as never, h.dataDir);
  await saveBrief(topic.id, brief, h.dataDir);
  return topic;
}

describe("bug A1 派活说明带上工作台已选的角度", () => {
  it("选择还作数：明说按它写、别再问", async () => {
    const topic = await topicWithBrief();
    await updateTopic(topic.id, { selectedAngle: { briefRevision: 1, angleId: "angle-1", card, selectedAt: "" } }, h.dataDir);
    const built = await buildDispatchContext({ kind: "write", title: "测试", platform: "douyin", topicId: topic.id }, h.dataDir, "local");
    expect(built.ok && built.text).toContain("已在工作台选定角度 angle-1「从工具链换代看裁员」");
    expect(built.ok && built.text).toContain("不要再让创作者选角度");
  });
  it("简报更新过、选择失效：明说请创作者重选", async () => {
    const topic = await topicWithBrief();
    await updateTopic(topic.id, { selectedAngle: { briefRevision: 0, angleId: "angle-1", card, selectedAt: "" } }, h.dataDir);
    const built = await buildDispatchContext({ kind: "write", title: "测试", platform: "douyin", topicId: topic.id }, h.dataDir, "local");
    expect(built.ok && built.text).toContain("这个选择已失效");
  });
});

describe("bug A4 派活说明的工具名按后端", () => {
  it("本机 agent 用 MCP 名，内置引擎保留原工具名", async () => {
    const topic = await saveTopic({ title: "t", description: "d", tags: [], link: "https://x.com/a" } as never, h.dataDir);
    const d = { kind: "write" as const, title: "t", platform: "douyin", topicId: topic.id, direction: "只写一条线" };
    const local = await buildDispatchContext(d, h.dataDir, "local");
    const builtin = await buildDispatchContext(d, h.dataDir, "builtin");
    expect(local.ok && local.text).toContain("autocrew_scout read_page");
    expect(local.ok && local.text).toContain("autocrew_workflow prepare 的 direction 参数");
    expect(local.ok && local.text).not.toMatch(/read_url|get_draft|generate_script/);
    expect(builtin.ok && builtin.text).toContain("read_url");
    expect(builtin.ok && builtin.text).toContain("请原样放进 direction 参数");
  });
});

describe("bug A3 选 / 清角度记进最近工作区动作", () => {
  it("选定与清除都留痕，渲染成人话", async () => {
    const topic = await topicWithBrief();
    const handlers = buildIpcHandlers();
    const r = await handlers["topic:select_angle"]({ topic_id: topic.id, angle_id: "angle-1", brief_revision: 1, _dataDir: h.dataDir });
    expect(r.ok).toBe(true);
    await handlers["topic:clear_angle"]({ topic_id: topic.id, _dataDir: h.dataDir });
    const block = recentActionsBlock(await readRecentActions(h.dataDir));
    expect(block).toContain("在选题页选定了角度《测试》 · angle-1「从工具链换代看裁员」");
    expect(block).toContain("清掉了选题的角度《测试》");
  });
});

describe("bug A2 本机 agent 也拿到最近工作区动作", () => {
  it("prompt 前缀里有【最近工作区动作】", async () => {
    await appendAction(h.dataDir, { kind: "angle_selected", title: "测试", detail: "angle-1「x」" });
    await maybeRunLocalTurn({ message: "写吧", backend: "claude", turn_id: "t-a2", client_id: "c1", _dataDir: h.dataDir });
    expect(h.agents[0].prompts[0]).toContain("【最近工作区动作】");
    expect(h.agents[0].prompts[0]).toContain("在选题页选定了角度《测试》");
  });
});

describe("bug B 调研中间步骤不单独成卡", () => {
  it.each([
    ["autocrew_scout", "read_page", { ok: true, task_id: "task-1" }],
    ["autocrew_scout", "perspective", { ok: true, task_id: "task-1" }],
    ["autocrew_workflow", "prepare", { ok: true, task_id: "task-1", content_id: "content-1-a" }],
    ["autocrew_content", "get", { ok: true, content: { id: "content-1-a", title: "t" } }],
    ["autocrew_status", "", { ok: true, message: "x" }],
    ["autocrew_writer", "submit", { ok: false, error: "claim_held" }],
  ])("%s %s → 只进工作记录", (tool, action, result) => {
    expect(resultCard(tool, action, result as Record<string, unknown>, "c")).toBeNull();
  });
  it("稿件结果与后台长任务仍成卡", () => {
    expect(resultCard("autocrew_writer", "submit", { ok: true, content_id: "content-1-a" }, "c")).toMatchObject({ type: "agent_draft" });
    expect(resultCard("autocrew_research", "deep_dive", { ok: true, task_id: "job-1" }, "c")).toMatchObject({ type: "agent_task" });
  });
  it("一轮调研不刷卡", async () => {
    h.script = async (a) => {
      for (const action of ["read_page", "perspective", "synthesize", "angles"]) await h.callTool(a, "autocrew_scout", { action });
      return { stopReason: "end_turn" };
    };
    const r = await (await import("./turn.js")).runLocalTurn(h.svc, { message: "调研", backend: "claude", turnId: "t-b", clientId: "c1", dataDir: h.dataDir });
    expect((r.data as { cards: unknown[] }).cards).toHaveLength(0);
  });
});
