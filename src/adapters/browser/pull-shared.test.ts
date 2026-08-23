/**
 * pull-shared.test.ts — 三平台抓取器共享件。
 * 锁的是三条铁律:零写入(空 rows)、errorCode 脱敏、分页上限 200 只说 hasMore。
 */
import { describe, it, expect } from "vitest";
import type { TypedRow } from "./pull-types.js";
import {
  PAGE_ROW_LIMIT,
  assign,
  classifyThrown,
  envelopeOf,
  failure,
  fetchInPageWithInit,
  httpFailure,
  idOf,
  isoFromMillis,
  isoFromSeconds,
  keepValidRows,
  looksLikeHtml,
  normalizeRate,
  paginate,
  protectLongNumbers,
  sanitizeErrorCode,
  schemaChanged,
  toCount,
  withTab,
  type PageFetchOutcome,
  type PageStep,
} from "./pull-shared.js";

const row = (title: string, views?: number): TypedRow => ({
  title,
  publishedAt: null,
  metrics: views === undefined ? {} : { views },
});

const res = (over: Partial<PageFetchOutcome>): PageFetchOutcome => ({
  httpStatus: 200,
  finalUrl: "https://example.test/api",
  contentType: "application/json",
  bodyText: "{}",
  ...over,
});

describe("errorCode 脱敏(spec §4.1 codex #22)", () => {
  it("非白名单字符(中文/空格/引号)一律剥掉,长度截断", () => {
    expect(sanitizeErrorCode('http:500 "响应原文 token=abc"')).toBe("http:500tokenabc");
    expect(sanitizeErrorCode("x".repeat(200))).toHaveLength(64);
  });

  it("失败结果恒空 rows —— 零写入语义在抓取器层就是空数组", () => {
    expect(failure("timeout", "t")).toEqual({ status: "timeout", rows: [], errorCode: "t" });
    expect(schemaChanged("data.list")).toEqual({ status: "schema_changed", rows: [], errorCode: "missing:data.list" });
  });

  it("HTTP 状态归类:401/403 判登录,461/471 判风控,其余 error", () => {
    expect(httpFailure(401).status).toBe("needs_login");
    expect(httpFailure(461).status).toBe("risk_control");
    expect(httpFailure(471).status).toBe("risk_control");
    expect(httpFailure(500)).toMatchObject({ status: "error", errorCode: "http:500" });
  });

  it("异常只用来归类,message 绝不进 errorCode", () => {
    const leaky = new Error('页面内表达式抛错:{"msToken":"FAKE_TOKEN_DO_NOT_LEAK"}');
    const out = classifyThrown(leaky);
    expect(out.status).toBe("error");
    expect(JSON.stringify(out)).not.toContain("FAKE_TOKEN_DO_NOT_LEAK");
  });

  it("连接类异常 → browser_unreachable;超时类 → timeout", () => {
    expect(classifyThrown(new Error("chrome-cdp WebSocket 已断开")).status).toBe("browser_unreachable");
    expect(classifyThrown(new Error("CDP Runtime.evaluate 30000ms 无响应")).status).toBe("timeout");
  });
});

describe("数值与时间取值", () => {
  it("字符串数值照收,空/NaN/布尔当没这个指标(不补 0)", () => {
    expect(toCount("128340")).toBe(128340);
    expect(toCount(0)).toBe(0);
    expect(toCount("")).toBeUndefined();
    expect(toCount("abc")).toBeUndefined();
    expect(toCount(null)).toBeUndefined();
    expect(toCount(true)).toBeUndefined();
  });

  it("率类归一到 0-100:≤1 当比例乘 100,越界丢弃", () => {
    expect(normalizeRate(0.412)).toBeCloseTo(41.2);
    expect(normalizeRate("32.5")).toBe(32.5);
    expect(normalizeRate(1)).toBe(100);
    expect(normalizeRate(180)).toBeUndefined();
    expect(normalizeRate(-1)).toBeUndefined();
  });

  it("assign 只在有值时落键,率类走归一", () => {
    const m = {};
    assign(m, "views", "12");
    assign(m, "likes", "");
    assign(m, "completionRate", 0.5);
    expect(m).toEqual({ views: 12, completionRate: 50 });
  });

  it("时间:秒/毫秒各自转 ISO,0 与非数 → null(不猜)", () => {
    expect(isoFromSeconds(1783600000)).toBe(new Date(1783600000_000).toISOString());
    expect(isoFromMillis(1783600000000)).toBe(new Date(1783600000000).toISOString());
    expect(isoFromSeconds(0)).toBeNull();
    expect(isoFromMillis("x")).toBeNull();
  });

  it("长 id 精度保护:19 位数字先包成字符串再 parse", () => {
    const raw = '{"id":7412345678901234567,"n":123}';
    expect(String(JSON.parse(raw).id)).not.toBe("7412345678901234567"); // 基线:裸 parse 就是会丢位
    expect(JSON.parse(protectLongNumbers(raw, ["id"])).id).toBe("7412345678901234567");
    expect(JSON.parse(protectLongNumbers(raw, ["id"])).n).toBe(123); // 短数字不动
  });

  it("idOf:字符串优先,数字转字符串,都没有给空串", () => {
    expect(idOf(undefined, "abc")).toBe("abc");
    expect(idOf(2088888888)).toBe("2088888888");
    expect(idOf(null, "")).toBe("");
  });
});

describe("行级校验(spec §6)", () => {
  it("标题空 或 指标全空 → 丢弃并计数,同批其余行照常", () => {
    const out = keepValidRows([row("有效", 10), row("", 5), row("没指标"), row("也有效", 0)]);
    expect(out.rows.map((r) => r.title)).toEqual(["有效", "也有效"]);
    expect(out.rejected).toBe(2);
  });
});

