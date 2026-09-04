/**
 * angle-cards.test.ts — 角度卡规则本的 v2/v3 联合行为（P1 spec §3.1）。
 *
 * 这一组守的是「改写不能改接榫」：创始人可以改任何文字，但 id / cardVersion /
 * coreEvidenceIds / firsthandAnchor.excerptHash 是这张卡与简报的引用关系，
 * 改了归因与补证就跟着错；分数则永远由服务端重算，客户端说了不算。
 */
import { describe, it, expect } from "vitest";

import {
  angleCardsOf,
  cardAudiencePain,
  cardHoldTrigger,
  checkDistinct,
  findAngleCard,
  parseAngleCard,
} from "./angle-cards.js";
import { excerptHashOf } from "./angle-stage.js";
import {
  BRIEF_SCHEMA_VERSION,
  isAngleCardV3,
  type AngleCardV2,
  type AngleCardV3,
  type ResearchBrief,
} from "./brief-store.js";

const EV_QUOTE = "62% 的人每天使用 AI 编程助手，但维护成本上升了三成";

const V2: AngleCardV2 = {
  id: "angle-1",
  angle: "算一笔维护账",
  thesis: "省下的编码时间被维护成本吃回去了",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写工具横评",
  audiencePain: "老板拿提效数字压 KPI",
  holdTrigger: "看到自己上周那笔返工账",
  hookDraft: "提效 55% 是真的，只是账没算完。",
};

const V3: AngleCardV3 = {
  cardVersion: 3,
  id: "angle-2",
  angle: "算一笔维护账",
  thesis: "省下的编码时间被维护成本吃回去了，净收益接近于零",
  evidenceLevel: "grounded",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写工具横评、不写怎么写 prompt",
  hookDraft: "提效 55% 是真的，只是账没算完。",
  primaryPersona: "grow",
  misconception: "以为提效数字等于净收益",
  mechanism: "补全省下的是打字时间，维护花的是理解时间；理解更贵，所以账会反过来",
  payoff: "你会知道该拿哪一段时间去比，今天就把上周的返工时间记一次",
  nextAction: "把上周被 AI 改过的代码返工时间记下来",
  counterResponse: "有人会说熟练了就好——熟练解决的是打字，不是理解成本",
  personaGains: { grow: "听懂提效数字怎么骗人", trust: "有可复算的账", convert: "知道验收该验什么" },
  elements: ["新奇点", "爽点"],
  firsthandAnchor: {
    kind: "brief_evidence",
    chunkId: "ev-1",
    excerptHash: excerptHashOf(EV_QUOTE),
    quote: "维护成本上升了三成",
  },
  evidenceNeeds: ["返工时长的公开统计"],
  structure: "myth-busting",
  score: 6,
  scoreReasons: ["元素 2", "有简报证据（grounded）", "第一手锚点校验通过", "主画像=涨粉（账号当前目标）"],
};

function makeBrief(): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "工具已普及，分歧在维护成本。",
    perspectives: [],
    tensions: ["普及率高与净收益低同时成立"],
    angleSuggestions: [],
    angleCards: [V2, V3],
    evidence: [{ claim: "使用率过半", quote: EV_QUOTE, sourceUrl: "https://example.com/survey" }],
    assetPicks: [],
    missingPerspectives: [],
    gaps: [],
    generatedAt: "2026-09-04T00:00:00.000Z",
    revision: 1,
    topicHash: "hash-1",
  };
}

/** 改写载荷：默认原样重交 V3，`over` 覆盖要改的字段 */
function rewrite(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...V3, ...over };
}

describe("联合类型读侧", () => {
  it("一份简报里 v2 与 v3 并存，都读得出来", () => {
    const brief = makeBrief();
    expect(angleCardsOf(brief)).toHaveLength(2);
    expect(isAngleCardV3(findAngleCard(brief, "angle-1"))).toBe(false);
    expect(isAngleCardV3(findAngleCard(brief, "angle-2"))).toBe(true);
  });

  it("v2 展示字段的兼容读法：v3 给主画像 + 误区 / 停留触发 + 元素", () => {
    expect(cardAudiencePain(V2)).toBe(V2.audiencePain);
    expect(cardHoldTrigger(V2)).toBe(V2.holdTrigger);
    expect(cardAudiencePain(V3)).toContain("以为提效数字等于净收益");
    expect(cardHoldTrigger(V3)).toContain("新奇点");
  });

  it("checkDistinct 对两版卡是同一把尺（导出给立意 pass 复用）", () => {
    const problems: string[] = [];
    checkDistinct([V2, { ...V3, thesis: V2.thesis, antiScope: V2.antiScope }], problems);
    expect(problems.join("")).toContain("同一个角度换套说法");
  });
});

