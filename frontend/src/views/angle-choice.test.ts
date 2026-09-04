import { describe, it, expect } from "vitest";
import {
  angleChoiceState,
  angleDraft,
  angleDraftComplete,
  angleEditFields,
  applyAngleDraft,
  needsAnglePick,
  resolveEvidenceRefs,
  isRewritten,
  displayCard,
  sortedByScore,
  NO_ANGLE_GATE,
} from "./angle-choice";
import { isAngleCardV3, type AngleCardV2, type AngleCardV3, type SelectedAngle } from "../lib";

function card(over: Partial<AngleCardV2> = {}): AngleCardV2 {
  return {
    id: "angle-1",
    angle: "从退货率看直播带货",
    thesis: "退货率才是这门生意的真成本",
    coreEvidenceIds: ["ev-1"],
    antiScope: "不写平台补贴政策",
    audiencePain: "看不懂自己为什么不赚钱",
    holdTrigger: "第一段就给出一个反直觉数字",
    hookDraft: "GMV 涨了三倍,利润却是负的。",
    ...over,
  };
}

function selection(over: Partial<SelectedAngle> = {}): SelectedAngle {
  return { briefRevision: 3, angleId: "angle-1", card: card(), selectedAt: "2026-08-24T10:00:00.000Z", ...over };
}

describe("angleChoiceState", () => {
  it("没选过 = none", () => {
    expect(angleChoiceState(undefined, { revision: 3, stale: false })).toBe("none");
  });

  it("选的是最新版且简报没过期 = active", () => {
    expect(angleChoiceState(selection(), { revision: 3, stale: false })).toBe("active");
  });

  it("选的不是最新那版简报 = stale", () => {
    expect(angleChoiceState(selection({ briefRevision: 2 }), { revision: 3, stale: false })).toBe("stale");
  });

  it("简报因选题被改过期 = stale(哪怕版本号对得上)", () => {
    expect(angleChoiceState(selection(), { revision: 3, stale: true })).toBe("stale");
  });

  it("简报读不到 = stale,不是 none —— 选择还在盘上但一定不会被注入", () => {
    expect(angleChoiceState(selection(), null)).toBe("stale");
  });
});

describe("needsAnglePick", () => {
  it("有候选且没生效选择 → 先让人拍板", () => {
    expect(needsAnglePick({ cards: 3, state: "none" }, "")).toBe(true);
    expect(needsAnglePick({ cards: 3, state: "stale" }, "  ")).toBe(true);
  });

  it("选择生效中 → 直接派活", () => {
    expect(needsAnglePick({ cards: 3, state: "active" }, "")).toBe(false);
  });

  it("手写方向非空 = 已经给了角度(最高优先级),不再拦", () => {
    expect(needsAnglePick({ cards: 3, state: "none" }, "就写退货率那条线")).toBe(false);
  });

  it("没有候选卡 = 没有闸口(无简报/降级简报)", () => {
    expect(needsAnglePick(NO_ANGLE_GATE, "")).toBe(false);
    expect(needsAnglePick({ cards: 0, state: "stale" }, "")).toBe(false);
  });
});

describe("resolveEvidenceRefs", () => {
  const evidence = [
    { claim: "退货率 38%", quote: "…", sourceUrl: "https://example.com/a" },
    { claim: "履约成本翻倍", quote: "…", sourceUrl: "https://example.com/b" },
  ];

  it("位置 id 按 1-based 解到对应证据", () => {
    expect(resolveEvidenceRefs(evidence, ["ev-2"])).toEqual([
      { id: "ev-2", claim: "履约成本翻倍", sourceUrl: "https://example.com/b" },
    ]);
  });

  it("越界或格式不对的引用保留 id、claim 为 null —— 不静默丢掉", () => {
    const out = resolveEvidenceRefs(evidence, ["ev-9", "垃圾", "ev-0"]);
    expect(out.map((e) => e.id)).toEqual(["ev-9", "垃圾", "ev-0"]);
    expect(out.every((e) => e.claim === null)).toBe(true);
  });

  it("顺序与引用顺序一致", () => {
    expect(resolveEvidenceRefs(evidence, ["ev-2", "ev-1"]).map((e) => e.claim)).toEqual([
      "履约成本翻倍",
      "退货率 38%",
    ]);
  });
});

