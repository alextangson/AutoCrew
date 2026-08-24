import { describe, it, expect } from "vitest";
import {
  angleChoiceState,
  needsAnglePick,
  resolveEvidenceRefs,
  isRewritten,
  displayCard,
  NO_ANGLE_GATE,
} from "./angle-choice";
import type { AngleCard, SelectedAngle } from "../lib";

function card(over: Partial<AngleCard> = {}): AngleCard {
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
