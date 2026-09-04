/**
 * script-review-prompt.test.ts — 审稿 prompt 的判据表与材料块（P1 §4.5 / 审稿 spec §2.4）。
 *
 * 纯函数、零注入：这里断言的是「哪一类判据在什么条件下出现、卡上的哪句话被点了名」，
 * 收敛行为在 script-review.test.ts。判据是内容资产，逐条断言就是它的回归网。
 */
import { describe, it, expect } from "vitest";
import { buildReviewSystemPrompt, buildReviewUserMessage } from "./script-review-prompt.js";
import type { AngleCardV2, AngleCardV3 } from "../research/brief-store.js";
import { DEFAULT_PERSONAS } from "../research/personas.js";
import type { SubmitPayload } from "./script-payload.js";

const V3: AngleCardV3 = {
  cardVersion: 3,
  id: "angle-1",
  angle: "算一笔维护账",
  thesis: "省下的编码时间被维护成本吃回去了",
  evidenceLevel: "grounded",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写工具横评",
  hookDraft: "账没算完。",
  primaryPersona: "trust",
  misconception: "以为提效数字等于净收益",
  mechanism: "省下的时间落在写代码那一步，维护成本落在读代码那一步",
  payoff: "看完你知道该拿哪个数字去跟老板谈",
  nextAction: "把上周的返工工时也记进提效表",
  counterResponse: "有人说熟练了就好",
  personaGains: { grow: "听懂水分", trust: "拿到能复算的账", convert: "知道该盯哪一项" },
  elements: ["痛点→理想状态", "新奇点"],
  evidenceNeeds: ["一个企业公开披露的维护成本数字"],
  structure: "claim-case-claim",
};

const V2: AngleCardV2 = {
  id: "angle-1",
  angle: "算一笔维护账",
  thesis: "省下的编码时间被维护成本吃回去了",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写工具横评",
  audiencePain: "老板要一个提效数字",
  holdTrigger: "反直觉的账",
  hookDraft: "账没算完。",
};

const PAYLOAD: SubmitPayload = {
  title: "提效数字的水分",
  hook: "开头一句话",
  body: "正文。",
  cta: "关注我",
  hashtags: ["#AI"],
};

// ─── 判据三：立意执行（只在 v3 卡在场时启用）────────────────────────────────

describe("buildReviewSystemPrompt — 判据三 立意执行", () => {
  const v3Prompt = buildReviewSystemPrompt({ hasResearch: true, angle: V3 });

  it("v3 卡 → 判据三出现，五条 blocker 逐条点名卡上的原文", () => {
    expect(v3Prompt).toContain("## 判据三：立意执行");
    // 主画像动作：审稿人要代入这个人读，所以画像三要素与卡上的最小动作都得在
    expect(v3Prompt).toContain(DEFAULT_PERSONAS.trust.name);
    expect(v3Prompt).toContain(DEFAULT_PERSONAS.trust.who);
    expect(v3Prompt).toContain(DEFAULT_PERSONAS.trust.state);
    expect(v3Prompt).toContain("主画像动作没达成");
    expect(v3Prompt).toContain(V3.nextAction);
    // 误区：前 3 秒点出 + 正文反驳
    expect(v3Prompt).toContain("误区没被点出或没被反驳");
    expect(v3Prompt).toContain(V3.misconception);
    expect(v3Prompt).toContain("前 3 秒");
    // 收获感：大白话的为什么 + 一个能做的动作
    expect(v3Prompt).toContain("收获感没兑现");
    expect(v3Prompt).toContain(V3.payoff);
    // 主张可反驳性
    expect(v3Prompt).toContain("主张不可反驳");
    expect(v3Prompt).toContain(V3.thesis);
    // 机制只剩比喻
    expect(v3Prompt).toContain("机制只剩比喻");
    expect(v3Prompt).toContain(V3.mechanism);
    // 禁区（v2 加严表里唯一没被上面覆盖的一条，不能随版本丢掉）
    expect(v3Prompt).toContain("闯进禁区");
    expect(v3Prompt).toContain(V3.antiScope);
  });

  it("advisory 三条常驻：网感元素、最小动作、[未证实]，身份表述明写「只提醒」", () => {
    expect(v3Prompt).toContain("网感元素命中不足 2 个");
    expect(v3Prompt).toContain("痛点→理想状态、新奇点"); // 卡上的元素逐个列出来
    expect(v3Prompt).toContain("结尾没有给观众一个最小动作");
    expect(v3Prompt).toContain("[未证实]");
    expect(v3Prompt).toContain("不会写代码 / 不是科班 / 学历 / 出身");
    expect(v3Prompt).toContain("永远给 advisory，不要打回");
  });

  it("数字：判据三明说不再复核数字真假（无据数字已被硬门拦下）", () => {
    expect(v3Prompt).toContain("不要再复核数字真假");
  });

  it("needs_human 数字：有才列，没有就不出现这条 advisory", () => {
    const withNumbers = buildReviewSystemPrompt({
      hasResearch: true,
      angle: V3,
      needsHumanNumbers: ["几十万", "三成多"],
    });
    expect(withNumbers).toContain("需人工过目的模糊数量词：几十万、三成多");
    expect(v3Prompt).not.toContain("需人工过目的模糊数量词");
  });

  it("v2 卡 → 没有判据三，仍走原来的加严表（additive 纪律）", () => {
    const v2Prompt = buildReviewSystemPrompt({ hasResearch: true, angle: V2 });
    expect(v2Prompt).not.toContain("判据三");
    expect(v2Prompt).toContain("thesis 没被论证");
    expect(v2Prompt).toContain("闯进禁区");
  });

  it("无卡 → 判据三与加严表都不出现，与今天逐字一致", () => {
    const none = buildReviewSystemPrompt({ hasResearch: true });
    expect(none).not.toContain("判据三");
    expect(none).not.toContain("thesis 没被论证");
    expect(none).toContain("洞察深度（本稿带了调研材料");
  });

  it("v3 不再挂判据二的加严表：同一处毛病不判两遍", () => {
    expect(v3Prompt).not.toContain("thesis 没被论证");
    expect(v3Prompt).not.toContain("受众痛点落空");
  });

  it("v3 卡 + 无调研材料：判据二仍关，判据三照开（它判的是卡，不是材料）", () => {
    const p = buildReviewSystemPrompt({ hasResearch: false, angle: V3 });
    expect(p).toContain("本轮**不判**");
    expect(p).toContain("## 判据三：立意执行");
  });
});