describe("parseAngleCard：v3 改写", () => {
  it("改文字 → 收下，分数由服务端重算，客户端的 score 被丢弃", () => {
    const got = parseAngleCard(rewrite({ thesis: "净收益接近于零，账要按理解成本算", score: 99 }), makeBrief(), "angle-2");
    expect(typeof got).not.toBe("string");
    if (typeof got === "string") return;
    expect(isAngleCardV3(got)).toBe(true);
    if (!isAngleCardV3(got)) return;
    expect(got.thesis).toBe("净收益接近于零，账要按理解成本算");
    expect(got.score).toBe(6); // 元素 2 + grounded 1 + 锚点 2 + grow 1
    expect(got.scoreReasons).toContain("第一手锚点校验通过");
  });

  it("必填 v3 文本清空 → 拒（点名字段）", () => {
    expect(parseAngleCard(rewrite({ mechanism: "" }), makeBrief(), "angle-2")).toContain("mechanism");
    expect(parseAngleCard(rewrite({ payoff: "" }), makeBrief(), "angle-2")).toContain("payoff");
    expect(parseAngleCard(rewrite({ misconception: "" }), makeBrief(), "angle-2")).toContain("misconception");
  });

  it("接榫不可改：coreEvidenceIds / cardVersion / excerptHash", () => {
    expect(parseAngleCard(rewrite({ coreEvidenceIds: [] }), makeBrief(), "angle-2")).toContain("coreEvidenceIds 不可改");
    expect(parseAngleCard(rewrite({ cardVersion: 2 }), makeBrief(), "angle-2")).toContain("cardVersion 不可改");
    expect(
      parseAngleCard(
        rewrite({ firsthandAnchor: { ...V3.firsthandAnchor, excerptHash: "deadbeefdeadbeef" } }),
        makeBrief(),
        "angle-2",
      ),
    ).toContain("excerptHash 不可改");
  });

  it("改锚点引文：仍逐字则收，转述则拒", () => {
    const ok = parseAngleCard(
      rewrite({ firsthandAnchor: { ...V3.firsthandAnchor, quote: "62% 的人每天使用 AI 编程助手" } }),
      makeBrief(),
      "angle-2",
    );
    expect(typeof ok).not.toBe("string");

    const bad = parseAngleCard(
      rewrite({ firsthandAnchor: { ...V3.firsthandAnchor, quote: "维护成本大概涨了三成左右" } }),
      makeBrief(),
      "angle-2",
    );
    expect(bad).toContain("逐字");
  });

  it("原卡没锚点时不许在改写里新造一个", () => {
    const brief = makeBrief();
    brief.angleCards = [{ ...V3, firsthandAnchor: undefined }];
    const got = parseAngleCard(rewrite(), brief, "angle-2");
    expect(got).toContain("不能在改写里新增");
  });

  it("元素改到只剩 1 个 / 改成不存在的画像 → 拒", () => {
    expect(parseAngleCard(rewrite({ elements: ["爽点"] }), makeBrief(), "angle-2")).toContain("网感元素需 ≥2");
    expect(parseAngleCard(rewrite({ primaryPersona: "boss" }), makeBrief(), "angle-2")).toContain("primaryPersona");
  });

  it("换 id → 拒（改写不能换一张卡）", () => {
    expect(parseAngleCard(rewrite({ id: "angle-1" }), makeBrief(), "angle-2")).toContain("不一致");
  });
});

describe("parseAngleCard：v2 卡照旧", () => {
  it("v2 改写走老路径，逐字收下", () => {
    const got = parseAngleCard({ ...V2, thesis: "维护成本吃掉了全部收益" }, makeBrief(), "angle-1");
    expect(typeof got).not.toBe("string");
    if (typeof got === "string") return;
    expect(isAngleCardV3(got)).toBe(false);
    expect(got.thesis).toBe("维护成本吃掉了全部收益");
  });

  it("v2 卡不能在改写里顺手升级成 v3", () => {
    expect(parseAngleCard({ ...V2, cardVersion: 3 }, makeBrief(), "angle-1")).toContain("重跑立意");
  });

  it("v2 缺必填 / 引不到的证据 → 拒", () => {
    expect(parseAngleCard({ ...V2, audiencePain: "" }, makeBrief(), "angle-1")).toContain("audiencePain");
    expect(parseAngleCard({ ...V2, coreEvidenceIds: ["ev-9"] }, makeBrief(), "angle-1")).toContain("ev-9");
  });
});
