import { describe, expect, it } from "vitest";
import {
  accountCells, accountState, askBlocked, askOutcome, barOf, dateEyebrow, enabledPlatforms, glanceOf, latestOf, verdictOf,
} from "./home-model";
import type { PullPlatformStatus } from "../pull-lib";
import type { DataPageData, DataRow } from "./data-lib";
import type { PipelineData, ThemeCard } from "./pipeline-model";
import type { BoardItem } from "./board-columns";

const pull = (platform: string, over: Partial<PullPlatformStatus> = {}): PullPlatformStatus => ({
  platform, label: platform, consoleUrl: `https://${platform}`, inFlight: false, enabled: true, lastSuccessAt: "2026-10-25T01:02:00.000Z",
  lastAttemptAt: null, nextEligibleAt: null, failureCount: 0, lastStatus: "ok", ...over,
});

describe("账号格", () => {
  it("只出勾了的视频 / 图文平台，按固定顺序；YouTube / X 放下面一行", () => {
    expect(enabledPlatforms(["x", "wechat_mp", "douyin", "toutiao"])).toEqual({ main: ["douyin", "wechat_mp"], later: ["x"] });
    expect(enabledPlatforms([])).toEqual({ main: [], later: [] });
  });
  it("回流健康如实：正常 / 要重新登录 / 出错 / 没开 / 不支持 / 读不出来", () => {
    const rows = [pull("douyin"), pull("wechat_video", { lastStatus: "needs_login" }), pull("xiaohongshu", { lastStatus: "timeout", failureCount: 2 }), pull("bilibili_x", { enabled: false })];
    expect(accountState("douyin", rows, null)).toMatchObject({ kind: "ok" });
    expect(accountState("wechat_video", rows, null)).toMatchObject({ kind: "login", consoleUrl: "https://wechat_video" });
    expect(accountState("xiaohongshu", rows, null)).toMatchObject({ kind: "problem" });
    expect(accountState("bilibili_x", rows, null)).toEqual({ kind: "off" });
    expect(accountState("bilibili", rows, null)).toEqual({ kind: "unsupported" });
    expect(accountState("douyin", null, "boom")).toEqual({ kind: "unknown", error: "boom" });
    expect(accountCells(["douyin", "toutiao"], rows, null, (p) => p.toUpperCase())).toEqual([{ platform: "douyin", label: "DOUYIN", state: { kind: "ok", at: "2026-10-25T01:02:00.000Z" } }]);
  });
});

const row = (over: Partial<DataRow>): DataRow => ({ id: "r", contentId: "content-1-a", contentTitle: null, title: "标题", day: "2026-10-20", works: [], publishedOn: [], link: "auto", decisionId: null, ...over });
const work = (platform: string, day: string, views: number) => ({ key: `${platform}-${day}`, platform, title: "t", publishedAt: `${day}T10:00:00.000Z`, day, snapshots: [{ metricDate: day, recordedAt: null, source: "auto", metrics: { views } }] });
const data = (rows: DataRow[]): DataPageData => ({ columns: ["douyin", "xiaohongshu"], rows, contents: [], asOf: null, sources: [], covers: {}, upcoming: null });

describe("刚发那条", () => {
  it("没有发出去有数据的：null（页面写空态）", () => {
    expect(latestOf(data([]), Date.now())).toBeNull();
    expect(latestOf(null, Date.now())).toBeNull();
  });
  it("跟平时比：倍数、远低于、样本不够不比；不满 24 小时的平台算还没回来", () => {
    const old = [1, 2, 3].map((i) => row({ id: `o${i}`, day: `2026-10-0${i}`, works: [work("douyin", `2026-10-0${i}`, 1000), work("xiaohongshu", `2026-10-0${i}`, 200)] }));
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    const latest = row({ id: "n", day: "2026-10-24", contentTitle: "刚发那条", works: [work("douyin", "2026-10-24", 2600), work("xiaohongshu", "2026-10-24", 7)] });
    latest.works[1].publishedAt = "2026-10-25T06:00:00.000Z";
    const l = latestOf(data([...old, latest]), now)!;
    expect(l.title).toBe("刚发那条");
    expect(l.lines[0]).toMatchObject({ platform: "douyin", kind: "data", views: 2600, baseline: 1000, verdict: { text: "2.6×", tone: "up" } });
    expect(l.lines[1]).toEqual({ platform: "xiaohongshu", kind: "pending" });
  });
  it("比值说法与条宽", () => {
    expect(verdictOf(null).tone).toBe("none");
    expect(verdictOf(0.03)).toEqual({ text: "远低于平时", tone: "down" });
    expect(verdictOf(0.7).text).toBe("平时的 70%");
    expect(verdictOf(1).text).toBe("和平时差不多");
    const b = barOf(13543, 5200);
    expect(Math.round(b.barPct)).toBe(92);
    expect(barOf(7, 230).basePct).toBeCloseTo(92, 0);
    expect(barOf(10, null).basePct).toBeNull();
  });
});