describe("isRewritten", () => {
  it("六个文本字段全同 = 没改写", () => {
    expect(isRewritten(card(), card())).toBe(false);
  });

  it("只差首尾空白不算改写", () => {
    expect(isRewritten(card(), card({ thesis: "  退货率才是这门生意的真成本 " }))).toBe(false);
  });

  it("改了论点/禁区都算改写", () => {
    expect(isRewritten(card(), card({ thesis: "换个论点" }))).toBe(true);
    expect(isRewritten(card(), card({ antiScope: "也不写供应链" }))).toBe(true);
  });
});

describe("displayCard", () => {
  const original = card();
  const mine = card({ thesis: "我自己的论点" });

  it("生效中的选中卡显示创始人那一版", () => {
    expect(displayCard(original, selection({ card: mine }), "active").thesis).toBe("我自己的论点");
  });

  it("过期的选择不冒充生效版,显示简报原卡", () => {
    expect(displayCard(original, selection({ card: mine }), "stale").thesis).toBe(original.thesis);
  });

  it("别的卡不受这份选择影响", () => {
    const other = card({ id: "angle-2", thesis: "另一张的论点" });
    expect(displayCard(other, selection({ card: mine }), "active").thesis).toBe("另一张的论点");
  });
});

// ---- 角度卡 v3(P1 spec §3.1/§4.6):联合类型下改写表单与展示序 ----

function cardV3(over: Partial<AngleCardV3> = {}): AngleCardV3 {
  return {
    cardVersion: 3,
    id: "angle-1",
    angle: "从退货率看直播带货",
    thesis: "退货率才是这门生意的真成本",
    coreEvidenceIds: ["ev-1"],
    antiScope: "不写平台补贴政策",
    hookDraft: "GMV 涨了三倍,利润却是负的。",
    evidenceLevel: "grounded",
    primaryPersona: "grow",
    misconception: "大家以为 GMV 高就是赚",
    mechanism: "退货把履约成本算两遍,毛利被吃掉",
    payoff: "看完能自己算一遍真毛利",
    nextAction: "把上月退货单拉出来算履约成本",
    counterResponse: "有人说退货率是行业常态——常态不等于可承受",
    personaGains: { grow: "看懂自己为什么不赚钱", trust: "有一套可复用的算法", convert: "决定要不要投这条线" },
    elements: ["反直觉数字", "亲历复盘"],
    evidenceNeeds: ["直播退货率行业均值", "履约成本构成"],
    structure: "myth-busting",
    score: 5,
    scoreReasons: ["元素 2 项", "有据 +1"],
    ...over,
  };
}

describe("isAngleCardV3", () => {
  it("判别只看 cardVersion === 3", () => {
    expect(isAngleCardV3(cardV3())).toBe(true);
    expect(isAngleCardV3(card())).toBe(false);
  });
});

