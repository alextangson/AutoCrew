import { describe, expect, it } from "vitest";
import {
  backMoves, boardCards, dropAction, estimateText, statusColumn, itemMeta, ontologyNotice, publishLine, topicSourceLabel, visibleCards,
  type BoardItem, type BoardTopic, type PlatformPublication,
} from "./board-columns";

const NOW = Date.parse("2026-09-28T12:00:00+08:00");
const item = (id: string, over: Partial<BoardItem> = {}): BoardItem => ({
  id, title: `稿 ${id}`, platform: "douyin", status: "approved", topicId: null, column: "待录制",
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
  const kind = (from: Parameters<typeof dropAction>[0], it: BoardItem | null, to: Parameters<typeof dropAction>[2]) => dropAction(from, it, to);
  const video = (status: string, column: BoardItem["column"]) => item("v", { status, column });
  const article = (status: string, column: BoardItem["column"]) => item("a", { status, column, platform: "wechat_mp" });

  it("选题只能拖到写稿中；同列放下什么都不做", () => {
    expect(kind("选题", null, "写稿中")).toEqual({ kind: "start" });
    expect(kind("选题", null, "待录制")).toMatchObject({ kind: "refuse" });
    expect(kind("写稿中", video("draft_ready", "写稿中"), "写稿中")).toEqual({ kind: "none" });
  });

  it("写完等认的稿拖到下一站 = 认稿；没评审记录也照样能认（规则只看状态）", () => {
    expect(kind("写稿中", video("draft_ready", "写稿中"), "待录制")).toEqual({ kind: "approve" });
    expect(kind("写稿中", article("draft_ready", "写稿中"), "待发布")).toEqual({ kind: "approve" });
  });

  it("AI 还在写的稿不能认", () => {
    for (const s of ["drafting", "needs_evidence", "reviewing", "revision"]) {
      expect(kind("写稿中", video(s, "写稿中"), "待录制")).toEqual({ kind: "refuse", reason: "AI 还在写，写完再认" });
    }
  });

  it("跳列一律拒，并说清先做哪步", () => {
    expect(kind("写稿中", video("draft_ready", "写稿中"), "剪辑中")).toMatchObject({ kind: "refuse", reason: expect.stringContaining("先认稿") });
    expect(kind("写稿中", video("draft_ready", "写稿中"), "待发布")).toMatchObject({ kind: "refuse", reason: expect.stringContaining("先认稿") });
    expect(kind("写稿中", article("draft_ready", "写稿中"), "已发布")).toMatchObject({ kind: "refuse", reason: expect.stringContaining("先认稿") });
    expect(kind("待录制", video("approved", "待录制"), "待发布")).toEqual({ kind: "refuse", reason: "要先交剪辑" });
    expect(kind("剪辑中", video("editing", "剪辑中"), "已发布")).toMatchObject({ kind: "refuse" });
  });

  it("交剪辑、成片只打开工作台；待发布 → 已发布 是手动标记", () => {
    expect(kind("待录制", video("approved", "待录制"), "剪辑中")).toEqual({ kind: "open-handoff" });
    expect(kind("剪辑中", video("editing", "剪辑中"), "待发布")).toEqual({ kind: "open-final" });
    expect(kind("待发布", video("publish_ready", "待发布"), "已发布")).toEqual({ kind: "publish" });
    expect(kind("待发布", article("approved", "待发布"), "已发布")).toEqual({ kind: "publish" });
  });

  it("往回拖：落在「⋯」退路的目标列就走同一个退路，否则拒", () => {
    expect(kind("待录制", video("approved", "待录制"), "写稿中")).toMatchObject({ kind: "back", move: { target: "reviewing" } });
    expect(kind("待发布", video("publish_ready", "待发布"), "待录制")).toMatchObject({ kind: "back", move: { target: "approved" } });
    expect(kind("已发布", article("published", "已发布"), "待发布")).toMatchObject({ kind: "back", move: { target: "publish_ready" } });
    expect(kind("已发布", video("published", "已发布"), "待发布")).toEqual({ kind: "refuse", reason: "这张卡不能往回退" });
    expect(kind("待发布", video("publish_ready", "待发布"), "写稿中")).toMatchObject({ kind: "refuse" });
    expect(kind("写稿中", video("drafting", "写稿中"), "选题")).toEqual({ kind: "refuse", reason: "这张卡不能往回退" });
  });

  it("状态落列与服务端同表：没认的稿在写稿中，认过的视频待录制、非视频待发布", () => {
    expect(statusColumn("draft_ready", true)).toBe("写稿中");
    expect(statusColumn("draft_ready", false)).toBe("写稿中");
    expect(statusColumn("approved", true)).toBe("待录制");
    expect(statusColumn("approved", false)).toBe("待发布");
  });

  it("往回退只给状态机允许的那一步，撤回交接要说清后果；往前跳不在菜单里", () => {
    expect(backMoves(item("x", { status: "editing", column: "剪辑中" }))[0]).toMatchObject({ target: "draft_ready", revoke: true });
    expect(kind("剪辑中", item("x", { status: "editing", column: "剪辑中" }), "写稿中")).toMatchObject({ kind: "back", move: { revoke: true } });
    expect(backMoves(item("x", { status: "editing", column: "剪辑中" }))[0].body).toContain("交接会被撤回");
    expect(backMoves(item("x", { status: "draft_ready" }))[0]).toMatchObject({ target: "drafting" });
    for (const status of ["draft_ready", "approved", "editing", "publish_ready", "published", "drafting"]) {
      expect(backMoves(item("x", { status })).map((m) => m.target)).not.toContain("published");
    }
  });

  it("平台上已经真提交了：不给退回待发布；只有手动标记时可以退", () => {
    const submitted = item("x", { status: "published", column: "已发布", publish: { kind: "ok", platforms: [pub({})] } });
    expect(backMoves(submitted)).toEqual([]);
    const manualOnly = item("y", { status: "published", column: "已发布", platform: "wechat_mp", publish: { kind: "ok", platforms: [pub({ state: "manual", manual: { platform: "douyin", at: "2026-09-28T00:00:00Z" } })] } });
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

  it("写稿中里等认的稿写「写完 X 前」，认过的在待录制写估时长和定稿时间", () => {
    const at = "2026-09-28T10:00:00+08:00";
    expect(itemMeta(item("x", { status: "draft_ready", column: "写稿中", draftReadyAt: at }), 315, NOW)).toMatch(/^写完 /);
    expect(itemMeta(item("x", { chars: 630, draftReadyAt: at }), 315, NOW)).toMatch(/^约 2 分钟 · 定稿 /);
  });
});

describe("本体提示（spec 2026-09-29 §4.1）", () => {
  const report = (moves: number, errors: number) => ({
    at: "x", enabled: false, warnings: [],
    moves: Array.from({ length: moves }, (_, i) => ({ id: `c${i}`, title: `稿${i}`, from: "待录制", to: "剪辑中", rule: "D4", evidence: ["事实 f1（aroll）"] })),
    errors: Array.from({ length: errors }, (_, i) => ({ id: `e${i}`, title: `坏${i}`, error: "读不了" })),
  });
  it("未启用、有要挪的卡 → 要挪 N 张卡", () => {
    expect(ontologyNotice({ enabled: false, report: report(2, 0) })?.text).toBe("本体对账：要挪 2 张卡，看一下");
  });
  it("启用后不再提要挪，只提对账失败；什么都没有就不显示", () => {
    expect(ontologyNotice({ enabled: true, report: report(2, 1) })).toMatchObject({ moves: [], errors: 1, text: "1 条对账失败" });
    expect(ontologyNotice({ enabled: false, report: report(0, 0) })).toBeNull();
    expect(ontologyNotice(undefined)).toBeNull();
  });
});
