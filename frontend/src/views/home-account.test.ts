import { describe, expect, it } from "vitest";
import { accountNumbers, latestOf, sameAgeBaseline, sparkPoints, type AccountTileData } from "./home-model";
import type { DataPageData, DataRow } from "./data-lib";

describe("账号格的数（第 4 期账号快照）", () => {
  const NOW = Date.parse("2026-10-25T02:00:00.000Z"); // 北京 10-25 10:00
  const tile = (over: Partial<AccountTileData> = {}): AccountTileData => ({
    health: { lastStatus: "ok", lastSuccessAt: "2026-10-25T01:05:00.000Z" },
    latest: { metricDate: "2026-10-24", followers: 1721, newFollowers: 19, views: 12745, viewsKind: "plays", complete: true },
    followersDelta: 19, compare: "ok", series: [{ date: "2026-10-23", views: 2832 }, { date: "2026-10-24", views: 12745 }], ...over,
  });
  it("粉丝、较昨天、昨天播放、小折线", () => {
    expect(accountNumbers(tile(), NOW)).toEqual({ kind: "data", followers: 1721, deltaText: "+19 较昨天", deltaTone: "up", viewsText: "昨天播放 12,745", staleText: null, series: [2832, 12745] });
    expect(sparkPoints([2832, 12745])).toBe("0.0,28.0 120.0,4.0");
  });
  it("只有一天：写「明天开始有对比」，不画折线", () => {
    const a = accountNumbers(tile({ followersDelta: null, compare: "no_prev", series: [{ date: "2026-10-24", views: 1 }] }), NOW);
    expect(a).toMatchObject({ deltaText: "明天开始有对比", deltaTone: "none", series: [] });
    expect(sparkPoints([1])).toBe("");
  });
  it("公众号写阅读；不是昨天的数写截至哪天，抓失败说出来", () => {
    const a = accountNumbers(tile({ latest: { metricDate: "2026-10-22", followers: 749, newFollowers: 0, views: 12, viewsKind: "reads", complete: true }, health: { lastStatus: "needs_login", lastSuccessAt: null } }), NOW);
    expect(a).toMatchObject({ viewsText: "10-22阅读 12", staleText: "数据截至 10-22；账号数据没抓成（needs_login）" });
  });
  it("没接 / 读不出 / 还没抓过：只说为什么没有，不编数", () => {
    expect(accountNumbers(null, NOW)).toEqual({ kind: "none", text: "还不能抓账号数据" });
    expect(accountNumbers({ error: "账号数据读不出：EACCES" }, NOW)).toEqual({ kind: "none", text: "账号数据读不出：EACCES" });
    expect(accountNumbers(tile({ latest: null, compare: "no_data", health: null }), NOW)).toEqual({ kind: "none", text: "还没有账号数据，下次回流后出现" });
  });
  it("只抓到一部分：数照给，说明缺口", () => {
    const a = accountNumbers(tile({ health: { lastStatus: "ok", lastSuccessAt: "x", lastErrorCode: "partial:http_500" }, latest: { metricDate: "2026-10-24", followers: 16302, newFollowers: null, views: null, viewsKind: "plays", complete: false } }), NOW);
    expect(a).toMatchObject({ followers: 16302, viewsText: "昨天播放没拿到", staleText: "这次只抓到一部分（http_500），缺的数先空着" });
  });
  it("掉粉写负号", () => {
    expect(accountNumbers(tile({ followersDelta: -3 }), NOW)).toMatchObject({ deltaText: "−3 较昨天", deltaTone: "down" });
  });
});

const row = (over: Partial<DataRow>): DataRow => ({ id: "r", contentId: "content-1-a", contentTitle: null, title: "标题", day: "2026-10-20", works: [], publishedOn: [], link: "auto", decisionId: null, ...over });
const data = (rows: DataRow[]): DataPageData => ({ columns: ["douyin", "xiaohongshu"], rows, contents: [], asOf: null, sources: [], covers: {}, upcoming: null });
const snapW = (platform: string, pub: string, snaps: Array<[string, number]>) => ({
  key: `${platform}-${pub}`, platform, title: "t", publishedAt: pub, day: pub.slice(0, 10),
  snapshots: snaps.map(([at, views]) => ({ metricDate: at.slice(0, 10), recordedAt: at, source: "auto", metrics: { views } })),
});

describe("刚发那条：同龄比", () => {
  const peers = [1, 2, 3].map((i) => row({ id: `p${i}`, day: `2026-10-1${i}`, works: [snapW("douyin", `2026-10-1${i}T10:00:00.000Z`, [[`2026-10-1${i + 1}T01:00:00.000Z`, 3000 + i], [`2026-10-1${i + 3}T01:00:00.000Z`, 9000]])] }));
  const fresh = row({ id: "n", day: "2026-10-24", contentTitle: "夯到拉", works: [snapW("douyin", "2026-10-24T10:00:00.000Z", [["2026-10-25T01:04:00.000Z", 13543]])] });
  it("不满 24 小时也能比：和别的作品发出约 15 小时时比", () => {
    const l = latestOf(data([...peers, fresh]), Date.parse("2026-10-25T02:00:00.000Z"))!;
    expect(l.lines[0]).toMatchObject({ platform: "douyin", kind: "data", views: 13543, baseline: 3002, basis: "same_age", ageHours: 15 });
    expect(sameAgeBaseline([...peers, fresh], fresh, "douyin", 15)).toBe(3002);
  });
  it("CSV 导入的快照没有真实观察时刻：不当同龄样本（入账时间是导入那一刻）", () => {
    const csvPeers = peers.map((r) => ({ ...r, works: r.works.map((w) => ({ ...w, snapshots: w.snapshots.map((x) => ({ ...x, source: "csv" })) })) }));
    expect(sameAgeBaseline([...csvPeers, fresh], fresh, "douyin", 15)).toBeNull();
    const csvFresh = { ...fresh, works: fresh.works.map((w) => ({ ...w, snapshots: w.snapshots.map((x) => ({ ...x, source: "csv" })) })) };
    expect(latestOf(data([...peers, csvFresh]), Date.parse("2026-10-25T02:00:00.000Z"))!.lines[0]).toEqual({ platform: "douyin", kind: "pending" });
  });
  it("同龄样本不够 3 条：不满 24 小时的先不比；满了退回全量中位数并标 all", () => {
    expect(latestOf(data([peers[0], fresh]), Date.parse("2026-10-25T02:00:00.000Z"))!.lines[0]).toEqual({ platform: "douyin", kind: "pending" });
    const old = row({ ...fresh, works: [snapW("douyin", "2026-10-24T10:00:00.000Z", [["2026-10-28T01:00:00.000Z", 5000]])] });
    const l = latestOf(data([...peers, old]), Date.parse("2026-10-28T02:00:00.000Z"))!;
    expect(l.lines[0]).toMatchObject({ kind: "data", basis: "all", baseline: 9000 });
  });
});