describe("envelopeOf 三道闸", () => {
  it("HTML 伪装 200 → schema_changed(不是空数组)", () => {
    const out = envelopeOf(res({ contentType: "text/html", bodyText: "<html>扫码登录</html>" }), "post_list");
    expect(out).toMatchObject({ ok: false, result: { status: "schema_changed", rows: [], errorCode: "html_response:post_list" } });
  });

  it("JSON 解析失败 → schema_changed", () => {
    const out = envelopeOf(res({ bodyText: "not-json" }), "post_list");
    expect(out).toMatchObject({ ok: false, result: { errorCode: "json_parse:post_list" } });
  });

  it("顶层是数组不是对象 → schema_changed", () => {
    expect(envelopeOf(res({ bodyText: "[1,2]" }), "x")).toMatchObject({ ok: false, result: { status: "schema_changed" } });
  });

  it("非 200 → 按 HTTP 归类,不进 JSON 解析", () => {
    expect(envelopeOf(res({ httpStatus: 461 }), "x")).toMatchObject({ ok: false, result: { status: "risk_control" } });
  });

  it("protectKeys 在解析前生效", () => {
    const out = envelopeOf(res({ bodyText: '{"objectId":1441234567890123456}' }), "x", ["objectId"]);
    expect(out.ok && out.json.objectId).toBe("1441234567890123456");
  });

  it("looksLikeHtml 认 content-type 也认裸文档头", () => {
    expect(looksLikeHtml("text/html; charset=utf-8", "{}")).toBe(true);
    expect(looksLikeHtml("", "  <!DOCTYPE html>")).toBe(true);
    expect(looksLikeHtml("application/json", '{"a":1}')).toBe(false);
  });
});

describe("paginate", () => {
  const pageOf = (n: number, hasMore: boolean, cursor: number): PageStep<number> => ({
    kind: "page",
    rows: Array.from({ length: n }, (_, i) => row(`t${cursor}-${i}`, 1)),
    hasMore,
    next: cursor + 1,
  });

  it("翻到平台说没有下一页为止", async () => {
    const out = await paginate<number>(async (cursor) => pageOf(2, (cursor ?? 1) < 3, cursor ?? 1), { firstCursor: 1 });
    expect(out.status).toBe("ok");
    expect(out.rows).toHaveLength(6);
    expect(out.hasMore).toBe(false);
  });

  it("超 200 行 → 切到 200 + hasMore:true(不谎报精确丢弃数)", async () => {
    const out = await paginate<number>(async (cursor) => pageOf(150, true, cursor ?? 1), { firstCursor: 1 });
    expect(out.rows).toHaveLength(PAGE_ROW_LIMIT);
    expect(out.hasMore).toBe(true);
  });

  it("同 platformItemId 跨页去重", async () => {
    const dup: TypedRow = { title: "同一条", publishedAt: null, platformItemId: "x1", metrics: { views: 1 } };
    const out = await paginate<number>(async (cursor) => ({ kind: "page", rows: [dup], hasMore: (cursor ?? 1) < 2, next: (cursor ?? 1) + 1 }), {
      firstCursor: 1,
    });
    expect(out.rows).toHaveLength(1);
  });

  it("stop → 直接返回该状态,行恒空", async () => {
    const out = await paginate<number>(async () => ({ kind: "stop", result: failure("needs_login", "x") }));
    expect(out).toMatchObject({ status: "needs_login", rows: [] });
  });

  it("被丢弃的行计入 rejected", async () => {
    const out = await paginate<number>(async () => ({ kind: "page", rows: [row("好", 1), row("")], hasMore: false }));
    expect(out.rows).toHaveLength(1);
    expect(out.rejected).toBe(1);
  });

  it("maxPages 硬闸:平台 has_more 恒 true 也不会转不出来", async () => {
    let calls = 0;
    const out = await paginate<number>(
      async (cursor) => {
        calls += 1;
        return pageOf(1, true, cursor ?? 1);
      },
      { firstCursor: 1, maxPages: 3 },
    );
    expect(calls).toBe(3);
    expect(out.hasMore).toBe(true);
  });
});

describe("fetchInPageWithInit", () => {
  it("把 method/headers/body 拼进页面内 fetch,并恒带 credentials:'include'", async () => {
    let expr = "";
    const page = {
      async eval(e: string) {
        expr = e;
        return { httpStatus: 200, finalUrl: "u", contentType: "application/json", bodyText: "{}" };
      },
    };
    const out = await fetchInPageWithInit(page, "https://x.test/a", { method: "POST", headers: { "X-WECHAT-UIN": "1" }, body: '{"a":1}' }, "s1");
    expect(expr).toContain('"method":"POST"');
    expect(expr).toContain('"X-WECHAT-UIN":"1"');
    expect(expr).toContain('"credentials":"include"');
    expect(out.httpStatus).toBe(200);
  });

  it("页面返回形状不对 → 抛错,不假装拿到了响应", async () => {
    const page = { async eval() { return { oops: true }; } };
    await expect(fetchInPageWithInit(page, "https://x.test/a", {}, "s1")).rejects.toThrow(/形状异常/);
  });
});

describe("withTab", () => {
  it("异常路径也关标签(不留后台幽灵标签)", async () => {
    const closed: string[] = [];
    const host = {
      async openTab() { return { targetId: "t1", sessionId: "s1" }; },
      async closeTarget(id: string) { closed.push(id); },
    };
    await expect(withTab(host, "about:blank", async () => { throw new Error("炸了"); })).rejects.toThrow("炸了");
    expect(closed).toEqual(["t1"]);
  });
});
