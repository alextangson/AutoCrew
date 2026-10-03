/**
 * passive-pull.test.ts — 旁听骨架的验收清单(规格 2026-10-03-metrics-pull-human-like §边界情况)。
 * 用视频号的真实平台配置 + 构造的页面响应;会话全打桩,不碰 ego lite。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EgoChannelError, type BrowseOutcome, type CapturedPage } from "./ego-session.js";
import { browseScript } from "./ego-scripts.js";
import { LOOKBACK_DAYS, MAX_BROWSE_PAGES, PAUSE_RANGE_MS, judgeBrowse, runPassivePull } from "./passive-pull.js";
import { WECHAT_VIDEO_PLATFORM as WV } from "./wechat-video-stats.js";

const NOW = new Date("2026-10-03T09:00:00+08:00");
const DAY = 86_400_000;
const CUTOFF = NOW.getTime() - LOOKBACK_DAYS * DAY;
const URL = "https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list?_rid=1";
const post = (id: number, daysAgo: number) => ({
  objectId: `14412345678900000${String(id).padStart(2, "0")}`,
  createTime: Math.floor((NOW.getTime() - daysAgo * DAY) / 1000),
  readCount: 100 + id,
  likeCount: 1,
  desc: { description: `作品 ${id}` },
});
const page = (index: number, posts: unknown[], status = 201): CapturedPage => ({
  index,
  responses: [{ url: URL, status, body: JSON.stringify({ errCode: 0, data: { list: posts, continueFlag: true } }) }],
});
const outcome = (pages: CapturedPage[], end: BrowseOutcome["end"], extra: Partial<BrowseOutcome> = {}): BrowseOutcome => ({ pages, end, gate: null, ...extra });
const judge = (o: BrowseOutcome) => judgeBrowse(WV, o, CUTOFF);

describe("边界情况(验收清单)", () => {
  it("页面跳到登录页 → needs_login,零行", () => {
    expect(judge(outcome([], "gate", { gate: "login" }))).toEqual({ status: "needs_login", rows: [], errorCode: "login_page" });
  });

  it("验证码/滑块/风控页 → risk_control,零行(脚本当场停手,见 ego-scripts.test)", () => {
    expect(judge(outcome([], "gate", { gate: "risk" }))).toEqual({ status: "risk_control", rows: [], errorCode: "risk_page" });
  });

  it("等不到数据响应 → 失败、零写入、写明页面没返回作品数据", () => {
    expect(judge(outcome([], "no_response"))).toEqual({ status: "error", rows: [], errorCode: "no_data_response" });
  });

  it("响应结构变了(字段缺失 / 不是 JSON)→ schema_changed,零行", () => {
    const drift: CapturedPage = { index: 0, responses: [{ url: URL, status: 201, body: '{"errCode":0,"data":{"posts":[]}}' }] };
    const notJson: CapturedPage = { index: 0, responses: [{ url: URL, status: 201, body: "not json" }] };
    expect(judge(outcome([drift], "no_more"))).toMatchObject({ status: "schema_changed", rows: [], errorCode: "missing:data.list" });
    expect(judge(outcome([notJson], "no_more"))).toMatchObject({ status: "schema_changed", rows: [] });
  });

  it("翻页按钮找不到 → 只用第 1 页,标注 only_first_page,不报失败", () => {
    const r = judge(outcome([page(0, [post(1, 1)])], "pagination_missing"));
    expect(r).toMatchObject({ status: "ok", errorCode: "only_first_page", pages: 1 });
    expect(r.rows).toHaveLength(1);
  });

  it("比 30 天更早的作品不写", () => {
    const r = judge(outcome([page(0, [post(1, 2), post(2, 29), post(3, 31), post(4, 90)])], "cutoff"));
    expect(r.rows.map((x) => x.title)).toEqual(["作品 1", "作品 2"]);
    expect(r.errorCode).toBeUndefined();
  });

  it("中途出错(第 2 页结构坏)→ 第 1 页照常交回,出错原因可见", () => {
    const bad: CapturedPage = { index: 1, responses: [{ url: URL, status: 201, body: "{" }] };
    const r = judge(outcome([page(0, [post(1, 1)]), bad], "cutoff"));
    expect(r).toMatchObject({ status: "ok", pages: 1, errorCode: "partial:schema_changed:json_parse:post_list" });
    expect(r.rows).toHaveLength(1);
  });

  it("中途通道故障(超时被杀)→ 已拿到的完整页照常交回;一页都没有就是 timeout 失败", () => {
    const err = new EgoChannelError("timeout", "ego_timeout", "x");
    expect(judge(outcome([page(0, [post(1, 1)])], "error", { error: err }))).toMatchObject({ status: "ok", errorCode: "partial:timeout:ego_timeout" });
    expect(judge(outcome([], "error", { error: err }))).toEqual({ status: "timeout", rows: [], errorCode: "ego_timeout" });
  });

  it("中途碰到风控页 → 已拿到的页交回,partial:risk_control 可见", () => {
    expect(judge(outcome([page(0, [post(1, 1)])], "gate", { gate: "risk" }))).toMatchObject({ status: "ok", errorCode: "partial:risk_control:risk_page" });
  });

  it("第 2 页风控 HTTP 码 → 第 1 页保留;第 1 页就风控 → risk_control 零行", () => {
    expect(judge(outcome([page(0, [post(1, 1)]), page(1, [], 461)], "http_status"))).toMatchObject({ status: "ok", errorCode: "partial:risk_control:http:461" });
    expect(judge(outcome([page(0, [], 461)], "http_status"))).toMatchObject({ status: "risk_control", rows: [] });
  });

  it("翻满 3 页 → hasMore;跨页同作品去重", () => {
    const r = judge(outcome([page(0, [post(1, 1)]), page(1, [post(1, 1), post(2, 2)]), page(2, [post(3, 3)])], "max_pages"));
    expect(r).toMatchObject({ status: "ok", hasMore: true, pages: 3 });
    expect(r.rows).toHaveLength(3);
  });
});

describe("runPassivePull 交给会话的参数", () => {
  it("近 30 天、最多 3 页、翻页前随机停 2–6 秒;没传 now 也能算 cutoff", async () => {
    let seen: Record<string, unknown> = {};
    const session = { browse: async (p: Record<string, unknown>) => ((seen = p), outcome([page(0, [post(1, 1)])], "no_more")) };
    await runPassivePull(WV, { now: () => NOW, session });
    expect(seen).toMatchObject({ cutoffMs: CUTOFF, maxPages: MAX_BROWSE_PAGES, pauseMinMs: 2_000, pauseMaxMs: 6_000, url: WV.url });
    expect(MAX_BROWSE_PAGES).toBe(3);
    expect(PAUSE_RANGE_MS).toEqual([2_000, 6_000]);
  });

  it("会话构造/调用抛错 → 结构化状态,不穿出", async () => {
    const session = { browse: async () => Promise.reject(new EgoChannelError("browser_unreachable", "ego_unreachable", "x")) };
    expect(await runPassivePull(WV, { session })).toEqual({ status: "browser_unreachable", rows: [], errorCode: "ego_unreachable" });
  });
});

describe("只看不发(红线)", () => {
  const SOURCES = ["ego-scripts.ts", "ego-session.ts", "passive-pull.ts", "douyin-stats.ts", "wechat-video-stats.ts", "xhs-stats.ts", "wechat-mp-stats.ts", "pull-shared.ts"];

  it("生成的旁听脚本里没有主动请求、自造请求头、签名函数", () => {
    const script = browseScript({
      space: "s", url: WV.url, patterns: WV.patterns, gates: WV.gates, next: WV.next, inspectSrc: WV.inspectSrc,
      cutoffMs: 0, maxPages: 3, waitMs: 1, nextWaitMs: 1, settleMs: 0, navTimeoutMs: 1, pauseMinMs: 0, pauseMaxMs: 0,
    });
    for (const banned of [".fetch(", "XMLHttpRequest", "_webmsxyw", "finger-print", "x-s", "headers", "Network.setExtraHTTPHeaders", "Fetch.enable"]) {
      expect(script).not.toContain(banned);
    }
  });

  it("抓取器源码里不再有 page.fetch / 签名函数 / 随机设备指纹头", () => {
    for (const f of SOURCES) {
      const src = readFileSync(new globalThis.URL(`./${f}`, import.meta.url), "utf8");
      for (const banned of ["page.fetch", "_webmsxyw", "finger-print-device-id", "X-WECHAT-UIN", "credentials: \"include\""]) {
        expect(`${f}:${src.includes(banned)}`).toBe(`${f}:false`);
      }
    }
  });
});
