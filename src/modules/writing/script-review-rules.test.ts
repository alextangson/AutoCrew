/**
 * 审稿规则补强（spec 2026-10-03 §七）：只测 prompt 组装与确定性提示，不碰模型输出。
 */
import { describe, it, expect } from "vitest";
import { buildReviewSystemPrompt, buildReviewUserMessage } from "./script-review-prompt.js";
import { isSpokenTrackPack } from "./script-review-rules.js";
import { findSpokenHints, spokenHintsBlock } from "./spoken-hints.js";
import type { AngleCardV2 } from "../research/brief-store.js";
import type { SubmitPayload } from "./script-payload.js";

const V2: AngleCardV2 = {
  id: "a", angle: "切入点", thesis: "论点", coreEvidenceIds: [], antiScope: "禁区",
  audiencePain: "痛点", holdTrigger: "触发", hookDraft: "钩子",
};
const PAYLOAD: SubmitPayload = { title: "标题", hook: "开头", body: "正文。", cta: "", hashtags: [] };
const LONG = "这是一句非常非常长而且一口气根本念不完的句子它一直在讲同一件事情没有停下来的意思";

describe("审稿 prompt 按稿型组装", () => {
  it("口播稿带口播流畅与开头诊断，长文不带", () => {
    const spoken = buildReviewSystemPrompt({ hasResearch: false, spoken: true });
    expect(spoken).toContain("## 判据：口播流畅");
    expect(spoken).toContain("段间断裂");
    expect(spoken).toContain("## 判据：开头诊断");
    expect(spoken).toContain("开头承诺落空");
    expect(spoken).toContain("不得要求补造身份");
    const article = buildReviewSystemPrompt({ hasResearch: false });
    expect(article).not.toContain("口播流畅");
    expect(article).not.toContain("开头诊断");
    expect(article).not.toContain("确定性提示");
  });

  it("新增 AI 腔判据所有稿型都在，且 rule 名可辨认", () => {
    for (const p of [buildReviewSystemPrompt({ hasResearch: false }), buildReviewSystemPrompt({ hasResearch: true, spoken: true })]) {
      for (const name of ["翻转过密：", "段尾金句化：", "稻草人：", "结尾祝福：", "翻译腔与硬换词："]) expect(p).toContain(name);
    }
  });

  it("创作者指定写法优先、不强制反常识/反问/CTA", () => {
    const p = buildReviewSystemPrompt({ hasResearch: false, spoken: true });
    expect(p).toContain("创作者规划或原话里明确指定的写法");
    expect(p).toContain("不要求反常识开头");
  });

  it("核心被稀释只在无调研、无角度时兜底出现", () => {
    expect(buildReviewSystemPrompt({ hasResearch: false })).toContain("核心被稀释（blocker）");
    expect(buildReviewSystemPrompt({ hasResearch: true })).not.toContain("核心被稀释");
    expect(buildReviewSystemPrompt({ hasResearch: false, angle: V2 })).not.toContain("核心被稀释");
    const withAngle = buildReviewSystemPrompt({ hasResearch: true, angle: V2 });
    expect(withAngle).toContain("论点被稀释");
    expect(withAngle).not.toContain("核心被稀释");
  });

  it("确定性提示只进口播稿的 user message，并声明不得给 blocker", () => {
    const base = { payload: PAYLOAD, humanizedText: `${LONG}。`, voiceSamples: [], platform: "douyin" };
    const spoken = buildReviewUserMessage({ ...base, spoken: true });
    expect(spoken).toContain("【确定性提示");
    expect(spoken).toContain("不得据此给 blocker");
    expect(buildReviewUserMessage(base)).not.toContain("确定性提示");
  });

  it("口播判定按赛道包", () => {
    expect(isSpokenTrackPack("koubo")).toBe(true);
    expect(isSpokenTrackPack("wechat-article")).toBe(false);
    expect(isSpokenTrackPack(undefined)).toBe(false);
  });
});

describe("findSpokenHints — 长句与书面语", () => {
  it("按句末标点切，超过 30 个汉字才算长句", () => {
    const hints = findSpokenHints(`短句。${LONG}。又一句短的！`);
    expect(hints.longSentences).toHaveLength(1);
    expect(hints.longSentences[0]).toMatch(/^这是一句/);
  });

  it("引号内引文、英文、代码、数字串不计入", () => {
    const text = `他说「${LONG}」然后走了。Claude Code and OpenAI Codex 123456789 3.14 \`const x = 1\` 很好用。`;
    expect(findSpokenHints(text).longSentences).toEqual([]);
  });

  it("没有句末标点的超长段落整段只算一次", () => {
    const para = `${LONG}，${LONG}，${LONG}`;
    expect(findSpokenHints(para).longSentences).toHaveLength(1);
  });

  it("书面语命中，引文里的不算", () => {
    expect(findSpokenHints("鉴于这个情况，综上所述就是这样。").writtenWords).toEqual(["鉴于", "综上所述"]);
    expect(findSpokenHints("他原话是「综上所述」。").writtenWords).toEqual([]);
  });

  it("什么都没扫到时提示块整块不出现", () => {
    expect(spokenHintsBlock("一句短话。")).toEqual([]);
  });
});
