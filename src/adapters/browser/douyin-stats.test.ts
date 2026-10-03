/**
 * douyin-stats.test.ts — 抖音网络旁听路线。
 * 解析层吃脱敏 fixture;旁听全打桩(旁听脚本本身在 ego-scripts.test.ts 里锁),不真连浏览器。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { EgoChannelError } from "./ego-session.js";
import {
  DOUYIN_MANAGE_URL,
  isDouyinListUrl,
  mergeDouyinParses,
  parseDouyinItemList,
  protectBigIntIds,
  pullDouyinStats,
  coverUrlOf,
  LIST_URL_PATTERNS,
  type DouyinBrowser,
} from "./douyin-stats.js";

const fixture = (rel: string): string => readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), "utf8");
const ITEM_LIST = fixture("douyin/item-list.json");
const LEGACY = fixture("douyin/work-list-legacy.json");
const NOT_LOGGED_IN = fixture("douyin/not-logged-in.json");
const DRIFT = fixture("douyin/schema-drift.json");
const LEAK_MARKERS = ["FAKE_TOKEN_DO_NOT_LEAK", "FAKE_SECUID", "登录状态失效"];

const LIST_URL = "https://creator.douyin.com/web/api/creator/item/list?count=20";

interface StubCfg {
  /** 页面发出的响应 URL → 响应体(undefined = 读不出) */
  responses?: Array<{ url: string; body?: string }>;
  domText?: string | null;
  throws?: Error;
}

/** 旁听桩:模拟 interceptScript 的产出(URL 匹配用真函数,不另写一套) */
function makeStub(cfg: StubCfg): { browser: DouyinBrowser; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const browser: DouyinBrowser = {
    async intercept(p) {
      calls.push(p);
      if (cfg.throws) throw cfg.throws;
      const hits = (cfg.responses ?? []).filter((r) => isDouyinListUrl(r.url));
      const bodies = hits.map((r) => r.body).filter((b): b is string => b !== undefined);
      return { matched: hits.length, bodies, domText: hits.length ? null : cfg.domText === undefined ? "" : cfg.domText };
    },
  };
  return { browser, calls };
}

const run = (cfg: StubCfg, over: Record<string, unknown> = {}) => {
  const stub = makeStub(cfg);
  return { stub, result: pullDouyinStats({ connect: () => stub.browser, waitMs: 200, settleMs: 0, ...over }) };
};

describe("列表 URL 匹配(新旧两路并存)", () => {
  it("现行主路与旧路都认,别的接口不认", () => {
    expect(isDouyinListUrl("https://creator.douyin.com/web/api/creator/item/list?count=20")).toBe(true);
    expect(isDouyinListUrl("https://creator.douyin.com/janus/douyin/creator/pc/work_list?page_size=20")).toBe(true);
    expect(isDouyinListUrl("https://creator.douyin.com/web/api/media/user/info/?aid=1128")).toBe(false);
  });
});

describe("精度保护(端点文档 §1 坑 ①)", () => {
  it("19 位 item id 不丢位", () => {
    const parsed = parseDouyinItemList(ITEM_LIST);
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
    const parsed = parseDouyinItemList(body);
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
    const parsed = parseDouyinItemList(body);
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0].metrics.completionRate).toBeCloseTo(0.63, 4);
    expect(parsed.rows[0].metrics.completion5s).toBeCloseTo(26.56, 4);
  });
});

describe("parseDouyinItemList(fixture 锚定)", () => {
  it("现行主路:字符串数值转数字,率类归一到 0-100,标题优先 item_title", () => {
    const parsed = parseDouyinItemList(ITEM_LIST);
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.hasMore).toBe(true);
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
    const parsed = parseDouyinItemList(LEGACY);
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      title: "把复盘写成一句话",
      platformItemId: "7400000000000000123",
      metrics: { views: 44210, likes: 1980, comments: 133, shares: 51, favorites: 208, completionRate: 27.8, completion5s: 61.2 },
    });
  });

  it("status_code:8 → needs_login,零行", () => {
    const parsed = parseDouyinItemList(NOT_LOGGED_IN);
    expect(parsed).toEqual({ kind: "stop", result: { status: "needs_login", rows: [], errorCode: "envelope:8" } });
  });

  it("字段改名 → schema_changed,零行(canary,不猜 works[] 是新 items[])", () => {
    expect(parseDouyinItemList(DRIFT)).toEqual({ kind: "stop", result: { status: "schema_changed", rows: [], errorCode: "missing:items" } });
  });

  it("HTML 伪装 200 / 坏 JSON → schema_changed,零行", () => {
    expect(parseDouyinItemList("<!DOCTYPE html><html>扫码登录</html>")).toMatchObject({
      kind: "stop",
      result: { status: "schema_changed", rows: [], errorCode: "html_response:item_list" },
    });
    expect(parseDouyinItemList("{oops")).toMatchObject({ kind: "stop", result: { errorCode: "json_parse:item_list" } });
  });

  it("其他非 0 信封 → error(只带数字码)", () => {
    expect(parseDouyinItemList('{"status_code":2190,"status_msg":"作品审核中"}')).toMatchObject({
      kind: "stop",
      result: { status: "error", errorCode: "envelope:2190" },
    });
  });
});

