import { describe, it, expect } from "vitest";
import { draftHash } from "../../../storage/draft-hash.js";
import type { Content } from "../../../storage/local-store.js";
import type { LedgerEntry } from "../../research/evidence-ledger.js";
import { CREATOR_EVIDENCE_ID, CREATOR_OPINION, renderSources, validateCoverage, type Citation } from "./project-evidence.js";

// 句子与台账条目取自 content-1790393879117-j2v9ag（2026-09-26 抖音口播）；user-topic 截取自真实选题描述
const S_370 = "Anthropic 做 Claude Code 的 Thariq，刚公开了一组实测：同一批难题，同一个模型，思考档位开到最低和开到最高，各做了 370 次。";
const S_OPENER = "先说这个开关到底管什么。";
const S_TECH = "国内有技术号管它叫「智商等级」，说烧脑的任务直接拉满。";
const S_RULE = "我自己用 AI 有条规矩，不让同一个 AI 既当运动员又当裁判员：一个出方案，另一个专门挑刺。";
const S_CONTEXT = "上下文，说白了就是这件事的来龙去脉：老板到底在意什么，这个客户上回在微信里为啥不高兴，这份复盘最后是拿给谁看的。";
const S_THARIQ = "可 Thariq 说，这一回更愿意用 low，先看懂 AI 想往哪走。";
const BODY = [S_370, S_OPENER, S_TECH, S_RULE, S_CONTEXT, S_THARIQ].join("\n\n");

const USER_TOPIC: LedgerEntry = {
  id: "user-topic", source: "user_claim",
  quote: "原文可用硬料（均出自 claude.dev 版）：Fable 5.1 在 TB3 上 low→max：370 次尝试通过 140→214，「漏掉情况」59→24，「读错题意」25→47（不降反升）。",
};
const EV_TECH: LedgerEntry = {
  id: "ev-8", source: "verified_quote", quote: "如果是编程等比较烧脑任务，我建议直接拉满",
  claim: "中文技术号把档位当智商开关，建议烧脑任务直接拉满", sourceId: "p8", sourceUrl: "https://jishuzhan.net/article/2031551393602011137",
};
const EV_THARIQ: LedgerEntry = {
  id: "ev-Hb03a71bbe4c7a4891f55", source: "verified_quote", quote: "I prefer using low effort to understand Claude’s vision",
  claim: "这个活上他更愿意用低档，先看懂 AI 的思路", sourceId: "p1", sourceUrl: "https://claude.dev/blog/spending-your-effort/",
};
const OWN: LedgerEntry = { id: "om:content-1787132351005-lbrm59:transcript:1:0", source: "own_claim", quote: "一个 AI 出方案，另一个 AI 专门挑刺。" };

function content(body = BODY, entries: LedgerEntry[] = [USER_TOPIC, EV_TECH, EV_THARIQ, OWN]): Content {
  return {
    id: "content-1790393879117-j2v9ag", title: "深度思考开到最高，AI 反而更常会错你的意", body, platform: "douyin", status: "draft_ready",
    tags: [], siblings: [], hashtags: [], publishedAt: null, publishUrl: null, performanceData: {}, assets: [], versions: [],
    createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z",
    evidenceLedger: { entries, lookups: [], budget: { max: 3, used: 0 } },
  } as Content;
}

function locate(sentence: string, body = BODY) {
  const start = body.indexOf(sentence);
  expect(start).toBeGreaterThanOrEqual(0);
  return { start, end: start + sentence.length, excerpt: sentence };
}

function cite(sentence: string, entry: LedgerEntry, body = BODY): Citation {
  return { ...locate(sentence, body), evidence_id: entry.id, sourceType: entry.source,
    ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}), quote: entry.quote, verification: "宿主读过原文，逐字对上" };
}

function creator(sentence: string, body = BODY, over: Partial<Citation> = {}): Citation {
  return { ...locate(sentence, body), evidence_id: CREATOR_EVIDENCE_ID, sourceType: CREATOR_OPINION, quote: "",
    verification: "创始人本人的工作规矩，本会话口述，无外部出处", ...over };
}

function check(citations: Citation[], c = content()): string[] {
  return validateCoverage(c, { draft_hash: draftHash(c), citations, reviewed_by: "writer-session", reviewed_at: "2026-09-26T08:30:27.401Z" });
}