// ─── canFindEvidence：与修订轮工具箱同一个事实（codex #21）────────────────────

describe("buildReviewSystemPrompt — canFindEvidence", () => {
  it("无材料 + 有查证工具 → 删掉「不要凭空要求作者补数据」", () => {
    const p = buildReviewSystemPrompt({ hasResearch: false, canFindEvidence: true });
    expect(p).not.toContain("不要凭空要求作者补数据");
    expect(p).toContain("修订轮手上有查证工具");
  });

  it("无材料 + 无查证工具 → 禁令在（没工具时「去补个数据」只是逼作者编）", () => {
    const p = buildReviewSystemPrompt({ hasResearch: false, canFindEvidence: false });
    expect(p).toContain("不要凭空要求作者补数据");
    expect(p).not.toContain("修订轮手上有查证工具");
  });

  it("缺省 = 无工具：不传等于没有，不许默默当有", () => {
    expect(buildReviewSystemPrompt({ hasResearch: false })).toContain("不要凭空要求作者补数据");
  });
});

// ─── 材料块：立意卡进 user message ───────────────────────────────────────────

describe("buildReviewUserMessage — 立意卡块", () => {
  const base = {
    payload: PAYLOAD,
    humanizedText: "开头一句话\n\n正文。\n\n关注我",
    voiceSamples: [],
    platform: "douyin",
  };

  it("v3 卡 → 七个判定字段都在，标题同时含「立意卡」与「本稿切入点」", () => {
    const msg = buildReviewUserMessage({ ...base, angle: V3, researchSlot: "【调研简报】三个数字" });
    expect(msg).toContain("【立意卡（本稿切入点");
    expect(msg).toContain(DEFAULT_PERSONAS.trust.name);
    expect(msg).toContain(V3.misconception);
    expect(msg).toContain(V3.thesis);
    expect(msg).toContain(V3.mechanism);
    expect(msg).toContain(V3.payoff);
    expect(msg).toContain(V3.nextAction);
    expect(msg).toContain("痛点→理想状态、新奇点");
    expect(msg).toContain(V3.antiScope);
    // 调研快照原样透传，一个字不再裁（§4.3）
    expect(msg).toContain("【调研简报】三个数字");
  });

  it("v3 卡不贴证据、不贴 v2 字段：证据在调研材料块里，别在这儿贴第二份", () => {
    const msg = buildReviewUserMessage({ ...base, angle: V3 });
    expect(msg).not.toContain("目标受众痛点");
    expect(msg).not.toContain("预期停留触发");
  });

  it("v2 卡 → 材料块与今天逐字一致", () => {
    const msg = buildReviewUserMessage({ ...base, angle: V2 });
    expect(msg).toContain("【本稿切入点（写作前已选定，深度判据的基准）】");
    expect(msg).toContain(V2.audiencePain);
    expect(msg).not.toContain("【立意卡");
  });
});
