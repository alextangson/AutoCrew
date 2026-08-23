/**
 * xhs-stats.test.ts — 小红书 in-page fetch + 可选签名路线。
 * 锁三件事:登录只用免签端点判、免签优先签名兜底、461/471 立即停手。全程打桩。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { XHS_PAGE, judgeLogin, mapNoteRow, parseNoteList, pullXhsStats, signUri, type XhsCdp } from "./xhs-stats.js";
import type { PageFetchOutcome } from "./pull-shared.js";

const fixture = (rel: string): string => readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), "utf8");
const USER_INFO = fixture("xhs/user-info.json");
const USER_INFO_OUT = fixture("xhs/user-info-logged-out.json");
const ANALYZE = fixture("xhs/analyze-list.json");
const ANALYZE_DRIFT = fixture("xhs/analyze-list-drift.json");
const NOTE_STATS = fixture("xhs/note-stats-signed.json");
const LEAK_MARKERS = ["FAKE_USER_ID_DO_NOT_LEAK", "请先登录", "autocrew_lab"];

const res = (bodyText: string, over: Partial<PageFetchOutcome> = {}): PageFetchOutcome => ({
  httpStatus: 200,
  finalUrl: XHS_PAGE,
  contentType: "application/json",
  bodyText,
  ...over,
});

interface StubCfg {
  routes: Record<string, PageFetchOutcome | (() => PageFetchOutcome)>;
  hostReady?: boolean;
  /** 签名函数行为:"ok" 直接给签名 / "late" 第一次缺失第二次成功 / "missing" 一直缺失 */
  sign?: "ok" | "late" | "missing";
}

function makeStub(cfg: StubCfg): { session: XhsCdp; requests: string[]; signHeaders: string[] } {
  const requests: string[] = [];
  const signHeaders: string[] = [];
  let signCalls = 0;
  const session: XhsCdp = {
    async eval(expression: string) {
      if (expression.startsWith("location.host")) {
        return cfg.hostReady === false ? "about:blank|complete" : "creator.xiaohongshu.com|complete";
      }
      if (expression.includes("_webmsxyw")) {
        signCalls += 1;
        const mode = cfg.sign ?? "ok";
        if (mode === "missing" || (mode === "late" && signCalls === 1)) return { missing: true };
        return { missing: false, xs: "XYW_fake_xs", xt: "1783600000000" };
      }
      const url = /fetch\("([^"]+)"/.exec(expression)?.[1] ?? "";
      requests.push(url);
      if (expression.includes('"x-s"')) signHeaders.push(url);
      for (const [fragment, out] of Object.entries(cfg.routes)) {
        if (url.includes(fragment)) return typeof out === "function" ? out() : out;
      }
      return res("{}", { httpStatus: 404 });
    },
    async openTab() {
      return { targetId: "t1", sessionId: "s1" };
    },
    async closeTarget() {},
    close() {},
  };
  return { session, requests, signHeaders };
}

const run = (cfg: StubCfg, over: Record<string, unknown> = {}) => {
  const stub = makeStub(cfg);
  return {
    stub,
    result: pullXhsStats({
      connect: async () => ({ session: stub.session }),
      navTimeoutMs: 300,
      delayMs: 0,
      signRetryMs: 1,
      ...over,
    }),
  };
};

describe("登录判定只用免签端点(端点文档 §3 明确要求)", () => {
  it("success:true → 在线", () => {
    expect(judgeLogin(res(USER_INFO))).toBe("logged_in");
  });

  it("success:false → needs_login(免签端点上这个 false 无歧义)", () => {
    expect(judgeLogin(res(USER_INFO_OUT))).toMatchObject({ status: "needs_login", rows: [], errorCode: "login_ping_success_false" });
  });

  it("连 success 字段都没有 → schema_changed(接口换形状,不是没登录)", () => {
    expect(judgeLogin(res('{"data":{}}'))).toMatchObject({ status: "schema_changed", errorCode: "missing:login_ping.success" });
  });

  it("461 → risk_control", () => {
    expect(judgeLogin(res("", { httpStatus: 461 }))).toMatchObject({ status: "risk_control", rows: [], errorCode: "http:461" });
  });
});

