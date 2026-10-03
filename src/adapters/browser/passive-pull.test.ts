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

  it("P2-4 中途碰到风控页 → 状态就是 risk_control(调度当天不再碰),已拿到的行照样带上", () => {
    const r = judge(outcome([page(0, [post(1, 1)])], "gate", { gate: "risk" }));
    expect(r).toMatchObject({ status: "risk_control", errorCode: "partial:risk_page", pages: 1 });
    expect(r.rows).toHaveLength(1);
  });

  it("P2-4 中途跳到登录页 → needs_login(待办会提示登录),已拿到的行照样带上", () => {
    const r = judge(outcome([page(0, [post(1, 1)])], "gate", { gate: "login" }));
    expect(r).toMatchObject({ status: "needs_login", errorCode: "partial:login_page" });
    expect(r.rows).toHaveLength(1);
  });

  it("第 2 页风控 HTTP 码 → risk_control,第 1 页保留;第 1 页就风控 → risk_control 零行", () => {
    const r = judge(outcome([page(0, [post(1, 1)]), page(1, [], 461)], "http_status"));
    expect(r).toMatchObject({ status: "risk_control", errorCode: "partial:http:461" });
    expect(r.rows).toHaveLength(1);
    expect(judge(outcome([page(0, [], 461)], "http_status"))).toMatchObject({ status: "risk_control", rows: [] });
  });

  it("P2-3 同一窗口既有可用数据又有 HTTP 461 → 风控不丢,数据保留", () => {
    const mixed: CapturedPage = { index: 0, responses: [...page(0, [post(1, 1)]).responses, { url: URL, status: 461, body: "{}" }] };
    const r = judge(outcome([mixed], "http_status"));
    expect(r).toMatchObject({ status: "risk_control", errorCode: "partial:http:461" });
    expect(r.rows).toHaveLength(1);
  });

  it("P2-5 点了翻页却没新响应 → 前面的页保留,但标注没抓全及原因", () => {
    expect(judge(outcome([page(0, [post(1, 1)])], "no_new_response"))).toMatchObject({ status: "ok", errorCode: "incomplete:no_new_response" });
    expect(judge(outcome([page(0, [post(1, 1)]), page(1, [post(2, 2)])], "pagination_missing"))).toMatchObject({ errorCode: "incomplete:pagination_missing" });
  });

  it("P2-6 发布时间字段缺失/改名 → 这一页 schema_changed;前面的页保留", () => {
    const noDate = { ...post(2, 1), createTime: undefined };
    expect(judge(outcome([page(0, [noDate])], "no_more"))).toMatchObject({ status: "schema_changed", rows: [], errorCode: "missing:publishedAt" });
    const r = judge(outcome([page(0, [post(1, 1)]), page(1, [noDate])], "max_pages"));
    expect(r).toMatchObject({ status: "ok", errorCode: "partial:schema_changed:missing:publishedAt" });
    expect(r.rows).toHaveLength(1);
  });

  it("P2-7 解析器抛错(createTime 1e15 → Invalid time value)→ 这一页结构化失败,前面的页保留", () => {
    const bad = { ...post(2, 1), createTime: 1e15 };
    const r = judge(outcome([page(0, [post(1, 1)]), page(1, [bad])], "max_pages"));
    expect(r).toMatchObject({ status: "ok", errorCode: "partial:schema_changed:parse_exception" });
    expect(r.rows).toHaveLength(1);
    expect(judge(outcome([page(0, [bad])], "no_more"))).toMatchObject({ status: "schema_changed", errorCode: "parse_exception" });
  });

  it("R2-P2 同页无日期行 + HTTP 461 → 风控优先(页仍拒收),不降成 schema_changed", () => {
    const noDate = { ...post(2, 1), createTime: undefined };
    const mixed: CapturedPage = { index: 0, responses: [...page(0, [noDate]).responses, { url: URL, status: 461, body: "{}" }] };
    expect(judge(outcome([mixed], "http_status"))).toMatchObject({ status: "risk_control", rows: [] });
  });

  it("R2-P2 无日期页 + 旁听因风控/登录页结束 → 终止信号优先", () => {
    const noDate = { ...post(2, 1), createTime: undefined };
    expect(judge(outcome([page(0, [noDate])], "gate", { gate: "risk" }))).toMatchObject({ status: "risk_control", rows: [] });
    const r = judge(outcome([page(0, [post(1, 1)]), page(1, [noDate])], "gate", { gate: "login" }));
    expect(r).toMatchObject({ status: "needs_login" });
    expect(r.rows).toHaveLength(1);
  });

  it("菜单入口找不到 → 失败、零行、原因可见", () => {
    expect(judge(outcome([], "entry_missing"))).toEqual({ status: "error", rows: [], errorCode: "entry_ui_missing" });
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

  it("P1-1 脚本只 goto 平台入口页一次;四个平台的入口都是给人看的页面,不是接口/数据地址", async () => {
    const script = browseScript({
      space: "s", url: WV.url, patterns: WV.patterns, gates: WV.gates, next: WV.next, inspectSrc: WV.inspectSrc,
      cutoffMs: 0, maxPages: 3, waitMs: 1, nextWaitMs: 1, settleMs: 0, navTimeoutMs: 1, pauseMinMs: 0, pauseMaxMs: 0,
    });
    expect(script.match(/page\.goto\(/g)).toEqual(["page.goto("]);
    expect(script).toContain("page.goto(P.url,");
    const { DOUYIN_PLATFORM } = await import("./douyin-stats.js");
    const { XHS_PLATFORM } = await import("./xhs-stats.js");
    const { WECHAT_MP_PLATFORM } = await import("./wechat-mp-stats.js");
    for (const p of [DOUYIN_PLATFORM, WV, XHS_PLATFORM, WECHAT_MP_PLATFORM]) {
      expect(p.url).not.toMatch(/\/api\/|cgi-bin|mmfinderassistant|\?|token=/);
      expect(Object.keys(p)).not.toContain("follow");
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
