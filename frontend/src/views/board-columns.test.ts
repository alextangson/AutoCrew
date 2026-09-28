import { describe, expect, it } from "vitest";
import {
  backMoves, boardCards, canDrop, estimateText, itemMeta, publishLine, topicSourceLabel, visibleCards,
  type BoardItem, type BoardTopic, type PlatformPublication,
} from "./board-columns";

const NOW = Date.parse("2026-09-28T12:00:00+08:00");
const item = (id: string, over: Partial<BoardItem> = {}): BoardItem => ({
  id, title: `稿 ${id}`, platform: "douyin", status: "draft_ready", topicId: null, column: "待录制",
  createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", draftReadyAt: null, chars: 0, finalDurationMs: null,
  cover: null, publish: null, publishTime: null, lastError: null, blockedReason: null, ...over,
});
const topic = (id: string, over: Partial<BoardTopic> = {}): BoardTopic => ({ id, title: id, source: null, score: null, createdAt: "2026-09-26T00:00:00Z", renewedAt: null, ...over });
const pub = (over: Partial<PlatformPublication>): PlatformPublication => ({ platform: "douyin", state: "scheduled", submitted: true, raw: "scheduled", review: null, time: null, reason: null, url: null, campaigns: [], manual: null, ...over });

describe("boardCards", () => {
  it("选题按分数排，没分数的在后；已发布按发布时间倒序只留 5 条，未来的定时在最上面", () => {
    const published = Array.from({ length: 7 }, (_, i) => item(`p${i}`, { column: "已发布", status: "published", publishTime: `2026-09-2${i}T10:00:00Z` }));
    const future = item("future", { column: "已发布", status: "published", publishTime: "2026-10-02T10:00:00Z" });
    const cards = boardCards({ topics: [topic("a"), topic("b", { score: 85 }), topic("c", { score: 70 })], items: [...published, future], wordsPerMinute: null });
    expect(cards.选题.map((c) => c.kind === "topic" && c.topic.id)).toEqual(["b", "c", "a"]);
    expect(cards.已发布.map((c) => c.kind === "item" && c.item.id)).toEqual(["future", "p6", "p5", "p4", "p3"]);
    expect(cards.剪辑中).toEqual([]);
  });

  it("列里超过 8 张：先给 8 张 + 剩余条数；展开后全给", () => {
    const cards = Array.from({ length: 11 }, (_, i) => ({ kind: "item" as const, item: item(`d${i}`) }));
    expect(visibleCards(cards, false)).toMatchObject({ hidden: 3 });
    expect(visibleCards(cards, false).shown).toHaveLength(8);
    expect(visibleCards(cards, true)).toMatchObject({ hidden: 0 });
  });
});

describe("拖动与往回退", () => {
  it("只有选题 → 写稿中能拖", () => {
    expect(canDrop("选题", "写稿中")).toBe(true);
    expect(canDrop("选题", "已发布")).toBe(false);
    expect(canDrop("待录制", "已发布")).toBe(false);
    expect(canDrop("剪辑中", "待录制")).toBe(false);
  });

  it("往回退只给状态机允许的那一步，撤回交接要说清后果；往前跳不在菜单里", () => {
    expect(backMoves(item("x", { status: "editing", column: "剪辑中" }))[0]).toMatchObject({ target: "draft_ready" });
    expect(backMoves(item("x", { status: "editing", column: "剪辑中" }))[0].body).toContain("交接会被撤回");
    expect(backMoves(item("x", { status: "draft_ready" }))[0]).toMatchObject({ target: "drafting" });
    for (const status of ["draft_ready", "approved", "editing", "publish_ready", "published", "drafting"]) {
      expect(backMoves(item("x", { status })).map((m) => m.target)).not.toContain("published");
    }
  });

  it("平台上已经真提交了：不给退回待发布；只有手动标记时可以退", () => {
    const submitted = item("x", { status: "published", column: "已发布", publish: { kind: "ok", platforms: [pub({})] } });
    expect(backMoves(submitted)).toEqual([]);
    const manualOnly = item("y", { status: "published", column: "已发布", publish: { kind: "ok", platforms: [pub({ state: "manual", manual: { platform: "douyin", at: "2026-09-28T00:00:00Z" } })] } });
    expect(backMoves(manualOnly)[0]).toMatchObject({ target: "publish_ready" });
  });
});

describe("文案", () => {
  it("来源标签：雷达带具体源、收件箱、其余都是你建的", () => {
    expect(topicSourceLabel("radar:GitHub Trending")).toBe("雷达 · GitHub Trending");
    expect(topicSourceLabel("inbox:wechat")).toBe("收件箱");
    expect(topicSourceLabel("x:trq212/1")).toBe("你建的");
    expect(topicSourceLabel(null)).toBe("你建的");
  });

  it("发布行：定时带审核、没投的不标红、没通过标红带原因、不认识的写原值", () => {
    expect(publishLine(pub({ time: "2026-10-02T10:00:00Z", review: "reviewing" }), NOW)).toMatchObject({ tone: "ok" });
    expect(publishLine(pub({ time: "2026-10-02T10:00:00Z", review: "reviewing" }), NOW).text).toContain("审核中");
    expect(publishLine(pub({ time: "2026-10-02T10:00:00Z", review: "reviewing" }), NOW, "2026-10-02T18:00:00+08:00").text).toBe("定时 · 审核中");
    expect(publishLine(pub({ state: "overdue" }), NOW).text).toContain("应已公开");
    expect(publishLine(pub({ state: "not_submitted", submitted: false }), NOW).tone).toBe("muted");
    expect(publishLine(pub({ state: "rejected", reason: "封面违规" }), NOW)).toEqual({ text: "没通过：封面违规", tone: "red" });
    expect(publishLine(pub({ state: "unknown", raw: "queued_by_robot", submitted: false }), NOW).text).toBe("状态：queued_by_robot");
  });

  it("估时长：按语速取半分钟；没有语速不显示", () => {
    expect(estimateText(2337, 315)).toBe("约 7.5 分钟");
    expect(estimateText(1890, 315)).toBe("约 6 分钟");
    expect(estimateText(2000, null)).toBeNull();
    expect(itemMeta(item("x", { chars: 2000 }), null, NOW)).not.toContain("约");
  });
});
