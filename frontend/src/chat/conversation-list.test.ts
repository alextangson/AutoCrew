import { describe, it, expect } from "vitest";
import { relativeTime, conversationHint, conversationGroups, type ConversationSummary } from "./conversation-list";

/** 固定"现在"= 2026-08-23 15:00 本地时间，所有断言都相对它 */
const NOW = new Date(2026, 7, 23, 15, 0, 0).getTime();
const at = (ms: number): string => new Date(NOW - ms).toISOString();

function conv(id: string, updatedAt: string, turns?: number): ConversationSummary {
  return { id, title: id, updatedAt, ...(turns !== undefined ? { turns } : {}) };
}

describe("relativeTime", () => {
  it("一分钟内是刚刚", () => {
    expect(relativeTime(at(5_000), NOW)).toBe("刚刚");
  });

  it("分钟/小时各自成档", () => {
    expect(relativeTime(at(7 * 60_000), NOW)).toBe("7 分钟前");
    expect(relativeTime(at(3 * 3_600_000), NOW)).toBe("3 小时前");
  });

  it("超过一天改用日期，不出现「38 小时前」", () => {
    expect(relativeTime(new Date(2026, 6, 4, 9, 0).toISOString(), NOW)).toBe("7月4日");
  });

  it("坏时间戳回空串，绝不渲染 NaN", () => {
    expect(relativeTime("不是时间", NOW)).toBe("");
    expect(relativeTime("", NOW)).toBe("");
  });

  it("未来时间（时钟漂移）按刚刚算，不出现负数", () => {
    expect(relativeTime(at(-9 * 3_600_000), NOW)).toBe("刚刚");
  });
});

describe("conversationHint", () => {
  it("轮数与时间用点分隔", () => {
    expect(conversationHint(conv("a", at(2 * 3_600_000), 6), NOW)).toBe("6轮 · 2 小时前");
  });

  it("零轮只留时间，不留孤零零的分隔点", () => {
    expect(conversationHint(conv("a", at(30_000), 0), NOW)).toBe("刚刚");
  });

  it("坏时间戳只留轮数", () => {
    expect(conversationHint(conv("a", "坏", 3), NOW)).toBe("3轮");
  });
});

describe("conversationGroups", () => {
  it("按自然日分今天/昨天/最近 7 天/更早", () => {
    const list = [
      conv("今天早些", new Date(2026, 7, 23, 1, 0).toISOString()),
      conv("昨天", new Date(2026, 7, 22, 23, 0).toISOString()),
      conv("五天前", new Date(2026, 7, 18, 10, 0).toISOString()),
      conv("上个月", new Date(2026, 6, 4, 10, 0).toISOString()),
    ];
    expect(conversationGroups(list, NOW).map((g) => [g.name, g.items.map((i) => i.id)])).toEqual([
      ["今天", ["今天早些"]],
      ["昨天", ["昨天"]],
      ["最近 7 天", ["五天前"]],
      ["更早", ["上个月"]],
    ]);
  });

  it("空组不出现（不留只有标题的空分组）", () => {
    const groups = conversationGroups([conv("a", at(60_000))], NOW);
    expect(groups.map((g) => g.name)).toEqual(["今天"]);
  });

  it("2 小时前但已跨到昨天的，算昨天而不是今天", () => {
    const nearMidnight = new Date(2026, 7, 23, 1, 0, 0).getTime();
    const groups = conversationGroups([conv("a", new Date(2026, 7, 22, 23, 0).toISOString())], nearMidnight);
    expect(groups[0]?.name).toBe("昨天");
  });

  it("坏时间戳落更早，不打断正常时间轴", () => {
    const groups = conversationGroups([conv("坏", "xxx"), conv("今天", at(60_000))], NOW);
    expect(groups.map((g) => [g.name, g.items.map((i) => i.id)])).toEqual([
      ["今天", ["今天"]],
      ["更早", ["坏"]],
    ]);
  });

  it("全空回空数组", () => {
    expect(conversationGroups([], NOW)).toEqual([]);
  });
});
