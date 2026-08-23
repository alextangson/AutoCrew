/**
 * wechat-video-stats.test.ts — 视频号 in-page fetch 路线。
 * 解析层吃脱敏 fixture;页面内 fetch 全打桩(按 URL 路由假响应),不真连浏览器。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  WECHAT_VIDEO_PAGE,
  commonBody,
  mapPostRow,
  parseAuthData,
  parsePostList,
  pickFinderUsername,
  pickTitle,
  pullWechatVideoStats,
  type WechatVideoCdp,
} from "./wechat-video-stats.js";
import type { PageFetchOutcome } from "./pull-shared.js";

const fixture = (rel: string): string => readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), "utf8");
const AUTH_OK = fixture("wechat-video/auth-data.json");
const AUTH_OUT = fixture("wechat-video/auth-data-logged-out.json");
const UPLOAD_PARAMS = fixture("wechat-video/helper-upload-params.json");
const POST_LIST = fixture("wechat-video/post-list.json");
const POST_LIST_DRIFT = fixture("wechat-video/post-list-drift.json");
const LEAK_MARKERS = ["FAKE_SESSIONID_DO_NOT_LEAK", "FAKE_FINDER_USERNAME", "session expired"];

const res = (bodyText: string, over: Partial<PageFetchOutcome> = {}): PageFetchOutcome => ({
  httpStatus: 200,
  finalUrl: WECHAT_VIDEO_PAGE,
  contentType: "application/json; charset=UTF-8",
  bodyText,
  ...over,
});

/** 页面内 fetch 桩:按 URL 里的路径片段路由假响应 */
interface StubCfg {
  routes: Record<string, PageFetchOutcome | (() => PageFetchOutcome)>;
  hostReady?: boolean;
  evalThrows?: Error;
}

