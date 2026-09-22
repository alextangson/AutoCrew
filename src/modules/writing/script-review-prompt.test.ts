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
import { WRITING_PRIORITY } from "./script-prompt.js";

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

  it("按主张、收获、机制与禁区验收，保留已选结构", () => {
    expect(v3Prompt).toContain("## 判据三：立意执行");
    expect(v3Prompt).toContain(DEFAULT_PERSONAS.trust.name);
    expect(v3Prompt).toContain(DEFAULT_PERSONAS.trust.who);
    expect(v3Prompt).toContain(DEFAULT_PERSONAS.trust.state);
    for (const value of [V3.thesis, V3.payoff, V3.mechanism, V3.antiScope]) expect(v3Prompt).toContain(value);
    expect(v3Prompt).toContain("观点+案例+观点");
    expect(v3Prompt).toContain("本次写作约定优先");
    expect(v3Prompt).not.toContain("前 3 秒");
    expect(v3Prompt).not.toContain("主画像动作没达成");
    expect(v3Prompt).not.toContain("主张不可反驳");
  });

  it("故事不强加反常识开头，纠偏结构仍须按材料回应误区", () => {
    const story = buildReviewSystemPrompt({ hasResearch: true, angle: { ...V3, structure: "story" } });
    expect(story).toContain("亲历复盘");
    expect(story).not.toContain("纠偏没有成立");
    const myth = buildReviewSystemPrompt({ hasResearch: true, angle: { ...V3, structure: "myth-busting" } });
    expect(myth).toContain("纠偏没有成立");
    expect(myth).toContain(V3.misconception);
    expect(myth).toContain("不规定开头位置、不要求反问");
  });

  it("表达元素与行动建议是参考，不用凑数、凑转折或凑 CTA", () => {
    expect(v3Prompt).toContain("表达参考（不按数量验收）");
    expect(v3Prompt).toContain("痛点→理想状态、新奇点");
    expect(v3Prompt).toContain(V3.nextAction);
    expect(v3Prompt).toContain("不因缺少 CTA 或最小动作扣分");
    expect(v3Prompt).not.toContain("网感元素命中不足 2 个");
    expect(v3Prompt).not.toContain("结尾没有给观众一个最小动作");
    expect(v3Prompt).toContain("[未证实]");
    expect(v3Prompt).toContain("不得为塑造人设编造事实");
  });

  it("数字匹配不能替代事实核查，仍审对象、时间、范围和因果", () => {
    expect(v3Prompt).toContain("数字硬门只确认数值能在材料中找到，不能证明引用成立");
    expect(v3Prompt).toContain("对象、时间、范围、单位和上下文");
    expect(v3Prompt).not.toContain("不要再复核数字真假");
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
  it("手写方向即使没有调研或角度卡也要验收，且不能把规划当成事实", () => {
    const p = buildReviewSystemPrompt({ hasResearch: false, hasWritingContract: true });
    expect(p).toContain("判据零：创作者规划遵循");
    expect(p).toContain("遗漏明确要求、违背禁区");
    expect(p).toContain(WRITING_PRIORITY);
    expect(p).toContain("写作约定是创作意图，不是事实证据");
    expect(p).toContain("不得为兑现方向编造案例或数字");
    expect(p).not.toContain("只判 AI 味");
  });

  it("旧输入没有写作约定时不假装存在额外规划", () => {
    expect(buildReviewSystemPrompt({ hasResearch: false })).not.toContain("判据零");
  });

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

  it("无角度卡的手写要求逐字交给审稿人，不被调研开关吃掉", () => {
    const contract = "写给店主；只讲库存错误导致的积压；用一个门店场景展开；不写工具榜单。";
    const msg = buildReviewUserMessage({ ...base, writingContract: contract });
    expect(msg).toContain("【本稿写作约定");
    expect(msg).toContain(contract);
    expect(msg).toContain("已有的写作约定仍需验收");
    expect(msg).not.toContain("只判 AI 味");
  });

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
