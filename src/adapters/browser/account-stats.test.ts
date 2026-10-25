/**
 * 账号级抓取的解析层：吃 2026-10-25 只读探查存下的脱敏样本（__fixtures__/account/），不连浏览器。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { judgeAccountPage, mergeDayRows, parseBilibiliAccount, parseDouyinAccount, parseWechatMpAccount, parseXhsAccount, pullAccountStats } from "./account-stats.js";
import type { BrowseOutcome } from "./ego-session.js";

const fx = (name: string): string => readFileSync(new URL(`./__fixtures__/account/${name}`, import.meta.url), "utf8");
const res = (url: string, body: string, status = 200) => ({ url, status, body });
const CAPTURED = "2026-10-25T01:05:00.000Z"; // 北京 10-25 09:05
const page = (...responses: ReturnType<typeof res>[]): BrowseOutcome => ({ pages: [{ index: 0, responses }], end: "no_more", gate: null });

const DY_OVERVIEW = res("https://creator.douyin.com/aweme/janus/creator/data/overview/all/?x=1", fx("douyin-overview.json"));
const DY_USER = res("https://creator.douyin.com/web/api/media/user/info/", fx("douyin-user-info.json"));

describe("抖音概览：近 7 天每天一行（粉丝累计、新增、播放）", () => {
  it("fixture 解析出 7 天，10-24 = 1721 粉丝 / 新增 19 / 播放 12745；昵称来自 user/info", () => {
    const r = judgeAccountPage("douyin", page(DY_OVERVIEW, DY_USER), CAPTURED);
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(7);
    expect(r.rows[6]).toEqual({ metricDate: "2026-10-24", followers: 1721, newFollowers: 19, views: 12745 });
    expect(r.rows[5]).toMatchObject({ metricDate: "2026-10-23", followers: 1702 });
    expect(r.account).toBe("测试账号");
  });
  it("status_code 8 = 要登录；缺 fans/play = 结构变了", () => {
    expect(parseDouyinAccount(res(DY_OVERVIEW.url, JSON.stringify({ status_code: 8 })))).toEqual({ stop: "needs_login", errorCode: "envelope:8" });
    expect(parseDouyinAccount(res(DY_OVERVIEW.url, JSON.stringify({ status_code: 0, data: {} })))).toMatchObject({ stop: "schema_changed" });
  });
});

describe("小红书：近 7 天观看 / 新增粉丝 + 抓取时的粉丝总数", () => {
  const base = res("https://creator.xiaohongshu.com/api/galaxy/v2/creator/datacenter/account/base", fx("xhs-account-base.json"));
  const info = res("https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info", fx("xhs-personal-info.json"));
  it("北京日期从毫秒时间戳换；粉丝总数记在抓取前一天（和其余字段同一天）", () => {
    const r = judgeAccountPage("xiaohongshu", page(base, info), CAPTURED);
    expect(r.status).toBe("ok");
    const last = r.rows[r.rows.length - 1];
    expect(last).toEqual({ metricDate: "2026-10-24", followers: 16302, newFollowers: 0, views: 149 });
    expect(r.rows[0].followers).toBeNull();
  });
  it("account/base 坏了、personal_info 好的：粉丝照收，但缺口记成 partial，不报成完整成功", () => {
    const r = judgeAccountPage("xiaohongshu", page(res(base.url, "oops", 500), info), CAPTURED);
    expect(r).toMatchObject({ status: "ok", rows: [{ metricDate: "2026-10-24", followers: 16302, views: null }] });
    expect(r.errorCode).toMatch(/^partial:/);
    const missing = judgeAccountPage("xiaohongshu", page(info), CAPTURED);
    expect(missing.errorCode).toBe("partial:missing_response:/datacenter/account/base");
    expect(judgeAccountPage("xiaohongshu", page(base, info), CAPTURED).errorCode).toBeUndefined();
  });
  it("缺 view_list = 结构变了；success:false = 出错", () => {
    expect(parseXhsAccount(res(base.url, JSON.stringify({ success: true, data: { seven: {} } })), CAPTURED)).toMatchObject({ stop: "schema_changed" });
    expect(parseXhsAccount(res(base.url, JSON.stringify({ success: false, code: -1 })), CAPTURED)).toMatchObject({ stop: "error" });
  });
});

describe("B站首页统计", () => {
  const stat = res("https://member.bilibili.com/x/web/data/index/stat", fx("bili-index-stat.json"));
  it("log_date 那天：粉丝 8 / 新增 1 / 播放 23", () => {
    expect(parseBilibiliAccount(stat)).toEqual({ rows: [{ metricDate: "2026-10-24", followers: 8, newFollowers: 1, views: 23 }] });
  });
  it("-101 = 要登录；-352 = 风控", () => {
    expect(parseBilibiliAccount(res(stat.url, JSON.stringify({ code: -101 })))).toMatchObject({ stop: "needs_login" });
    expect(parseBilibiliAccount(res(stat.url, JSON.stringify({ code: -352 })))).toMatchObject({ stop: "risk_control" });
  });
});

describe("公众号首页文档", () => {
  const home = res("https://mp.weixin.qq.com/cgi-bin/home?t=home/index", fx("mp-home.html"));
  it("昨天：总用户 749 / 新增关注 0 / 阅读 12（人）", () => {
    expect(parseWechatMpAccount(home, CAPTURED)).toEqual({ rows: [{ metricDate: "2026-10-24", followers: 749, newFollowers: 0, views: 12 }], account: "测试账号" });
  });
  it("同路径的 JSON 小请求不是首页文档：不产出行，也不算失败", () => {
    expect(parseWechatMpAccount(res("https://mp.weixin.qq.com/cgi-bin/home?action=get_finder_live_info", "{\"base_resp\":{\"ret\":0}}"), CAPTURED)).toEqual({ rows: [] });
  });
});

describe("一页的判定", () => {
  it("登录页 / 风控页 / 没响应都如实报，不出行", () => {
    expect(judgeAccountPage("douyin", { pages: [], end: "gate", gate: "login" }, CAPTURED)).toMatchObject({ status: "needs_login", rows: [] });
    expect(judgeAccountPage("douyin", { pages: [], end: "gate", gate: "risk" }, CAPTURED)).toMatchObject({ status: "risk_control" });
    expect(judgeAccountPage("bilibili", { pages: [], end: "no_response", gate: null }, CAPTURED)).toMatchObject({ status: "error", errorCode: "no_data_response" });
  });
  it("响应里同时有登录信号：不拿半截数据冒充", () => {
    const login = res(DY_OVERVIEW.url, JSON.stringify({ status_code: 8 }));
    expect(judgeAccountPage("douyin", page(DY_USER, login), CAPTURED)).toMatchObject({ status: "needs_login", rows: [] });
  });
  it("同一天多处来源逐字段合并", () => {
    expect(mergeDayRows([
      { metricDate: "2026-10-24", followers: null, newFollowers: 3, views: null },
      { metricDate: "2026-10-24", followers: 10, newFollowers: null, views: 5 },
    ])).toEqual([{ metricDate: "2026-10-24", followers: 10, newFollowers: 3, views: 5 }]);
  });
  it("抓取只开一页、只听概览响应、不翻页", async () => {
    const browse = vi.fn(async () => page(res("https://member.bilibili.com/x/web/data/index/stat", fx("bili-index-stat.json"))));
    const r = await pullAccountStats("bilibili", { session: { browse }, now: () => new Date(CAPTURED) });
    expect(r).toMatchObject({ status: "ok", rows: [{ metricDate: "2026-10-24" }] });
    expect(browse.mock.calls[0][0]).toMatchObject({ url: "https://member.bilibili.com/platform/home", maxPages: 1, patterns: ["/x/web/data/index/stat"] });
  });
  it("会话抛错收敛成状态码", async () => {
    const r = await pullAccountStats("douyin", { session: { browse: async () => { throw new Error("boom"); } } });
    expect(r.status).not.toBe("ok");
    expect(r.rows).toEqual([]);
  });
});