const item = (status: string, column: BoardItem["column"]): BoardItem => ({
  id: "v", title: "稿", platform: "douyin", status, topicId: null, column, createdAt: "", updatedAt: "2026-10-24T00:00:00.000Z",
  draftReadyAt: null, chars: 0, finalDurationMs: null, cover: null, publish: null, publishTime: null, lastError: null, blockedReason: null,
} as BoardItem);
const card = (column: ThemeCard["column"], extra: Partial<ThemeCard> = {}): ThemeCard => ({
  id: "v", kind: "video", title: "稿", column, item: item("approved", "待发布"), children: [], destinations: [], sent: 0, required: 0, exceptions: [],
  plan: { required: [], skipped: [], persisted: true }, reshoot: null, date: null, ...extra,
});

describe("管线一览", () => {
  it("每列计数 + 短提示：等你认的、等你核对的用强调色", () => {
    const pd = { items: [], topics: [{ id: "t" }, { id: "u" }], wordsPerMinute: null, planErrors: [], themes: [
      card("写稿", { item: item("draft_ready", "写稿中") }), card("写稿", { item: item("drafting", "写稿中") }),
      card("发布中", { destinations: [{ platform: "wechat_video", state: "待你定", detail: "", content_id: "v", required: true }, { platform: "douyin", state: "已发", detail: "", content_id: "v", required: true }] }),
      card("全部发完"),
    ] } as unknown as PipelineData;
    const g = Object.fromEntries(glanceOf(pd).map((x) => [x.col, x]));
    expect(g.选题).toMatchObject({ n: 2, hot: false });
    expect(g.写稿).toMatchObject({ n: 2, hint: "1 篇等你认", hot: true });
    expect(g.录制).toMatchObject({ n: 0, hint: "" });
    expect(g.发布中).toMatchObject({ n: 1, hint: "1 个去向等你核对", hot: true });
    expect(g.全部发完.n).toBe(1);
  });
});

describe("让 AI 看看", () => {
  it("三种结果分开说；剪贴板没写进去、打不开都照实说", () => {
    expect(askOutcome({ host: "claude", label: "Claude Code", opened: true, paste: false }, true)).toMatchObject({ tone: "ok", text: expect.stringContaining("预填") });
    expect(askOutcome({ host: "codex", label: "Codex", opened: true, paste: true }, true)).toMatchObject({ tone: "paste", text: expect.stringContaining("要你粘贴") });
    expect(askOutcome({ host: "chief", label: "总编辑", opened: false, paste: false }, true).text).toContain("总编辑");
    expect(askOutcome({ host: "codex", label: "Codex", opened: true, paste: true }, false).tone).toBe("fail");
    expect(askOutcome({ host: "claude", label: "Claude Code", opened: false, paste: true, open_error: "没装" }, true).text).toContain("没装");
  });
  it("没本机 AI 也没钥匙：点之前就说为什么", () => {
    expect(askBlocked({ writers: [], chief: false })).toContain("没接本机 AI");
    expect(askBlocked({ writers: [], chief: true })).toBeNull();
    expect(askBlocked({ writers: ["claude"], chief: false })).toBeNull();
    expect(askBlocked(null)).toBeNull();
  });
  it("页头日期", () => {
    expect(dateEyebrow(new Date(2026, 9, 25))).toBe("10 月 25 日 · 周日");
  });
});
