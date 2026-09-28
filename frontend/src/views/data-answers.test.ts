import { describe, expect, it } from "vitest";
import {
  baselines, bestWorst, declineStreak, hypAnswer, hypState, latestAnswer, latestVideo, monthCompare, multiplier,
  nextAnswer, platformLines, prevMonth, ratioText, trendAnswer,
} from "./data-answers";
import type { DataRow, Work } from "./data-lib";

let seq = 0;
function w(platform: string, views: number | null, publishedAt: string | null = null, metricDate = "2026-09-26"): Work {
  return { key: `${platform}#${++seq}`, platform, title: "t", publishedAt, day: null, snapshots: [{ metricDate, recordedAt: null, source: "csv", metrics: { views } }] };
}
function row(day: string, works: Work[], extra: Partial<DataRow> = {}): DataRow {
  return { id: `r${++seq}`, contentId: null, contentTitle: null, title: `视频${day}`, day, works, publishedOn: [], link: "none", decisionId: null, ...extra };
}
const text = (parts: Array<{ text: string }>) => parts.map((p) => p.text).join("");
const NOW = Date.parse("2026-09-28T12:00:00+08:00");

/** 平时：抖音 100，视频号 10 */
const history = [
  row("2026-08-01", [w("douyin", 100), w("wechat_video", 10)]),
  row("2026-08-02", [w("douyin", 100), w("wechat_video", 10)]),
  row("2026-08-03", [w("douyin", 100), w("wechat_video", 10)]),
];

describe("比值与 ×（§48）", () => {
  it("× = 各平台 播放/平时 的中位数；平时要 ≥3 条", () => {
    const r = row("2026-09-01", [w("douyin", 200), w("wechat_video", 5), w("bilibili", 9)]);
    const base = baselines([...history, r]);
    expect(base.get("bilibili")).toBeUndefined();
    expect(multiplier(r, base)).toBeCloseTo((200 / 100 + 5 / 10) / 2);
  });
  it("0.9–1.05 = 和平时差不多；低于写百分比，高于写倍数", () => {
    expect(ratioText(0.95).text).toBe("和平时差不多");
    expect(ratioText(1.05).text).toBe("和平时差不多");
    expect(ratioText(0.19)).toEqual({ text: "平时的 19%", hot: true });
    expect(ratioText(1.42).text).toBe("平时的 1.4 倍");
  });
});

describe("刚发的那条（§49）", () => {
  it("取最近一条已有数据的视频；没数据的新稿不算", () => {
    const fresh = row("2026-09-27", [], { publishedOn: ["douyin"] });
    const r = row("2026-09-24", [w("douyin", 100)]);
    expect(latestVideo([...history, r, fresh])).toBe(r);
  });
  it("发布不满 24 小时或没回流 → 数据还没回来，不写 0", () => {
    const r = row("2026-09-28", [w("douyin", 0, "2026-09-28T01:00:00Z"), w("wechat_video", 5)], { publishedOn: ["xiaohongshu"] });
    const lines = platformLines(r, ["douyin", "wechat_video", "xiaohongshu", "bilibili"], baselines(history), NOW);
    expect(lines.map((l) => l.kind)).toEqual(["pending", "data", "pending"]);
  });
  it("结论句由数字拼出", () => {
    const r = row("2026-09-24", [w("douyin", 100), w("wechat_video", 2)]);
    const lines = platformLines(r, ["douyin", "wechat_video"], baselines(history), NOW);
    expect(text(latestAnswer(r, lines))).toBe("09-24「视频2026-09-24」比平时差：抖音持平，视频号是平时的 20%");
    expect(text(latestAnswer(r, []))).toBe("09-24「视频2026-09-24」数据还没回来");
  });
});

