import { describe, expect, it } from "vitest";
import { buildRows } from "./data-assemble.js";
import { buildWorks, type ContentRef, type OutcomeLike } from "./data-rows.js";
import type { LinkDecision } from "./outcome-links.js";

function o(platform: string, title: string, publishedAt: string, views: number, extra: Partial<OutcomeLike> = {}): OutcomeLike {
  return { contentId: null, platform, platformTitle: title, publishedAt, metricDate: "2026-09-26", source: "csv", metrics: { views }, ...extra };
}

function content(id: string, title: string, day: string, platforms: ContentRef["platforms"] = []): ContentRef {
  return { id, title, day, platforms };
}

let seq = 0;
function dec(op: LinkDecision["op"], works: string[], extra: Partial<LinkDecision> = {}): LinkDecision {
  seq += 1;
  return { id: `d${seq}`, at: `2026-09-28T00:00:${String(seq).padStart(2, "0")}Z`, op, works, ...extra };
}

const rowsOf = (outs: OutcomeLike[], contents: ContentRef[] = [], decisions: LinkDecision[] = []) =>
  buildRows(buildWorks(outs), contents, decisions);

describe("自动关联（§33）", () => {
  it("标题一样、日期差 1 天内 → 挂到稿件", () => {
    const rows = rowsOf([o("douyin", "一起搞懂Agent Harness", "2026-08-22T17:42:12+08:00", 10)], [content("c1", "一起搞懂 Agent Harness", "2026-08-23")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contentId: "c1", link: "auto" });
  });

  it("标题相近 + 日期窗口内 → 挂上；日期差 2 天 → 不挂", () => {
    const outs = [o("xiaohongshu", "一起搞懂Agent Harness，AI如何改变工作方式", "2026-08-22T17:24:45+08:00", 5)];
    expect(rowsOf(outs, [content("c1", "一起搞懂Agent Harness", "2026-08-22")])[0].contentId).toBe("c1");
    const far = rowsOf(outs, [content("c1", "一起搞懂Agent Harness", "2026-08-24")]);
    expect(far.find((r) => r.works.length)?.contentId).toBeNull();
  });

  it("发布计划里该平台的标题也算匹配键；平台作品 id 对上不看日期", () => {
    const plat = { platform: "wechat_video", title: "用 AI 一年，你攒下了什么？", postId: null, day: "2026-09-09", published: true };
    const rows = rowsOf([o("wechat_video", "用 AI 一年，你攒下了什么？", "2026-09-09", 816)], [content("c1", "别再收藏提示词了！这 7 条才让 AI 真变强", "2026-09-09", [plat])]);
    expect(rows[0].contentId).toBe("c1");
    const byId = { platform: "xiaohongshu", title: null, postId: "abc", day: "2026-01-01", published: true };
    const r2 = rowsOf([o("xiaohongshu", "完全不同", "2026-09-09", 1, { platformItemId: "abc" })], [content("c2", "别的", "2026-01-01", [byId])]);
    expect(r2[0].contentId).toBe("c2");
  });

  it("跨平台标题对不上 → 这一条进未关联，不硬挂", () => {
    const outs = [
      o("douyin", "别再收藏提示词了！这 7 条才让 AI 真变强", "2026-09-09T12:48:25+08:00", 3404),
      o("wechat_video", "用 AI 一年，你攒下了什么？", "2026-09-09", 816),
    ];
    const rows = rowsOf(outs, [content("c1", "别再收藏提示词了！这 7 条才让 AI 真变强", "2026-09-09")]);
    const linked = rows.find((r) => r.contentId === "c1")!;
    expect(linked.works.map((w) => w.platform)).toEqual(["douyin"]);
    const loose = rows.find((r) => r.contentId === null)!;
    expect(loose.works.map((w) => w.platform)).toEqual(["wechat_video"]);
  });

  it("两条稿件一样像 → 不猜", () => {
    const rows = rowsOf([o("douyin", "同一个标题", "2026-09-09", 1)], [content("a", "同一个标题", "2026-09-09"), content("b", "同一个标题", "2026-09-10")]);
    expect(rows.find((r) => r.works.length)?.contentId).toBeNull();
  });
});

