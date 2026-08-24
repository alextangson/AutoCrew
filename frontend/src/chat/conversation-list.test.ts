import { describe, it, expect } from "vitest";
import {
  relativeTime,
  conversationHint,
  conversationGroups,
  findConversationForContent,
  decideConversationSwitch,
  decideFollowupRefresh,
  type ConversationSummary,
} from "./conversation-list";

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

/** 绑定了稿件的会话 */
function bound(id: string, contentId: string, updatedAt: string): ConversationSummary {
  return { id, title: id, updatedAt, contentId };
}

describe("findConversationForContent", () => {
  const list = [
    bound("旧的A", "c-1", at(3 * 3_600_000)),
    bound("新的A", "c-1", at(60_000)),
    bound("B", "c-2", at(30_000)),
    conv("没绑定的", at(0)),
  ];

  it("命中这篇稿件名下 updatedAt 最新的一条", () => {
    expect(findConversationForContent(list, "c-1")?.id).toBe("新的A");
    expect(findConversationForContent(list, "c-2")?.id).toBe("B");
  });

  it("没聊过的稿件回 undefined，旧会话（无绑定字段）永不被认领", () => {
    expect(findConversationForContent(list, "c-9")).toBeUndefined();
    expect(findConversationForContent([conv("旧", at(0))], "c-1")).toBeUndefined();
  });

  it("空 contentId 不匹配任何东西", () => {
    expect(findConversationForContent(list, "")).toBeUndefined();
  });

  it("坏时间戳不崩：当作最旧，但唯一候选照样返回", () => {
    expect(findConversationForContent([bound("坏", "c-1", "xxx"), bound("好", "c-1", at(0))], "c-1")?.id).toBe("好");
    expect(findConversationForContent([bound("坏", "c-1", "xxx")], "c-1")?.id).toBe("坏");
  });
});

describe("decideConversationSwitch", () => {
  const list = [bound("A", "c-1", at(60_000)), bound("B", "c-2", at(30_000))];

  it("当前这段已经属于这篇稿件 → 不动（别打断正在聊的）", () => {
    expect(decideConversationSwitch({ list, contentId: "c-1", activeId: "A" })).toEqual({ action: "stay" });
  });

  it("换到别的稿件 → 切到它名下最近那段", () => {
    expect(decideConversationSwitch({ list, contentId: "c-2", activeId: "A" })).toEqual({ action: "load", id: "B" });
  });

  it("这篇稿件还没聊过 → 进新会话空状态", () => {
    expect(decideConversationSwitch({ list, contentId: "c-9", activeId: "A" })).toEqual({ action: "fresh" });
  });

  it("非稿件视图（contentId 为空）→ 会话不动", () => {
    expect(decideConversationSwitch({ list, contentId: "", activeId: "A" })).toEqual({ action: "stay" });
  });

  it("当前没有激活会话时照常按绑定判定", () => {
    expect(decideConversationSwitch({ list, contentId: "c-1" })).toEqual({ action: "load", id: "A" });
    expect(decideConversationSwitch({ list, contentId: "c-9" })).toEqual({ action: "fresh" });
  });
});

describe("decideFollowupRefresh（调研回报到了右栏怎么动）", () => {
  it("回报落在眼前这段、本页空着 → 直接重载，让它出现在眼前", () => {
    expect(decideFollowupRefresh({ conversationId: "A", activeId: "A", busy: false })).toEqual({
      action: "reload",
      id: "A",
    });
  });

  it("本页正跑着一轮 → 不重载（会把进行中的气泡冲掉），只刷列表 + 提示", () => {
    expect(decideFollowupRefresh({ conversationId: "A", activeId: "A", busy: true })).toEqual({ action: "notify" });
  });

  it("回报落在别的会话 → 刷列表 + 提示，不把用户拽走", () => {
    expect(decideFollowupRefresh({ conversationId: "B", activeId: "A", busy: false })).toEqual({ action: "notify" });
    expect(decideFollowupRefresh({ conversationId: "B", busy: false })).toEqual({ action: "notify" });
  });

  it("坏帧（没带会话 id）丢弃", () => {
    expect(decideFollowupRefresh({ conversationId: undefined, activeId: "A", busy: false })).toEqual({ action: "ignore" });
    expect(decideFollowupRefresh({ conversationId: "", activeId: "A", busy: false })).toEqual({ action: "ignore" });
    expect(decideFollowupRefresh({ conversationId: 7, activeId: "A", busy: false })).toEqual({ action: "ignore" });
  });
});