describe("mergeDouyinParses", () => {
  it("多条响应合并去重,任一条 has_more → hasMore", () => {
    const a = parseDouyinItemList(ITEM_LIST);
    const b = parseDouyinItemList(ITEM_LIST);
    const merged = mergeDouyinParses([a, b]);
    expect(merged.status).toBe("ok");
    expect(merged.rows).toHaveLength(2); // 三条里一条无标题被行级校验丢掉
    expect(merged.rejected).toBe(2); // 两次解析各丢一条
    expect(merged.hasMore).toBe(true);
  });

  it("未登录优先于「解析不出」:混合时报 needs_login", () => {
    const merged = mergeDouyinParses([parseDouyinItemList(DRIFT), parseDouyinItemList(NOT_LOGGED_IN)]);
    expect(merged.status).toBe("needs_login");
  });
});

describe("pullDouyinStats(旁听打桩)", () => {
  it("拦到列表响应 → ok,旁听的是作品管理页 + 两套列表路径", async () => {
    const { stub, result } = run({ responses: [{ url: LIST_URL, body: ITEM_LIST }] });
    const out = await result;
    expect(out.status).toBe("ok");
    expect(out.rows).toHaveLength(2);
    expect(stub.calls[0]).toMatchObject({ url: DOUYIN_MANAGE_URL, patterns: LIST_URL_PATTERNS });
  });

  it("拦到多条列表响应 → 合并", async () => {
    const { result } = run({
      responses: [
        { url: LIST_URL, body: ITEM_LIST },
        { url: "https://creator.douyin.com/janus/douyin/creator/pc/work_list?page_size=20", body: LEGACY },
        { url: "https://creator.douyin.com/web/api/media/user/info/?aid=1128", body: "{}" },
      ],
    });
    const out = await result;
    expect(out.status).toBe("ok");
    expect(out.rows.map((r) => r.platformItemId)).toContain("7400000000000000123");
  });

  it("什么都没拦到 + 跳了登录页(页面是登录墙) → needs_login(不是 timeout)", async () => {
    const out = await run({ responses: [], domText: "扫码登录 抖音创作者中心" }).result;
    expect(out).toMatchObject({ status: "needs_login", rows: [], errorCode: "dom_login_wall" });
  });

  it("什么都没拦到 + 页面无登录线索 → timeout(不猜 schema 变了)", async () => {
    const out = await run({ responses: [], domText: "数据概览 作品数据" }).result;
    expect(out).toMatchObject({ status: "timeout", rows: [], errorCode: "no_list_response" });
  });

  it("拦到了但响应体读不出 → timeout(不误报 canary)", async () => {
    const out = await run({ responses: [{ url: LIST_URL }] }).result;
    expect(out).toMatchObject({ status: "timeout", errorCode: "response_body_unavailable" });
  });

  it("拦到了但 schema 不认 → schema_changed + 零行", async () => {
    const out = await run({ responses: [{ url: LIST_URL, body: DRIFT }] }).result;
    expect(out).toMatchObject({ status: "schema_changed", rows: [] });
  });

  it("ego lite 连不上 → browser_unreachable", async () => {
    const out = await run({ throws: new EgoChannelError("browser_unreachable", "ego_unreachable", "连不上 ego lite") }).result;
    expect(out).toMatchObject({ status: "browser_unreachable", rows: [], errorCode: "ego_unreachable" });
  });

  it("行超上限 → 切到 limit + hasMore:true", async () => {
    const many = JSON.stringify({
      status_code: 0,
      has_more: false,
      items: Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, item_title: `t${i}`, create_time: "1783600000", metrics: { view_count: "1" } })),
    });
    const out = await run({ responses: [{ url: LIST_URL, body: many }] }, { limit: 2 }).result;
    expect(out.rows).toHaveLength(2);
    expect(out.hasMore).toBe(true);
  });
});

describe("脱敏红线(spec §6:lastError 永不含原始响应)", () => {
  it("未登录 fixture 里的假 token 不出现在任何返回值里", async () => {
    const out = await run({ responses: [{ url: LIST_URL, body: NOT_LOGGED_IN }] }).result;
    const dump = JSON.stringify(out);
    for (const marker of LEAK_MARKERS) expect(dump).not.toContain(marker);
    expect(out.errorCode).toBe("envelope:8");
  });

  it("脚本内异常把响应片段带进 message,也漏不出去", async () => {
    const out = await run({ throws: new Error('ego 脚本内异常:{"msToken":"FAKE_TOKEN_DO_NOT_LEAK_9f3a1c"}') }).result;
    expect(JSON.stringify(out)).not.toContain("FAKE_TOKEN_DO_NOT_LEAK");
    expect(out).toMatchObject({ status: "error", errorCode: "exception" });
  });

  it("页面文本取不到 → timeout(dom_probe_failed)", async () => {
    const out = await run({ responses: [], domText: null }).result;
    expect(out).toMatchObject({ status: "timeout", errorCode: "dom_probe_failed" });
  });

  it("成功路径也不带原文:只有 title/publishedAt/id/metrics 四类字段", async () => {
    const out = await run({ responses: [{ url: LIST_URL, body: ITEM_LIST }] }).result;
    const dump = JSON.stringify(out);
    for (const marker of LEAK_MARKERS) expect(dump).not.toContain(marker);
    expect(Object.keys(out.rows[0]).sort()).toEqual(["metrics", "platformItemId", "publishedAt", "title"]);
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
    const parsed = parseDouyinItemList(body);
    expect(parsed.kind === "ok" && parsed.rows[0].coverUrl).toBe("https://p3-sign.douyinpic.com/c.webp");
  });
});