function makeStub(cfg: StubCfg): { session: WechatVideoCdp; requests: string[] } {
  const requests: string[] = [];
  const session: WechatVideoCdp = {
    async eval(expression: string) {
      if (expression.startsWith("location.host")) {
        return cfg.hostReady === false ? "about:blank|complete" : "channels.weixin.qq.com|complete";
      }
      if (cfg.evalThrows) throw cfg.evalThrows;
      const url = /fetch\("([^"]+)"/.exec(expression)?.[1] ?? "";
      requests.push(url);
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
  return { session, requests };
}

const run = (cfg: StubCfg, over: Record<string, unknown> = {}) => {
  const stub = makeStub(cfg);
  return {
    stub,
    result: pullWechatVideoStats({ connect: async () => ({ session: stub.session }), navTimeoutMs: 300, delayMs: 0, ...over }),
  };
};

const okRoutes = (postList = POST_LIST) => ({
  "/auth/auth_data": res(AUTH_OK),
  "/helper/helper_upload_params": res(UPLOAD_PARAMS),
  "/post/post_list": res(postList),
});

describe("公共 body(端点文档 §2)", () => {
  it("timestamp 是毫秒字符串,_log_finder_id 带 finderUsername", () => {
    const body = commonBody("v2_abc@finder");
    expect(typeof body.timestamp).toBe("string");
    expect(Number(body.timestamp)).toBeGreaterThan(1_700_000_000_000);
    expect(body).toMatchObject({ _log_finder_id: "v2_abc@finder", _log_finder_uin: "", rawKeyBuff: "", pluginSessionId: null, scene: 7, reqScene: 7 });
  });
});

describe("登录判定(正向证据)", () => {
  it("errCode:0 且拿得到 finderUsername → 在线", () => {
    const out = parseAuthData(res(AUTH_OK));
    expect(out).toMatchObject({ ok: true, finderUsername: "v2_FAKE_FINDER_USERNAME_do_not_leak@finder" });
  });

  it("errCode 非 0 → needs_login,errorCode 只带数字码", () => {
    expect(parseAuthData(res(AUTH_OUT))).toEqual({ ok: false, result: { status: "needs_login", rows: [], errorCode: "auth_errcode:300110" } });
  });

  it("errCode:0 但没有 finderUsername → 仍判 needs_login(不当成功)", () => {
    expect(parseAuthData(res('{"errCode":0,"data":{}}'))).toMatchObject({ ok: false, result: { status: "needs_login", errorCode: "auth_no_finder_username" } });
  });

  it("连 errCode 都没有 → schema_changed(接口换形状,不是没登录)", () => {
    expect(parseAuthData(res('{"ok":true}'))).toMatchObject({ ok: false, result: { status: "schema_changed", errorCode: "missing:auth_data.errCode" } });
  });

  it("HTML 伪装 200 → schema_changed", () => {
    expect(parseAuthData(res("<html>登录</html>", { contentType: "text/html" }))).toMatchObject({
      ok: false,
      result: { status: "schema_changed", rows: [] },
    });
  });

  it("finderUsername 认几条常见路径(路径未确认,待校准)", () => {
    expect(pickFinderUsername({ finderUser: { finderUsername: "a" } })).toBe("a");
    expect(pickFinderUsername({ finderUsername: "b" })).toBe("b");
    expect(pickFinderUsername({ user: { finderUsername: "c" } })).toBe("c");
    expect(pickFinderUsername(null)).toBe("");
  });
});

describe("parsePostList(fixture 锚定)", () => {
  it("字段映射:readCount→views / forwardCount→shares / favCount→favorites / followCount→follows", () => {
    const parsed = parsePostList(res(POST_LIST));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.totalCount).toBe(3);
    expect(parsed.rows[0]).toMatchObject({
      title: "一个人做公司第 30 天",
      platformItemId: "1441234567890123456",
      metrics: { views: 20431, likes: 733, comments: 51, shares: 96, favorites: 188, follows: 24 },
    });
    expect(parsed.rows[0].publishedAt).toBe(new Date(1783600000_000).toISOString());
  });

  it("fullPlayRate 归一到 0-100(0.412→41.2,55.5 原样)", () => {
    const parsed = parsePostList(res(POST_LIST));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows[0].metrics.completionRate).toBeCloseTo(41.2);
    expect(parsed.rows[1].metrics.completionRate).toBe(55.5);
  });

  it("标题优先 shortTitle,没有才退 description", () => {
    expect(pickTitle({ shortTitle: [{ shortTitle: "短" }], description: "长" })).toBe("短");
    expect(pickTitle({ description: "长" })).toBe("长");
    expect(pickTitle({ shortTitle: [] })).toBe("");
  });

  it("objectId 是 19 位数字,过 parsePostList 不丢精度(保护在文本层,不在 mapPostRow)", () => {
    const parsed = parsePostList(res(POST_LIST));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows.map((r) => r.platformItemId)).toEqual([
      "1441234567890123456",
      "1441234567890123457",
      "1441234567890123458",
    ]);
    // 基线:同一段文本裸 parse 就是会丢位
    expect(String(JSON.parse(POST_LIST).data.list[0].objectId)).not.toBe("1441234567890123456");
  });

  it("exportId 作为 objectId 缺失时的退路", () => {
    expect(mapPostRow({ exportId: "export_x", readCount: 1 }).platformItemId).toBe("export_x");
  });

  it("data.list 改名 → schema_changed,零行(canary)", () => {
    expect(parsePostList(res(POST_LIST_DRIFT))).toEqual({
      kind: "stop",
      result: { status: "schema_changed", rows: [], errorCode: "missing:data.list" },
    });
  });

  it("errCode 非 0 → error", () => {
    expect(parsePostList(res('{"errCode":-1,"data":{}}'))).toMatchObject({ kind: "stop", result: { status: "error", errorCode: "post_list_errcode:-1" } });
  });
});