const REQUIRED = [cite(S_370, USER_TOPIC), cite(S_TECH, EV_TECH), cite(S_THARIQ, EV_THARIQ)];

describe("validateCoverage — 只要求真实数字与归因", () => {
  it("口语「说」和行文量词不用挂出处；只有原文的选题描述（user-topic）可以直接引用", () => {
    expect(check(REQUIRED)).toEqual([]);
  });

  it("漏掉数字句或归因句照样拦，并说清是哪句、为什么", () => {
    const noNumber = check(REQUIRED.filter((c) => c.excerpt !== S_370));
    expect(noNumber).toHaveLength(1);
    expect(noNumber[0]).toMatch(/缺少数字\/归因出处定位：\d+–\d+「Anthropic.*（数字 370 次）/);
    const noAttribution = check(REQUIRED.filter((c) => c.excerpt !== S_THARIQ));
    expect(noAttribution).toHaveLength(1);
    expect(noAttribution[0]).toMatch(/缺少数字\/归因出处定位：.*（归因「可 Thariq 说」）/);
  });

  it("内部语料 om: 条目只有原文，同样可以引用", () => {
    expect(check([...REQUIRED, cite(S_RULE, OWN)])).toEqual([]);
  });
});

describe("validateCoverage — 创作者本人观点 / 亲历", () => {
  it("不挂台账条目，写明依据即可", () => {
    expect(check([...REQUIRED, creator(S_RULE), creator(S_CONTEXT, BODY, { quote: "智力平权了，但上下文却不平等" })])).toEqual([]);
  });

  it("缺依据、带外链、借用台账编号都拒绝", () => {
    expect(check([...REQUIRED, creator(S_RULE, BODY, { verification: " " })])).toEqual(["创作者观点缺少核查说明：写明出自哪次反馈或哪段亲历"]);
    expect(check([...REQUIRED, creator(S_RULE, BODY, { sourceUrl: EV_THARIQ.sourceUrl })])[0]).toMatch(/创作者观点不带外部链接/);
    expect(check([...REQUIRED, creator(S_RULE, BODY, { evidence_id: "ev-3" })])[0]).toMatch(/evidence_id 写 creator/);
  });

  it("台账对得上值的数字不能只记成创作者观点；同时引台账条目就行", () => {
    const onlyCreator = check([creator(S_370), cite(S_TECH, EV_TECH), cite(S_THARIQ, EV_THARIQ)]);
    expect(onlyCreator).toHaveLength(1);
    expect(onlyCreator[0]).toMatch(/数字「370 次」在台账 user-topic 有出处/);
    expect(check([creator(S_370), ...REQUIRED])).toEqual([]);
  });

  it("台账里没有的亲历数字可以记成创作者观点", () => {
    const body = "我自己试了 3 次，每次都先让它问清楚再动手。";
    expect(check([creator(body, body)], content(body))).toEqual([]);
    expect(check([], content(body))[0]).toMatch(/数字 3 次/);
  });
});

describe("renderSources", () => {
  it("创作者观点如实标注，不冒充外部来源", () => {
    const md = renderSources({ draft_hash: "h", citations: [creator(S_RULE)], reviewed_by: "w", reviewed_at: "t" });
    expect(md).toContain("来源：creator_opinion（创作者本人观点／亲历，不在证据台账）");
    expect(md).toContain("无外部原文／未外部核验");
    expect(md).toContain("原话：（无，正文即创作者本人表述）");
    expect(md).not.toContain("verified_quote");
  });

  it("已有来源等级的渲染逐字不变（交接包清单哈希不跟着变）", () => {
    const c = cite(S_TECH, EV_TECH);
    expect(renderSources({ draft_hash: "h", citations: [c], reviewed_by: "w", reviewed_at: "t" })).toBe(
      "# 出处清单\n\n结构覆盖已检查；语义支持以写稿侧核查为准。\n\n" +
        `## ${c.start}–${c.end} · ev-8\n\n正文：${S_TECH}\n\n来源：verified_quote\n\nhttps://jishuzhan.net/article/2031551393602011137\n\n` +
        "原话：如果是编程等比较烧脑任务，我建议直接拉满\n\n核查：宿主读过原文，逐字对上\n",
    );
  });
});
