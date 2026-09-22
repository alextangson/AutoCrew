import { describe, expect, it } from "vitest";
import { BRIEF_SCHEMA_VERSION, type AngleCardV3, type ResearchBrief } from "../modules/research/brief-store.js";
import { angleOptionsView, cardLine, cardView, jobView } from "./workflow-views.js";
import type { ResearchJob } from "../modules/research/research-job-store.js";
import { creativeTaskHash } from "../modules/writing/creative-task.js";

const card: AngleCardV3 = {
  cardVersion: 3, id: "angle-1", angle: "从清晨的浇水场景进入", thesis: "共同照料让邻居相互熟悉",
  antiScope: "不谈商业转化", hookDraft: "早上六点，外婆把水壶递给了我。", primaryPersona: "trust",
  misconception: "", mechanism: "记录一起浇水和协商排班的实际过程", payoff: "理解邻里关系如何在小事中形成",
  nextAction: "留意身边协作的细节", counterResponse: "个案不能代表所有社区", personaGains: { grow: "", trust: "理解邻里协作", convert: "" },
  elements: [], evidenceNeeds: ["核对事件时间"], structure: "story", evidenceLevel: "grounded", coreEvidenceIds: ["ev-1"],
  score: 1, scoreReasons: ["证据支撑分，不代表传播潜力或爆款概率"],
};
const brief: ResearchBrief = {
  schemaVersion: BRIEF_SCHEMA_VERSION, summary: "居民共同维护菜园", perspectives: [], tensions: [], angleSuggestions: [],
  evidence: [{ claim: "社区有轮班照料", quote: "居民每周轮班浇水", sourceUrl: "https://example.com/garden" }],
  assetPicks: [], missingPerspectives: [], gaps: [], generatedAt: "2026-09-22", revision: 1, topicHash: "h", angleCards: [card],
};

describe("候选推荐说明判断依据及边界", () => {
  it("证据推荐不冒充传播潜力或替用户选择", () => {
    const result = angleOptionsView(brief);
    expect(result.recommendation).toMatchObject({ angleId: "angle-1", basis: "evidence_coverage", automaticSelection: false });
    expect(result.recommendation?.uncertainties.join(" ")).toContain("不评定哪个角度最有传播潜力");
    expect(result.cards[0]).toMatchObject({
      distinction: { audience: expect.stringContaining("目标标签不代表实际人群"), objective: "理解与信任（立信）" },
      editorialHypothesis: { status: "needs_creator_judgment", readerValue: card.payoff, structure: "story" },
      scoreMeaning: "evidence_support",
    });
    expect(brief).not.toHaveProperty("selectedAngle");
  });

  it("高历史分不能顶替缺失证据，有伪造锚点不能赢得优先级", () => {
    const fake = { ...card, id: "angle-2", score: 99, firsthandAnchor: { kind: "brief_evidence" as const, chunkId: "ev-1", quote: "编造", excerptHash: "fake" } };
    const result = angleOptionsView({ ...brief, angleCards: [card, fake, { ...card, id: "angle-3", evidenceLevel: "overview", coreEvidenceIds: [], score: 100 }] });
    // 与真实卡证据覆盖相同，不能因伪造锚点获得更高优先级；同等则沿用原顺序。
    expect(result.recommendation?.reasons.join(" ")).not.toContain("引文锚点");
    expect(result.recommendation?.angleId).toBe("angle-1");
  });

  it("无可追溯证据时不推荐；历史评分单独标明", () => {
    expect(angleOptionsView({ ...brief, evidence: [] }).recommendation).toBeUndefined();
    expect(cardView({ ...card, scoreReasons: ["元素 2"] })).toMatchObject({ scoreMeaning: "legacy_uninterpreted" });
    expect(cardLine(card)).toContain("内容目标：理解与信任");
    expect(cardLine(card)).not.toContain("他信的是");
    expect(cardLine(card)).not.toContain("误区背景");
  });

  it("研究任务视图带出共同任务书及指纹", () => {
    const creativeTask = { version: 1 as const, platform: "wechat", requirements: "保持自然叙事", direction: "邻里关系" };
    expect(jobView({ topicId: "topic-1", status: "running", creativeTask } as ResearchJob)).toMatchObject({ creativeTask, creativeTaskHash: creativeTaskHash(creativeTask) });
  });
});