describe("pullWechatVideoStats(打桩)", () => {
  it("完整顺序:auth_data → helper_upload_params → post_list", async () => {
    const { stub, result } = run({ routes: okRoutes() });
    const out = await result;
    expect(out.status).toBe("ok");
    expect(out.rows).toHaveLength(2); // 第三条标题空+无指标 → 行级丢弃
    expect(stub.requests[0]).toContain("/auth/auth_data");
    expect(stub.requests[1]).toContain("/helper/helper_upload_params");
    expect(stub.requests[2]).toContain("/post/post_list");
  });

  it("拿到的 uin 进 X-WECHAT-UIN header", async () => {
    let listExpr = "";
    const stub = makeStub({ routes: okRoutes() });
    const inner = stub.session.eval.bind(stub.session);
    stub.session.eval = async (expr: string, sid: string, awaitPromise?: boolean) => {
      if (expr.includes("/post/post_list")) listExpr = expr;
      return inner(expr, sid, awaitPromise);
    };
    await pullWechatVideoStats({ connect: async () => ({ session: stub.session }), navTimeoutMs: 300, delayMs: 0 });
    expect(listExpr).toContain('"X-WECHAT-UIN":"2088888888"');
  });

  it("uin 拿不到不阻断:退 0000000000,列表照抓", async () => {
    const { result } = run({ routes: { ...okRoutes(), "/helper/helper_upload_params": res("{}", { httpStatus: 500 }) } });
    expect((await result).status).toBe("ok");
  });

  it("未登录 → needs_login,且不会去打 post_list", async () => {
    const { stub, result } = run({ routes: { "/auth/auth_data": res(AUTH_OUT) } });
    expect(await result).toMatchObject({ status: "needs_login", rows: [] });
    expect(stub.requests.some((u) => u.includes("post_list"))).toBe(false);
  });

  it("HTTP 401 → needs_login;HTTP 500 → error", async () => {
    expect(await run({ routes: { "/auth/auth_data": res("{}", { httpStatus: 401 }) } }).result).toMatchObject({ status: "needs_login" });
    expect(await run({ routes: { "/auth/auth_data": res("{}", { httpStatus: 500 }) } }).result).toMatchObject({ status: "error", errorCode: "http:500" });
  });

  it("列表 schema 漂移 → schema_changed + 零行(零写入)", async () => {
    const out = await run({ routes: okRoutes(POST_LIST_DRIFT) }).result;
    expect(out).toMatchObject({ status: "schema_changed", rows: [] });
  });

  it("标签页没落到 channels 域 → timeout(不误报未登录)", async () => {
    const out = await run({ routes: okRoutes(), hostReady: false }).result;
    expect(out).toMatchObject({ status: "timeout", rows: [], errorCode: "page_not_ready" });
  });

  it("分页:满页就翻,超上限 → hasMore:true", async () => {
    const page = (n: number) =>
      res(
        JSON.stringify({
          errCode: 0,
          data: { totalCount: 999, list: Array.from({ length: n }, (_, i) => ({ objectId: `p${Math.random()}${i}`, readCount: 5, desc: { description: `t${i}` } })) },
        }),
      );
    const out = await run({ routes: { ...okRoutes(), "/post/post_list": () => page(4) } }, { pageSize: 4, limit: 10 }).result;
    expect(out.rows).toHaveLength(10);
    expect(out.hasMore).toBe(true);
  });

  it("chrome-cdp 连不上 → browser_unreachable", async () => {
    const out = await pullWechatVideoStats({
      connect: async () => {
        throw new Error("chrome-cdp WebSocket 已断开");
      },
    });
    expect(out).toMatchObject({ status: "browser_unreachable", errorCode: "cdp_unreachable" });
  });
});

describe("脱敏红线", () => {
  it("成功路径:fixture 里的 sessionid / finderUsername 不出现在返回值里", async () => {
    const dump = JSON.stringify(await run({ routes: okRoutes() }).result);
    for (const marker of LEAK_MARKERS) expect(dump).not.toContain(marker);
  });

  it("未登录路径:errMsg 原文不出现在返回值里", async () => {
    const out = await run({ routes: { "/auth/auth_data": res(AUTH_OUT) } }).result;
    const dump = JSON.stringify(out);
    for (const marker of LEAK_MARKERS) expect(dump).not.toContain(marker);
  });

  it("页面内异常把响应片段带进 message,也漏不出去(只归类,不转录)", async () => {
    const out = await run({
      routes: {},
      evalThrows: new Error('页面内表达式抛错:{"sessionid":"FAKE_SESSIONID_DO_NOT_LEAK_77aa"}'),
    }).result;
    expect(out).toMatchObject({ status: "error", rows: [], errorCode: "exception" });
    expect(JSON.stringify(out)).not.toContain("FAKE_SESSIONID_DO_NOT_LEAK");
  });
});
