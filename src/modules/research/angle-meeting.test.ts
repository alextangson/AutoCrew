/** 选题会 spec §7：payoff 收紧、可选 forPersona/hookType、会议位注入与服从、存量 v3 卡回归 */
import { describe, expect, it } from "vitest";
import { emptyPayoffReason, renderMeetingSlotBlock, type MeetingAngleSlot } from "./angle-meeting.js";
import { buildAngleUserMessage, excerptHashOf, validateAngles } from "./angle-stage.js";
import { parseAngleCard } from "./angle-cards.js";
import { BRIEF_SCHEMA_VERSION, type AngleCardV3, type ResearchBrief } from "./brief-store.js";

const EV = "62% 的人每天使用 AI 编程助手，但维护成本上升了三成";
const brief = (cards: AngleCardV3[] = []): ResearchBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION, summary: "工具已普及，分歧在维护成本。", perspectives: [], tensions: [], angleSuggestions: [],
  angleCards: cards, evidence: [{ claim: "使用率过半", quote: EV, sourceUrl: "https://example.com/s" }], assetPicks: [],
  missingPerspectives: [], gaps: [], generatedAt: "2026-09-04T00:00:00.000Z", revision: 1, topicHash: "h",
});

const cand = (i: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  primary_persona: "grow", angle: ["算维护账", "倒推翻车", "换验收标准"][i], thesis: ["省下的时间被维护吃回去", "翻车集中在重构任务说明它不会设计", "该考核的是改完谁能读懂"][i],
  evidence_level: "grounded", core_evidence_ids: ["ev-1"], misconception: "", mechanism: "理解成本比打字贵",
  payoff: "看完你能判断团队该不该把生成速度当 KPI", next_action: "记一次返工时间", counter_response: "熟练只解决打字",
  persona_gains: { grow: "听懂提效数字", trust: "", convert: "" }, elements: [], evidence_needs: ["返工统计"],
  structure: ["single-point", "story", "claim-case-claim"][i], hook_draft: "提效是真的，账没算完。", anti_scope: ["不写横评", "不谈成本", "不谈价格"][i], ...over,
});
const args = (over: (i: number) => Record<string, unknown> = () => ({})) =>
  ({ misconceptions: { grow: [], trust: [], convert: [] }, candidates: [0, 1, 2].map((i) => cand(i, over(i))) });

const SLOT: MeetingAngleSlot = { meetingDate: "2026-10-02", slotId: "s1", persona: { key: "core", name: "小林" }, payoff: "能判断要不要买", format: "观点", bet: "D+7 播放高于中位数" };

describe("payoff 收紧", () => {
  it("拒「看懂/了解/认识 X」式空话，放过能做的事/能下的判断", () => {
    expect(emptyPayoffReason("用一个历史类比看懂 FDE 热潮的局限")).toMatch(/看懂 X/);
    expect(emptyPayoffReason("了解 AI 助手的三种形态")).toMatch(/了解 X/);
    expect(emptyPayoffReason("帮你 3 分钟认识 Harness")).toMatch(/认识 X/);
    expect(emptyPayoffReason("看完能判断自己的团队该不该上 AI 客服")).toBeNull();
    expect(emptyPayoffReason("今天就把上周的返工时间记一次")).toBeNull();
    // 理解类动词后面接着要做的事 / 要下的判断，不是空话
    expect(emptyPayoffReason("明白自己该先自查哪 3 样再决定上不上 AI")).toBeNull();
    expect(emptyPayoffReason("看懂报价单之后，能判断这家值不值得签")).toBeNull();
    expect(emptyPayoffReason("了解要不要现在就给团队买")).toBeNull();
    // 只接一个光秃秃的对象，仍是空话
    expect(emptyPayoffReason("明白 AI 客服的原理")).toMatch(/明白 X/);
    expect(emptyPayoffReason("搞懂大模型")).toMatch(/搞懂 X/);
  });

  it("立意产出：空话 payoff 被打回", () => {
    const res = validateAngles(args((i) => (i === 1 ? { payoff: "了解重构任务为什么翻车" } : {})), brief());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problems.join("；")).toMatch(/候选 2：payoff/);
  });
});

describe("forPersona / hookType", () => {
  it("没有会议位：可选字段缺省照常通过；给了就落到卡上", () => {
    const res = validateAngles(args((i) => (i === 0 ? { for_persona: { key: "adjacent", name: "老陈" }, hook_type: "观点" } : {})), brief());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.cards[0]).toMatchObject({ forPersona: { key: "adjacent", name: "老陈" }, hookType: "观点" });
      expect(res.value.cards[1].forPersona).toBeUndefined();
    }
  });

  it("有会议位：两项必填；偏离画像/形式要写理由", () => {
    const missing = validateAngles(args(), brief(), undefined, SLOT);
    expect(missing.ok).toBe(false);
    const fit = (i: number) => ({ for_persona: { key: "core", name: "小林" }, hook_type: i === 2 ? "教学" : "观点" });
    const off = validateAngles(args(fit), brief(), undefined, SLOT);
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.problems.join("；")).toMatch(/候选 3：偏离了会上定的形式 观点/);
    const ok = validateAngles(args((i) => ({ ...fit(i), ...(i === 2 ? { meeting_deviation: "这条用教学更好拍" } : {}) })), brief(), undefined, SLOT);
    expect(ok.ok).toBe(true);
  });

  it("会议位注入立意 user message；没有会议位照旧", () => {
    const msg = buildAngleUserMessage({ brief: brief(), topic: { title: "t", description: "d" }, profile: null, meetingSlot: SLOT, formatSummary: "douyin D+7 播放｜观点：中位 350（n=6）" });
    expect(msg).toContain("给谁看：core（小林）");
    expect(msg).toContain("赌什么：D+7 播放高于中位数");
    expect(msg).toContain("中位 350（n=6）");
    expect(renderMeetingSlotBlock(undefined)).toBe("");
  });
});

describe("存量 v3 卡回归", () => {
  const OLD: AngleCardV3 = {
    cardVersion: 3, id: "angle-1", angle: "历史类比", thesis: "热潮总会退", evidenceLevel: "grounded", coreEvidenceIds: ["ev-1"],
    antiScope: "不写技术细节", hookDraft: "开头", primaryPersona: "grow", misconception: "", mechanism: "历史上都这样",
    payoff: "用一个历史类比看懂 FDE 热潮的局限", nextAction: "下判断", counterResponse: "这次不一样？", personaGains: { grow: "看清局限", trust: "", convert: "" },
    elements: [], evidenceNeeds: ["更多案例"], structure: "single-point",
    firsthandAnchor: { kind: "brief_evidence", chunkId: "ev-1", excerptHash: excerptHashOf(EV), quote: "维护成本上升了三成" },
  };

  it("没有新字段、payoff 是旧写法的存量卡：改写别的字段照常通过", () => {
    const res = parseAngleCard({ ...OLD, angle: "改个切入点" }, brief([OLD]), "angle-1");
    expect(typeof res).not.toBe("string");
    expect(res).toMatchObject({ angle: "改个切入点", payoff: OLD.payoff });
  });

  it("档案画像改名后改写带旧名字快照的卡不失败；改 payoff 成空话才拒", () => {
    const withPersona = { ...OLD, forPersona: { key: "core" as const, name: "旧名字" }, hookType: "观点" as const };
    expect(typeof parseAngleCard({ ...withPersona, thesis: "改一下" }, brief([withPersona]), "angle-1")).not.toBe("string");
    expect(parseAngleCard({ ...withPersona, payoff: "了解 FDE" }, brief([withPersona]), "angle-1")).toMatch(/了解 X/);
  });
});
