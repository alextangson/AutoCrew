import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRIEF_SCHEMA_VERSION, saveBrief, type ResearchBrief, type AngleCardV3 } from "../modules/research/brief-store.js";
import { topicHashOf, upsertJob, type ResearchJob } from "../modules/research/research-job-store.js";
import { getTopic, saveTopic, updateTopic } from "../storage/local-store.js";
import { inspectWritingReadiness, writingReadinessFailure, type WritingReadinessRequest } from "./writing-readiness.js";

let dir: string;
let topicId: string;
const title = "新工具如何影响返工";
const description = "按返工时间衡量真实收益";
const hash = topicHashOf(title, description);
const card: AngleCardV3 = {
  cardVersion: 3, id: "angle-1", angle: "跟着一段返工经历看工具", thesis: "收益需要算进返工时间",
  evidenceLevel: "grounded", coreEvidenceIds: ["ev-1"], antiScope: "不做工具排名", hookDraft: "我又回到了昨天的文件。",
  primaryPersona: "grow", misconception: "生成快等于交付快", mechanism: "修改成本抵消节省的时间", payoff: "知道该记录什么",
  nextAction: "记录一次返工", counterResponse: "并非所有任务都一样", personaGains: { grow: "知道差异", trust: "材料可追溯", convert: "评估用途" },
  elements: ["新奇点", "痛点→理想状态"], evidenceNeeds: [], structure: "story", score: 3,
};
const brief = (over: Partial<ResearchBrief> = {}): ResearchBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION, summary: "返工时间不可省略", perspectives: [], tensions: [], angleSuggestions: [],
  angleCards: [card], evidence: [{ claim: "有返工成本", quote: "修改占了一部分时间", sourceUrl: "https://example.com/report" }],
  assetPicks: [], missingPerspectives: [], gaps: [], generatedAt: "2026-09-22T01:00:00Z", revision: 1, topicHash: hash, ...over,
});
const job = (over: Partial<ResearchJob> = {}): ResearchJob => ({
  topicId, status: "succeeded", startedAt: "2026-09-22T00:00:00Z", settledAt: "2026-09-22T01:00:00Z",
  perspectives: [], briefRevision: 1, topicHash: hash, ...over,
});
const inspect = (req: WritingReadinessRequest = {}) => inspectWritingReadiness(topicId, req, dir);
async function seed(over: Partial<ResearchBrief> = {}, jobOver: Partial<ResearchJob> = {}) {
  await saveBrief(topicId, brief(over), dir);
  await upsertJob(job(jobOver), dir);
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "writing-readiness-"));
  topicId = (await saveTopic({ title, description, tags: [] }, dir)).id;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("writing readiness", () => {
  it("does not confuse a direction or raw research text with completed research", async () => {
    for (const req of [{}, { direction: "只写真实经历" }, { research: "现有摘录", direction: "真实经历" }]) {
      expect(await inspect(req)).toMatchObject({ ready: false, status: "not_started", research: { status: "not_started", autoResearched: false } });
    }
  });

  it("preserves the full request across the async handoff", async () => {
    const req = { platform: "douyin", requirements: "  按我的经历展开\n不要反常识开头。  ", direction: "讲返工" };
    const result = await inspect(req);
    expect(result.continue_params).toMatchObject(req);
    expect(result.next_action.params).toMatchObject({ action: "prepare", requirements: req.requirements });
  });

  it("preserves explicit clearing without converting omitted parameters into clearing", async () => {
    const result = await inspect({ direction: "", requirements: "", angleSkipReason: undefined, research: "" });
    expect(result.continue_params).toMatchObject({ direction: "", requirements: "", skip_reason: "", research: "" });
    const omitted = await inspect();
    expect(omitted.continue_params).not.toHaveProperty("direction");
    expect(omitted.continue_params).not.toHaveProperty("research");
  });

  it("reports running refresh even when a previous brief exists", async () => {
    await seed({}, { status: "running" });
    expect(await inspect({ direction: "沿用方向" })).toMatchObject({ ready: false, status: "researching", research: { status: "running", autoResearched: false, briefRevision: 1 } });
  });

  it("does not present a failed rerun or a stale retained brief as current research", async () => {
    await seed({ topicHash: "old" }, { status: "failed", failReason: "搜索源不可达" });
    const result = await inspect({ direction: "直接写" });
    expect(result).toMatchObject({ ready: false, status: "needs_attention", research: { status: "failed", stale: true, reason: "搜索源不可达" } });
    expect(result.note).toContain("旧简报不能代表本轮成功");
    expect(result.next_action.params).toMatchObject({ action: "research", kind: "full" });
  });

  it("compares the brief hash with the current topic, not the latest job hash", async () => {
    await seed({ topicHash: "old" });
    expect(await inspect({ direction: "已有方向" })).toMatchObject({ ready: false, status: "not_started", research: { status: "stale" } });
  });

  it("retries only angle generation when the current research is intact", async () => {
    await seed({}, { status: "failed", kind: "angles", failReason: "立意生成中断" });
    expect(await inspect()).toMatchObject({ status: "needs_attention", next_action: { params: { action: "research", kind: "angles" } } });
  });

  it("does not claim that a successful job with a missing brief is ready", async () => {
    await upsertJob(job(), dir);
    expect(await inspect()).toMatchObject({ ready: false, status: "needs_attention", research: { status: "failed" } });
  });

  it("requests candidate generation when research has no cards and no chosen direction", async () => {
    await seed({ angleCards: [] });
    expect(await inspect()).toMatchObject({ ready: false, status: "needs_attention", next_action: { params: { action: "research", kind: "angles" } } });
    expect(await inspect({ direction: "从我的返工经历展开" })).toMatchObject({ ready: true, angle: { status: "direction" } });
  });

  it("recommends grounded evidence over a high score without selecting for the creator", async () => {
    await seed({ angleCards: [{ ...card, id: "angle-2", score: 99, evidenceLevel: "overview", coreEvidenceIds: [], evidenceNeeds: ["缺可靠案例"] }, card] });
    const result = await inspect();
    expect(result).toMatchObject({ ready: false, status: "needs_angle", angle: { recommendation: { angleId: "angle-1", automaticSelection: false } } });
    expect(result.angle.cards).toHaveLength(2);
    expect(result.angle.recommendation?.reasons.join(" ")).toContain("证据可追溯");
    expect((await getTopic(topicId, dir))?.selectedAngle).toBeUndefined();
    expect(writingReadinessFailure(result)).toMatchObject({ ok: false, needsAngle: true, preparation: result });
  });

  it("does not recommend an overview or a card with broken evidence references", async () => {
    await seed({ angleCards: [{ ...card, coreEvidenceIds: ["ev-20"] }] });
    expect((await inspect()).angle.recommendation).toBeUndefined();
  });

  it("requires current selection, then hands writing to the host with visible gaps", async () => {
    await seed({ gaps: ["缺最新样本"] }, { status: "partial" });
    await updateTopic(topicId, { selectedAngle: { briefRevision: 1, angleId: card.id, card, selectedAt: "2026-09-22T02:00:00Z" } }, dir);
    expect(await inspect()).toMatchObject({ ready: true, status: "ready_to_write", research: { status: "partial", autoResearched: true, gaps: ["缺最新样本"] }, next_action: { tool: "autocrew_writer", params: { action: "pack" } } });
    await updateTopic(topicId, { selectedAngle: { briefRevision: 2, angleId: card.id, card, selectedAt: "2026-09-22T02:00:00Z" } }, dir);
    expect(await inspect()).toMatchObject({ ready: false, status: "needs_angle" });
  });

  it("requires real supplied material and a separate creator direction", async () => {
    expect(await inspect({ researchMode: "provided", research: " " })).toMatchObject({ ready: false, status: "needs_attention" });
    expect(await inspect({ researchMode: "provided", research: "已有材料" })).toMatchObject({ ready: false, status: "needs_angle" });
    expect(await inspect({ researchMode: "provided", research: "已有材料", direction: "我的经历" })).toMatchObject({ ready: true, research: { status: "provided", autoResearched: false } });
  });

  it("separates a research skip from an angle skip, preserving the creator's reason", async () => {
    expect(await inspect({ researchMode: "skip", direction: "有方向" })).toMatchObject({ ready: false, status: "needs_attention" });
    const req = { researchMode: "skip" as const, researchReason: "本人日记，无需外部调研" };
    expect(await inspect(req)).toMatchObject({ ready: false, status: "needs_angle" });
    expect(await inspect({ ...req, angleSkipReason: "我明确要求直接写" })).toMatchObject({ ready: true, research: { status: "skipped", autoResearched: false, reason: req.researchReason }, angle: { status: "skipped" } });
  });

  it("rejects an invalid mode at runtime instead of treating it as a skip", async () => {
    expect(await inspect({ researchMode: "anything" as "auto", direction: "直接写" })).toMatchObject({ ready: false, status: "needs_attention" });
  });
});