describe("angleEditFields", () => {
  it("v2 卡还是原来那六格(行为不变)", () => {
    expect(angleEditFields(card()).map((f) => f.key)).toEqual([
      "angle", "thesis", "antiScope", "audiencePain", "holdTrigger", "hookDraft",
    ]);
  });

  it("v3 卡给出 v3 文本字段 + 待补证据(一行一条)", () => {
    const keys = angleEditFields(cardV3()).map((f) => f.key);
    expect(keys).toEqual([
      "angle", "thesis", "misconception", "mechanism", "payoff",
      "nextAction", "counterResponse", "antiScope", "hookDraft", "evidenceNeeds",
    ]);
    expect(angleEditFields(cardV3()).find((f) => f.key === "evidenceNeeds")?.kind).toBe("lines");
  });

  it("不可改的接榫字段一个都不在表单里", () => {
    const keys = angleEditFields(cardV3()).map((f) => f.key);
    for (const forbidden of ["id", "coreEvidenceIds", "cardVersion", "firsthandAnchor", "score", "scoreReasons"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("angleDraft / angleDraftComplete", () => {
  it("列表字段进表单时按行拼", () => {
    expect(angleDraft(cardV3()).evidenceNeeds).toBe("直播退货率行业均值\n履约成本构成");
  });

  it("每格都要有内容才让保存", () => {
    const d = angleDraft(cardV3());
    expect(angleDraftComplete(cardV3(), d)).toBe(true);
    expect(angleDraftComplete(cardV3(), { ...d, mechanism: "  " })).toBe(false);
    expect(angleDraftComplete(cardV3(), { ...d, evidenceNeeds: "\n  \n" })).toBe(false);
  });

  it("v2 的完成判断不变", () => {
    expect(angleDraftComplete(card(), angleDraft(card()))).toBe(true);
    expect(angleDraftComplete(card(), { ...angleDraft(card()), holdTrigger: "" })).toBe(false);
  });
});

describe("applyAngleDraft", () => {
  it("v2:六个文本字段覆盖,其余原样", () => {
    const out = applyAngleDraft(card(), { ...angleDraft(card()), thesis: "换个论点" }) as AngleCardV2;
    expect(out.thesis).toBe("换个论点");
    expect(out.id).toBe("angle-1");
    expect(out.coreEvidenceIds).toEqual(["ev-1"]);
  });

  it("v3:文本字段覆盖,待补证据按行拆(空行丢掉)", () => {
    const src = cardV3();
    const out = applyAngleDraft(src, {
      ...angleDraft(src),
      misconception: "大家以为退货是小事",
      evidenceNeeds: "退货率均值\n\n  履约成本构成  \n",
    }) as AngleCardV3;
    expect(out.misconception).toBe("大家以为退货是小事");
    expect(out.evidenceNeeds).toEqual(["退货率均值", "履约成本构成"]);
  });

  it("v3:分与评分理由一律不回传(服务端重算)", () => {
    const out = applyAngleDraft(cardV3(), angleDraft(cardV3()));
    expect("score" in out).toBe(false);
    expect("scoreReasons" in out).toBe(false);
  });

  it("v3:id / 证据引用 / 卡版本 / 第一手锚点原样带回,不给改", () => {
    const anchor = { kind: "transcript" as const, contentId: "c1", chunkId: "om:c1:transcript:2:0", excerptHash: "abc123", quote: "我自己做插件那次" };
    const out = applyAngleDraft(cardV3({ firsthandAnchor: anchor }), {
      ...angleDraft(cardV3()),
      // 表单里就没有这几格,这里塞进来也不该生效
      id: "angle-9",
      coreEvidenceIds: "ev-9",
      cardVersion: "2",
      firsthandAnchor: "伪造",
    }) as AngleCardV3;
    expect(out.id).toBe("angle-1");
    expect(out.coreEvidenceIds).toEqual(["ev-1"]);
    expect(out.cardVersion).toBe(3);
    expect(out.firsthandAnchor).toEqual(anchor);
  });
});

describe("isRewritten(v3)", () => {
  it("全同 = 没改写;只差首尾空白也不算", () => {
    expect(isRewritten(cardV3(), cardV3())).toBe(false);
    expect(isRewritten(cardV3(), cardV3({ mechanism: "  " + cardV3().mechanism + " " }))).toBe(false);
  });

  it("改了 v3 独有字段算改写", () => {
    expect(isRewritten(cardV3(), cardV3({ payoff: "换个收获" }))).toBe(true);
    expect(isRewritten(cardV3(), cardV3({ evidenceNeeds: ["只剩一条"] }))).toBe(true);
  });

  it("分变了不算改写(分是代码算的,不是创始人写的)", () => {
    expect(isRewritten(cardV3(), cardV3({ score: 9, scoreReasons: ["别的理由"] }))).toBe(false);
  });

  it("换了卡版本 = 不是同一张卡", () => {
    expect(isRewritten(card(), cardV3())).toBe(true);
  });
});

describe("sortedByScore", () => {
  it("有分的按分从高到低", () => {
    const cards = [cardV3({ id: "a", score: 3 }), cardV3({ id: "b", score: 7 }), cardV3({ id: "c", score: 5 })];
    expect(sortedByScore(cards).map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("同分保持原序(排序稳定,列表不会来回跳)", () => {
    const cards = [cardV3({ id: "a", score: 5 }), cardV3({ id: "b", score: 5 }), cardV3({ id: "c", score: 9 })];
    expect(sortedByScore(cards).map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("没分的(v2 卡 / v3 无分)排在有分的后面,彼此保持原序", () => {
    const cards = [card({ id: "v2a" }), cardV3({ id: "noscore", score: undefined }), cardV3({ id: "scored", score: 2 })];
    expect(sortedByScore(cards).map((c) => c.id)).toEqual(["scored", "v2a", "noscore"]);
  });

  it("全都没分 = 原序不动", () => {
    const cards = [card({ id: "a" }), card({ id: "b" })];
    expect(sortedByScore(cards).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("排序不改原数组,也不选中任何一张(选择是另一条线)", () => {
    const cards = [cardV3({ id: "a", score: 1 }), cardV3({ id: "b", score: 8 })];
    sortedByScore(cards);
    expect(cards.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
