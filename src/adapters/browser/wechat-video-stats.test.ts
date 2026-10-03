/**
 * wechat-video-stats.test.ts — 视频号旁听:解析层吃 fixture(字段形状按 2026-10-03 实测 post_list),
 * 翻页判定 inspect 真跑;端到端判定在 passive-pull.test.ts。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  WECHAT_VIDEO_INSPECT_SRC,
  WECHAT_VIDEO_PAGE,
  WECHAT_VIDEO_PLATFORM,
  mapPostRow,
  parsePostList,
  pickTitle,
  pullWechatVideoStats,
} from "./wechat-video-stats.js";

const fixture = (rel: string): string => readFileSync(new URL(`./__fixtures__/${rel}`, import.meta.url), "utf8");
const POST_LIST = fixture("wechat-video/post-list.json");
const POST_LIST_DRIFT = fixture("wechat-video/post-list-drift.json");
const LIVE_URL = "https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/post/post_list?_aid=x&_rid=y";
/** 官方页面自己收到的 post_list 恒是 HTTP 201(2026-10-03 实测) */
const res = (body: string, status = 201) => ({ url: LIVE_URL, status, body });
type Inspect = (rs: Array<{ url: string; body: string }>) => { oldestMs: number | null; hasMore: boolean | null };
const inspect = (0, eval)(`(${WECHAT_VIDEO_INSPECT_SRC})`) as Inspect;

describe("parsePostList(fixture 锚定)", () => {
  it("字段映射:readCount→views / forwardCount→shares / favCount→favorites / followCount→follows", () => {
    const parsed = parsePostList(res(POST_LIST));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
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


describe("旁听配置(2026-10-03 实测)", () => {
  it("旁听带 /micro/content 前缀的真实路径;翻页点「下一页」;登录页 URL 特征", () => {
    expect(WECHAT_VIDEO_PLATFORM.url).toBe(WECHAT_VIDEO_PAGE);
    expect(WECHAT_VIDEO_PLATFORM.patterns.every((p) => LIVE_URL.includes(p))).toBe(true);
    expect(WECHAT_VIDEO_PLATFORM.next).toEqual({ kind: "click", css: "a,button,span", texts: ["下一页"] });
    expect(new RegExp(WECHAT_VIDEO_PLATFORM.gates.loginUrl!, "i").test("https://channels.weixin.qq.com/login.html")).toBe(true);
    expect(new RegExp(WECHAT_VIDEO_PLATFORM.gates.loginUrl!, "i").test(WECHAT_VIDEO_PAGE)).toBe(false);
  });

  it("HTTP 201 是正常(不再误判失败);401 → needs_login", () => {
    expect(parsePostList(res(POST_LIST, 201)).kind).toBe("ok");
    expect(parsePostList(res(POST_LIST, 401))).toMatchObject({ kind: "stop", result: { status: "needs_login" } });
  });

  it("inspect:continueFlag 决定还翻不翻,createTime 秒 → 毫秒", () => {
    const body = JSON.stringify({ errCode: 0, data: { list: [{ createTime: 1783600000 }, { createTime: 1783000000 }], continueFlag: true } });
    expect(inspect([res(body)])).toEqual({ oldestMs: 1783000000_000, hasMore: true });
    expect(inspect([res(JSON.stringify({ errCode: 0, data: { list: [], continueFlag: false } }))])).toEqual({ oldestMs: null, hasMore: false });
  });
});

describe("pullWechatVideoStats 经假会话", () => {
  it("一页 201 响应 → ok,行带作品 id 与指标", async () => {
    const now = () => new Date(1783600000_000 + 86_400_000);
    const session = { browse: async () => ({ pages: [{ index: 0, responses: [res(POST_LIST)] }], end: "no_more" as const, gate: null }) };
    const r = await pullWechatVideoStats({ now, session });
    expect(r.status).toBe("ok");
    expect(r.rows[0]).toMatchObject({ platformItemId: "1441234567890123456", metrics: { views: 20431 } });
  });
});