describe("parseNoteList(fixture 锚定)", () => {
  it("字段映射:read_count→views / fav_count→favorites,post_time 是毫秒", () => {
    const parsed = parseNoteList(res(ANALYZE), "analyze_list");
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0]).toMatchObject({
      title: "做一人公司的第 30 天：把复盘交给代码",
      platformItemId: "65f1a2b3000000001203e4d5",
      metrics: { views: 18422, likes: 902, favorites: 431, comments: 66 },
    });
    expect(parsed.rows[0].publishedAt).toBe(new Date(1783600000000).toISOString());
  });

  it("不映射 impressions/completionRate —— xhs 没有可靠来源,不猜", () => {
    const parsed = parseNoteList(res(ANALYZE), "analyze_list");
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0].metrics.impressions).toBeUndefined();
    expect(parsed.rows[0].metrics.completionRate).toBeUndefined();
  });

  it("note_infos 改名 → schema_changed,零行(canary)", () => {
    expect(parseNoteList(res(ANALYZE_DRIFT), "analyze_list")).toEqual({
      kind: "stop",
      result: { status: "schema_changed", rows: [], errorCode: "missing:analyze_list.data.note_infos" },
    });
  });

  it("success:false → error(带信封 code,不带 msg 原文)", () => {
    const out = parseNoteList(res('{"success":false,"code":-1,"msg":"签名校验失败"}'), "note_stats");
    expect(out).toMatchObject({ kind: "stop", result: { status: "error", errorCode: "note_stats_code:-1" } });
    expect(JSON.stringify(out)).not.toContain("签名校验失败");
  });

  it("HTML 伪装 200 → schema_changed", () => {
    expect(parseNoteList(res("<html>", { contentType: "text/html" }), "analyze_list")).toMatchObject({
      kind: "stop",
      result: { status: "schema_changed", rows: [] },
    });
  });

  it("note_id 兼容字段名,标题空 → 行级校验会丢(见 pull-shared)", () => {
    expect(mapNoteRow({ note_id: "abc", read_count: 3 }).platformItemId).toBe("abc");
    expect(mapNoteRow({ id: "abc" }).metrics).toEqual({});
  });
});

describe("签名(window._webmsxyw)", () => {
  const signPage = (mode: StubCfg["sign"]) => makeStub({ routes: {}, sign: mode }).session;

  it("拿到 X-s/X-t → 映射成 x-s/x-t", async () => {
    await expect(signUri(signPage("ok"), "s1", "/api/x", 1)).resolves.toEqual({ xs: "XYW_fake_xs", xt: "1783600000000" });
  });

  it("首次缺失 → sleep 后重试一次就成(社区已知的注册时序问题)", async () => {
    await expect(signUri(signPage("late"), "s1", "/api/x", 1)).resolves.toMatchObject({ xs: "XYW_fake_xs" });
  });

  it("重试后仍缺失 → null(调用方转 sign_fn_missing,不静默降级成空数据)", async () => {
    await expect(signUri(signPage("missing"), "s1", "/api/x", 1)).resolves.toBeNull();
  });

  it("`_webmsxyw is not a function` 以异常形态回来也当缺失", async () => {
    const page = {
      async eval() {
        throw new Error("页面内表达式抛错:TypeError: window._webmsxyw is not a function");
      },
    };
    await expect(signUri(page, "s1", "/api/x", 1)).resolves.toBeNull();
  });
});