describe("没稿件的老视频（§35）", () => {
  it("同一天 + 标题相近合成一行；日期不同的（B站晚 3 天）各占一行", () => {
    const rows = rowsOf([
      o("douyin", "一起搞懂Agent Harness", "2026-08-22T17:42:12+08:00", 324306),
      o("xiaohongshu", "一起搞懂Agent Harness，AI如何改变工作方式", "2026-08-22T17:24:45+08:00", 1583),
      o("wechat_video", "一起搞懂Agent Harness", "2026-08-22", 4662),
      o("bilibili", "一起搞懂Agent Harness，这一年到底如何改变我们的", "2026-08-25T22:02:28+08:00", 25),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.day === "2026-08-22")!.works).toHaveLength(3);
    expect(rows.every((r) => r.contentId === null && r.link === "none")).toBe(true);
  });

  it("同一天同平台的两条不合在一起", () => {
    const rows = rowsOf([o("douyin", "Agent 入门一", "2026-09-01", 1), o("douyin", "Agent 入门二", "2026-09-01", 2)]);
    expect(rows).toHaveLength(2);
  });
});

describe("手动决定（§34–36）", () => {
  const outs = [
    o("douyin", "别再收藏提示词了！这 7 条才让 AI 真变强", "2026-09-09T12:48:25+08:00", 3404),
    o("wechat_video", "用 AI 一年，你攒下了什么？", "2026-09-09", 816),
  ];
  const [dy, vv] = buildWorks(outs).map((w) => w.key);

  it("「和上一行是同一条」合进去，撤销（删掉决定）就回到分开", () => {
    const d = dec("merge", [vv], { target: dy });
    const merged = rowsOf(outs, [], [d]);
    expect(merged).toHaveLength(1);
    expect(merged[0].decisionId).toBe(d.id);
    expect(rowsOf(outs, [], [])).toHaveLength(2);
  });

  it("手动关联盖过自动；自动匹配以后也不会改回来", () => {
    const cs = [content("auto", "别再收藏提示词了！这 7 条才让 AI 真变强", "2026-09-09"), content("mine", "另一条", "2026-09-01")];
    expect(rowsOf(outs, cs).find((r) => r.works.some((w) => w.key === dy))!.contentId).toBe("auto");
    const rows = rowsOf(outs, cs, [dec("link", [dy], { contentId: "mine" })]);
    const row = rows.find((r) => r.works.some((w) => w.key === dy))!;
    expect(row).toMatchObject({ contentId: "mine", link: "manual" });
    expect(rows.find((r) => r.contentId === "auto")).toBeUndefined();
  });

  it("拆开：自动合的老视频各占一行，自动关联也不再挂", () => {
    const same = [o("douyin", "一起搞懂Agent Harness", "2026-08-22", 1), o("wechat_video", "一起搞懂Agent Harness", "2026-08-22", 2)];
    const keys = buildWorks(same).map((w) => w.key);
    expect(rowsOf(same)).toHaveLength(1);
    const split = rowsOf(same, [content("c", "一起搞懂Agent Harness", "2026-08-22")], [dec("split", keys)]);
    expect(split).toHaveLength(2);
    expect(split.every((r) => r.contentId === null)).toBe(true);
  });

  it("后做的决定盖过先做的；合并到已关联稿件的行 → 跟着挂到那条稿件", () => {
    const cs = [content("c1", "别再收藏提示词了！这 7 条才让 AI 真变强", "2026-09-09")];
    const rows = rowsOf(outs, cs, [dec("split", [vv]), dec("merge", [vv], { target: dy })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contentId: "c1", link: "manual" });
  });

  it("合并目标不在了 → 自成一行，仍带着决定可撤销", () => {
    const d = dec("merge", [vv], { target: "douyin@gone@2026-01-01" });
    const rows = rowsOf(outs, [], [d]);
    expect(rows.find((r) => r.works.some((w) => w.key === vv))!.decisionId).toBe(d.id);
  });
});

describe("未回流 vs 没发（§39）", () => {
  it("稿件发了但没数据 → 占一行，publishedOn 带着平台", () => {
    const plats = [
      { platform: "douyin", title: null, postId: null, day: "2026-09-27", published: true },
      { platform: "bilibili", title: null, postId: null, day: "2026-10-02", published: false },
    ];
    const rows = rowsOf([], [content("c1", "新稿", "2026-09-27", plats), content("c2", "没发的", "2026-09-27")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contentId: "c1", publishedOn: ["douyin"], works: [] });
  });
});

describe("快照（§46）", () => {
  it("同一作品多次快照收在一起，旧→新；早先没带平台 id 的快照也认回来", () => {
    const works = buildWorks([
      o("douyin", "标题", "2026-09-01", 5, { metricDate: "2026-09-05", platformItemId: "x1" }),
      o("douyin", "标题", "2026-09-01", 1, { metricDate: "2026-09-02" }),
    ]);
    expect(works).toHaveLength(1);
    expect(works[0].snapshots.map((s) => s.metricDate)).toEqual(["2026-09-02", "2026-09-05"]);
  });
});
