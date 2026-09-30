import { describe, expect, it } from "vitest";
import { parseRouteHash, routeHash, routeUrl, type Route } from "./routes";

describe("主题工作台深链", () => {
  it.each(["t-topic-1", "c-solo-1", "t-主题 A/版本?一#二&三"])("主题 %s 刷新后保持同一分组", (key) => {
    const route: Route = { view: "topic", key };
    expect(parseRouteHash(routeHash(route))).toEqual(route);
  });

  it.each(["#/topic", "#/topic/", "#/topic/%20", "#/topic/%E0%A4", "#/topic/a/b"])("无效主题深链 %s 回到看板", (hash) => {
    expect(parseRouteHash(hash)).toEqual({ view: "board" });
  });

  it("主题链接与启动查询参数兼容，不把稿件面板当主题身份", () => {
    expect(routeUrl({ view: "topic", key: "t-topic-1" }, { pathname: "/v2", search: "?token=test-boot" }))
      .toBe("/v2?token=test-boot#/topic/t-topic-1");
    expect(parseRouteHash("#/topic/t-topic-1?panel=images")).toEqual({ view: "topic", key: "t-topic-1" });
  });
});

describe("刷新保留稿件与编辑面板", () => {
  it.each([undefined, "images", "cover", "video"] as const)("恢复同一稿件及 %s 面板", (panel) => {
    const route: Route = { view: "editor", id: "content-1788837797307-e43ckp", ...(panel ? { panel } : {}) };
    expect(parseRouteHash(routeHash(route))).toEqual(route);
  });

  it("稿件标识含中文、空格、斜杠或问号时仍按一个 id 读取", () => {
    const route: Route = { view: "editor", id: "稿件 A/版本?一#二&三" };
    expect(parseRouteHash(routeHash(route))).toEqual(route);
  });

  it.each(["#/editor", "#/editor/", "#/editor/%20", "#/editor/%E0%A4", "#/editor/a/b", "#/unknown"])("坏链接 %s 回看板而非发空稿请求", (hash) => {
    expect(parseRouteHash(hash)).toEqual({ view: "board" });
  });

  it("忽略无效的面板参数，仍打开指定稿件", () => {
    expect(parseRouteHash("#/editor/content-1?panel=bad&extra=anything")).toEqual({ view: "editor", id: "content-1" });
  });
});

describe("页面导航兼容", () => {
  it.each(["", "#", "#/", "#/dashboard"])("根路径与旧今日页书签 %s 都进看板", (hash) => {
    expect(parseRouteHash(hash)).toEqual({ view: "board" });
  });

  it.each(["board", "calibration", "report", "library", "logs", "campaigns", "inbox"] as const)("前后退可还原 %s", (view) => {
    expect(parseRouteHash(routeHash({ view }))).toEqual({ view });
  });

  it.each(["models", "integrations", "data"] as const)("还原设置标签 %s", (tab) => {
    expect(parseRouteHash(routeHash({ view: "settings", tab }))).toEqual({ view: "settings", tab });
  });

  it("无效设置标签退回设置默认页", () => {
    expect(parseRouteHash("#/settings?tab=unknown")).toEqual({ view: "settings" });
  });

  it("保留旧 /v2 入口和查询参数，稿件位置只写 hash", () => {
    expect(routeUrl({ view: "editor", id: "content-1" }, { pathname: "/v2", search: "?token=test-boot" }))
      .toBe("/v2?token=test-boot#/editor/content-1");
  });
});

describe("看板深链到卡片（1b 验收）", () => {
  it("#/board?card=… 打开那张卡，能来回转换", () => {
    expect(parseRouteHash("#/board?card=content-1-a")).toEqual({ view: "board", card: "content-1-a" });
    expect(routeHash({ view: "board", card: "content-1-a" })).toBe("#/board?card=content-1-a");
    expect(routeHash({ view: "board" })).toBe("#/board");
  });
});
