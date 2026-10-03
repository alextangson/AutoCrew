/**
 * douyin-stats.test.ts — 抖音旁听:解析层吃脱敏 fixture;翻页判定(inspect)在测试里真跑;
 * 旁听脚本本身在 ego-scripts.test.ts 里锁,端到端判定在 passive-pull.test.ts。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { DOUYIN_INSPECT_SRC, DOUYIN_MANAGE_URL, DOUYIN_PLATFORM, parseDouyinItemList, protectBigIntIds, pullDouyinStats, coverUrlOf } from "./douyin-stats.js";
import type { BrowseOutcome } from "./ego-session.js";

const fixture = (rel: string): string => readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), "utf8");
const ITEM_LIST = fixture("douyin/item-list.json");
const LEGACY = fixture("douyin/work-list-legacy.json");
const NOT_LOGGED_IN = fixture("douyin/not-logged-in.json");
const DRIFT = fixture("douyin/schema-drift.json");
const LEAK_MARKERS = ["FAKE_TOKEN_DO_NOT_LEAK", "FAKE_SECUID", "登录状态失效"];
const LIST_URL = "https://creator.douyin.com/web/api/creator/item/list?count=20";
const r = (body: string, status = 200) => ({ url: LIST_URL, status, body });
type Inspect = (rs: Array<{ url: string; body: string }>) => { oldestMs: number | null; hasMore: boolean | null; terminal?: string | null };
const inspect = (0, eval)(`(${DOUYIN_INSPECT_SRC})`) as Inspect;

describe("精度保护(端点文档 §1 坑 ①)", () => {
  it("19 位 item id 不丢位", () => {
    const parsed = parseDouyinItemList(r(ITEM_LIST));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.rows[0].platformItemId).toBe("7412345678901234567");
    expect(parsed.rows[1].platformItemId).toBe("7412345678901234568");
  });

  it("裸 JSON.parse 会丢位(基线),protectBigIntIds 之后不会", () => {
    expect(String(JSON.parse(ITEM_LIST).items[0].id)).not.toBe("7412345678901234567");
    expect(JSON.parse(protectBigIntIds(ITEM_LIST)).items[0].id).toBe("7412345678901234567");
  });
});

describe("封面点击率（09-27 真实接口字段 metrics.cover_click_rate，比例字符串）", () => {
  it("比例归一成百分比；没有这个字段就不落键", () => {
    const body = JSON.stringify({ items: [
      { id: "1", item_title: "有点击率", create_time: 1783600000, metrics: { view_count: "100", cover_click_rate: "0.243243", cover_show: "111" } },
      { id: "2", item_title: "没有点击率", create_time: 1783600000, metrics: { view_count: "50" } },
    ], has_more: false });
    const parsed = parseDouyinItemList(r(body));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0].metrics.coverClickRate).toBeCloseTo(24.3243, 3);
    expect(parsed.rows[1].metrics).not.toHaveProperty("coverClickRate");
  });
});

describe("完播率比例换算（真实接口里抖音率类是比例字符串，同 cover_click_rate）", () => {
  it("0.0063 → 0.63%（长视频真实完播率），不会被当成 63%", () => {
    const body = JSON.stringify({ items: [
      { id: "1", item_title: "6 分钟长视频", create_time: 1783600000, metrics: { view_count: "900", completion_rate: "0.0063", completion_rate_5s: "0.2656" } },
    ], has_more: false });
    const parsed = parseDouyinItemList(r(body));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0].metrics.completionRate).toBeCloseTo(0.63, 4);
    expect(parsed.rows[0].metrics.completion5s).toBeCloseTo(26.56, 4);
  });
});

describe("parseDouyinItemList(r(fixture 锚定)", () => {
  it("现行主路:字符串数值转数字,率类归一到 0-100,标题优先 item_title", () => {
    const parsed = parseDouyinItemList(r(ITEM_LIST));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0]).toMatchObject({
      title: "半夜三点改需求",
      platformItemId: "7412345678901234567",
      metrics: { views: 128340, likes: 5621, comments: 412, shares: 133, favorites: 876, completionRate: 32.5, completion5s: 68.1 },
    });
    expect(parsed.rows[0].publishedAt).toBe(new Date(1783600000_000).toISOString());
    // 没有 item_title 时退 description
    expect(parsed.rows[1].title).toBe("一个人做公司，第 30 天");
    // 0.41 是比例形态 → 归一成 41%
    expect(parsed.rows[1].metrics.completionRate).toBeCloseTo(41);
  });

  it("旧路 work_list:aweme_list 出计数,同索引 items[].metrics 出率类", () => {
    const parsed = parseDouyinItemList(r(LEGACY));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      title: "把复盘写成一句话",
      platformItemId: "7400000000000000123",
      metrics: { views: 44210, likes: 1980, comments: 133, shares: 51, favorites: 208, completionRate: 27.8, completion5s: 61.2 },
    });
  });

  it("status_code:8 → needs_login,零行", () => {
    const parsed = parseDouyinItemList(r(NOT_LOGGED_IN));
    expect(parsed).toEqual({ kind: "stop", result: { status: "needs_login", rows: [], errorCode: "envelope:8" } });
  });

  it("字段改名 → schema_changed,零行(canary,不猜 works[] 是新 items[])", () => {
    expect(parseDouyinItemList(r(DRIFT))).toEqual({ kind: "stop", result: { status: "schema_changed", rows: [], errorCode: "missing:items" } });
  });

  it("HTML 伪装 200 / 坏 JSON → schema_changed,零行", () => {
    expect(parseDouyinItemList(r("<!DOCTYPE html><html>扫码登录</html>"))).toMatchObject({
      kind: "stop",
      result: { status: "schema_changed", rows: [], errorCode: "html_response:item_list" },
    });
    expect(parseDouyinItemList(r("{oops"))).toMatchObject({ kind: "stop", result: { errorCode: "json_parse:item_list" } });
  });

  it("其他非 0 信封 → error(只带数字码)", () => {
    expect(parseDouyinItemList(r('{"status_code":2190,"status_msg":"作品审核中"}'))).toMatchObject({
      kind: "stop",
      result: { status: "error", errorCode: "envelope:2190" },
    });
  });
});
describe("常量", () => {
  it("导航目标是作品管理页", () => {
    expect(DOUYIN_MANAGE_URL).toBe("https://creator.douyin.com/creator-micro/content/manage");
  });
});

describe("coverUrlOf（真实 work_list 响应的封面字段，2026-09-27 抓包）", () => {
  it("旧路 aweme_list[].Cover、主路 items[].cover 都认；只要 https", () => {
    expect(coverUrlOf({ Cover: { uri: "u", url_list: ["https://p11-sign.douyinpic.com/a.webp"] } })).toBe("https://p11-sign.douyinpic.com/a.webp");
    expect(coverUrlOf({ cover: { url_list: ["http://x", "https://p3-sign.douyinpic.com/b.webp"] } })).toBe("https://p3-sign.douyinpic.com/b.webp");
    expect(coverUrlOf({ cover: "https://nope" })).toBeUndefined();
    expect(coverUrlOf({})).toBeUndefined();
  });

  it("解析出的行带上 coverUrl", () => {
    const body = JSON.stringify({ status_code: 0, has_more: false, items: [
      { id: "7412345678901234567", item_title: "有封面", create_time: 1726000000, metrics: { view_count: "10" }, cover: { url_list: ["https://p3-sign.douyinpic.com/c.webp"] } },
    ] });
    const parsed = parseDouyinItemList(r(body));
    expect(parsed.kind === "ok" && parsed.rows[0].coverUrl).toBe("https://p3-sign.douyinpic.com/c.webp");
  });
});

describe("旁听配置:只看作品管理页自己收到的列表响应,往下滚翻页", () => {
  it("两套列表路径都旁听;翻页是滚动;登录墙/风控页特征都在", () => {
    expect(DOUYIN_PLATFORM).toMatchObject({ url: DOUYIN_MANAGE_URL, next: { kind: "scroll" } });
    expect(DOUYIN_PLATFORM.patterns).toEqual(["/web/api/creator/item/list", "/janus/douyin/creator/pc/work_list"]);
    expect(DOUYIN_PLATFORM.gates.loginText).toContain("扫码登录");
    expect(DOUYIN_PLATFORM.gates.riskText).toContain("滑块");
  });

  it("inspect:取本页最早发布时间(秒→毫秒)与 has_more;坏 JSON 跳过", () => {
    const info = inspect([r(ITEM_LIST), { url: LIST_URL, body: "{oops" }]);
    expect(info.hasMore).toBe(true);
    expect(info.oldestMs).toBe(Math.min(...JSON.parse(ITEM_LIST).items.map((i: { create_time: number }) => i.create_time)) * 1000);
    expect(inspect([r(LEGACY)])).toMatchObject({ hasMore: false });
    expect(inspect([{ url: LIST_URL, body: "{}" }])).toEqual({ oldestMs: null, hasMore: null, terminal: null });
  });

  it("P2-1 inspect:信封 status_code 8 → terminal login(浏览循环里立刻停,不再滚)", () => {
    expect(inspect([r(NOT_LOGGED_IN)]).terminal).toBe("login");
    expect(inspect([r(ITEM_LIST)]).terminal).toBeNull();
  });
});

describe("pullDouyinStats 经假会话端到端", () => {
  const session = (o: BrowseOutcome) => ({ browse: async () => o });
  const now = () => new Date(1783600000_000 + 86_400_000);

  it("一页列表响应 → ok;成功路径不带响应原文", async () => {
    const res = await pullDouyinStats({ now, session: session({ pages: [{ index: 0, responses: [r(ITEM_LIST)] }], end: "no_more", gate: null }) });
    expect(res.status).toBe("ok");
    expect(res.rows.length).toBeGreaterThan(0);
    for (const m of LEAK_MARKERS) expect(JSON.stringify(res)).not.toContain(m);
  });

  it("status_code:8 → needs_login,零行,错误码不带原文", async () => {
    const res = await pullDouyinStats({ now, session: session({ pages: [{ index: 0, responses: [r(NOT_LOGGED_IN)] }], end: "no_more", gate: null }) });
    expect(res).toEqual({ status: "needs_login", rows: [], errorCode: "envelope:8" });
  });
});