describe("整体变好变差（§50）", () => {
  const sep = [1, 2, 3].map((d) => row(`2026-09-0${d}`, [w("douyin", 50), w("wechat_video", 10)]));
  it("本月 vs 上月中位数 + 涨跌；任一月份 <3 条 → 样本太少", () => {
    const lines = monthCompare([...history, ...sep, row("2026-09-04", [w("bilibili", 5)])], ["douyin", "wechat_video", "bilibili"], "2026-09");
    expect(lines).toEqual([
      { platform: "douyin", kind: "ok", prev: 100, cur: 50, pct: -50 },
      { platform: "wechat_video", kind: "ok", prev: 10, cur: 10, pct: 0 },
      { platform: "bilibili", kind: "thin" },
    ]);
    expect(text(trendAnswer(lines, "2026-09"))).toBe("9 月比 8 月：抖音降了 50%，视频号基本稳住");
  });
  it("全降 → 都在降，降最多的标出；没够样本 → 暂不比较", () => {
    const lines = [
      { platform: "douyin", kind: "ok" as const, prev: 10, cur: 9, pct: -11 },
      { platform: "wechat_video", kind: "ok" as const, prev: 10, cur: 3, pct: -71 },
    ];
    expect(text(trendAnswer(lines, "2026-01"))).toBe("1 月比 12 月都在降，视频号降得最多（-71%）");
    expect(text(trendAnswer([{ platform: "douyin", kind: "thin" }], "2026-09"))).toBe("样本太少，暂不比较");
    expect(prevMonth("2026-01")).toBe("2025-12");
  });
  it("连续 ≥3 条走低才报", () => {
    const rs = [5, 9, 7, 4, 2].map((v, i) => row(`2026-09-1${i}`, [w("xiaohongshu", v)]));
    expect(declineStreak(rs, ["xiaohongshu"])).toEqual({ platform: "xiaohongshu", from: "2026-09-11", values: [9, 7, 4, 2] });
    expect(declineStreak(rs.slice(0, 4), ["xiaohongshu"])).toBeNull();
  });
});

describe("下一条该写什么（§51）", () => {
  it("只看 ≥2 个平台有数据的；好取前 3（×≥1.05），差取后 2（×<0.9）", () => {
    const base = baselines(history);
    const rs = [
      row("2026-09-01", [w("douyin", 300), w("wechat_video", 30)]),
      row("2026-09-02", [w("douyin", 200), w("wechat_video", 16)]),
      row("2026-09-03", [w("douyin", 120), w("wechat_video", 8)]),
      row("2026-09-04", [w("douyin", 110), w("wechat_video", 11)]),
      row("2026-09-05", [w("douyin", 50), w("wechat_video", 5)]),
      row("2026-09-06", [w("douyin", 80), w("wechat_video", 7)]),
      row("2026-09-07", [w("douyin", 85), w("wechat_video", 8)]),
      row("2026-09-08", [w("douyin", 9999)]),
    ];
    const b = bestWorst(rs, base);
    expect(b.eligible).toBe(7);
    expect(b.good.map((p) => p.row.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-04"]);
    expect(b.bad.map((p) => p.row.day)).toEqual(["2026-09-05", "2026-09-06"]);
    expect(b.good[0].note).toBe("两个平台都高于平时");
    expect(b.bad[0].note).toBe("两个平台都低于平时");
    expect(nextAnswer(b)).toBe("比平时好的是这三条，差的是这两条");
    expect(nextAnswer({ eligible: 0, good: [], bad: [] })).toBe("作品还太少");
  });
  it("× 小于 1 保留两位；结论里的长标题截短", async () => {
    const { fmtX, shortTitle } = await import("./data-answers");
    expect(fmtX(0.874)).toBe("0.87×");
    expect(fmtX(3.62)).toBe("3.6×");
    expect(shortTitle("什么时候该用 Jev，什么时候该用大模型")).toBe("什么时候该用 Jev，什么时…");
  });
  it("说明句：特别好的平台点名", () => {
    const base = baselines(history);
    const b = bestWorst([row("2026-09-01", [w("douyin", 90), w("wechat_video", 20)])], base);
    expect(b.good[0].note).toBe("视频号特别好（≥1.5×）");
  });
});

describe("写法实验（§52）", () => {
  it("状态映射", () => {
    expect(hypState({ status: "open" })).toBe("untested");
    expect(hypState({ status: "supported", evidence: { relDiff: 0.3 } })).toBe("better");
    expect(hypState({ status: "refuted", evidence: { relDiff: -0.2 } })).toBe("worse");
    expect(hypState({ status: "inconclusive", evidence: { relDiff: 0.5 } })).toBe("unclear");
    expect(hypState({ status: "supported", evidence: null })).toBe("unclear");
  });
  it("结论句", () => {
    expect(text(hypAnswer([]))).toBe("复盘还没提出要验证的写法");
    expect(text(hypAnswer([{ status: "open" }, { status: "open" }, { status: "open" }]))).toBe("3 个写法都还在等新稿检验，暂时没有结论");
    expect(text(hypAnswer([{ status: "open" }, { status: "supported", evidence: { relDiff: 1 } }]))).toBe("2 个写法：1 个变好、1 个还没检验");
  });
});