describe("pullXhsStats(打桩)", () => {
  it("免签路线打通 → ok,且一次签名都没调过", async () => {
    const { stub, result } = run({ routes: { "user/info": res(USER_INFO), "analyze/list": res(ANALYZE) } });
    const out = await result;
    expect(out.status).toBe("ok");
    expect(out.rows).toHaveLength(2); // 第三条标题空 → 行级丢弃
    expect(stub.signHeaders).toHaveLength(0);
  });

  it("免签探路那一页会被复用,不重复打", async () => {
    const { stub, result } = run({ routes: { "user/info": res(USER_INFO), "analyze/list": res(ANALYZE) } });
    await result;
    expect(stub.requests.filter((u) => u.includes("analyze/list"))).toHaveLength(1);
  });

  it("免签 analyze/list 不可用 → 换签名 note_stats,请求带 x-s/x-t", async () => {
    const { stub, result } = run({
      routes: { "user/info": res(USER_INFO), "analyze/list": res('{"success":false,"code":-1}'), "note_stats/new": res(NOTE_STATS) },
    });
    const out = await result;
    expect(out.status).toBe("ok");
    expect(out.rows[0].platformItemId).toBe("65f1a2b3000000001203e4f1");
    expect(stub.signHeaders.length).toBeGreaterThan(0);
  });

  it("免签不可用 + 签名函数缺失 → error(sign_fn_missing),零行", async () => {
    const out = await run({
      routes: { "user/info": res(USER_INFO), "analyze/list": res('{"success":false,"code":-1}') },
      sign: "missing",
    }).result;
    expect(out).toMatchObject({ status: "error", rows: [], errorCode: "sign_fn_missing" });
  });

  it("未登录 → needs_login,且不去碰数据端点", async () => {
    const { stub, result } = run({ routes: { "user/info": res(USER_INFO_OUT) } });
    expect(await result).toMatchObject({ status: "needs_login", rows: [] });
    expect(stub.requests.some((u) => u.includes("analyze/list"))).toBe(false);
  });

  it("免签主端点无结论时退到旧 posted 端点判登录", async () => {
    const { stub, result } = run({
      routes: { "user/info": res('{"noSuchField":1}'), "note/user/posted": res(USER_INFO_OUT) },
    });
    expect(await result).toMatchObject({ status: "needs_login" });
    expect(stub.requests.some((u) => u.includes("note/user/posted"))).toBe(true);
  });

  it("461 风控 → risk_control,立即停手不换路", async () => {
    const { stub, result } = run({ routes: { "user/info": res(USER_INFO), "analyze/list": res("", { httpStatus: 461 }) } });
    expect(await result).toMatchObject({ status: "risk_control", rows: [], errorCode: "http:461" });
    expect(stub.signHeaders).toHaveLength(0);
  });

  it("471 风控同样立即停", async () => {
    const out = await run({ routes: { "user/info": res("", { httpStatus: 471 }) } }).result;
    expect(out).toMatchObject({ status: "risk_control", errorCode: "http:471" });
  });

  it("列表 schema 漂移 → schema_changed + 零行", async () => {
    const out = await run({
      routes: { "user/info": res(USER_INFO), "analyze/list": res(ANALYZE_DRIFT), "note_stats/new": res(ANALYZE_DRIFT) },
    }).result;
    expect(out).toMatchObject({ status: "schema_changed", rows: [] });
  });

  it("标签页没落到 xhs 域 → timeout", async () => {
    const out = await run({ routes: {}, hostReady: false }).result;
    expect(out).toMatchObject({ status: "timeout", errorCode: "page_not_ready" });
  });

  it("分页:满页就翻,超上限 → hasMore:true", async () => {
    let n = 0;
    const page = () => {
      n += 1;
      return res(
        JSON.stringify({
          success: true,
          data: { note_infos: Array.from({ length: 4 }, (_, i) => ({ id: `n${n}-${i}`, title: `t${n}-${i}`, read_count: 7 })) },
        }),
      );
    };
    const out = await run({ routes: { "user/info": res(USER_INFO), "analyze/list": page } }, { pageSize: 4, limit: 6 }).result;
    expect(out.rows).toHaveLength(6);
    expect(out.hasMore).toBe(true);
  });

  it("chrome-cdp 连不上 → browser_unreachable", async () => {
    const out = await pullXhsStats({
      connect: async () => {
        throw new Error("chrome-cdp WebSocket 连接失败");
      },
    });
    expect(out).toMatchObject({ status: "browser_unreachable", errorCode: "cdp_unreachable" });
  });
});

describe("脱敏红线", () => {
  it("成功路径:fixture 里的账号标识不出现在返回值里", async () => {
    const dump = JSON.stringify(await run({ routes: { "user/info": res(USER_INFO), "analyze/list": res(ANALYZE) } }).result);
    for (const marker of LEAK_MARKERS) expect(dump).not.toContain(marker);
  });

  it("未登录路径:msg 原文不出现在返回值里", async () => {
    const dump = JSON.stringify(await run({ routes: { "user/info": res(USER_INFO_OUT) } }).result);
    for (const marker of LEAK_MARKERS) expect(dump).not.toContain(marker);
  });
});
