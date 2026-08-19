/**
 * 本轮上下文组装（对话控制面设计 §Phase 3）。
 * 组装规则的两条硬约束：修改焦点的稿件优先于「当前打开的稿件」；空上下文回 undefined。
 */
import { describe, it, expect } from "vitest";
import { buildTurnContext } from "./view-context";

describe("buildTurnContext", () => {
  it("什么都没有 → undefined（等同老前端不传 context）", () => {
    expect(buildTurnContext({})).toBeUndefined();
    expect(buildTurnContext({ view: {} })).toBeUndefined();
  });

  it("只有路由：带 route 上报", () => {
    expect(buildTurnContext({ view: { route: "board" } })).toEqual({ route: "board" });
  });

  it("增长面板选中活动一起上报", () => {
    expect(buildTurnContext({ view: { route: "campaigns", campaignId: "campaign-7" } })).toEqual({
      route: "campaigns",
      campaign_id: "campaign-7",
    });
  });

  it("编辑器：稿件 + 路由", () => {
    expect(buildTurnContext({ view: { route: "editor" }, contentId: "content-1" })).toEqual({
      route: "editor",
      content_id: "content-1",
    });
  });

  it("修改焦点优先：焦点的稿件盖过当前打开的稿件，并带上选区原文", () => {
    const ctx = buildTurnContext({
      view: { route: "editor" },
      contentId: "content-1",
      focus: { contentId: "content-2", scope: "selection", selection: { text: "开头这段" } },
    });
    expect(ctx).toEqual({
      route: "editor",
      content_id: "content-2",
      revision_focus: { scope: "selection", selection: "开头这段" },
    });
  });

  it("整篇焦点不带 selection 字段", () => {
    const ctx = buildTurnContext({ focus: { contentId: "content-1", scope: "draft" } });
    expect(ctx).toEqual({ content_id: "content-1", revision_focus: { scope: "draft" } });
  });

  it("看板列有值才带（当前无产出方，字段存在即透传）", () => {
    expect(buildTurnContext({ view: { route: "board", boardColumn: "review" } })).toEqual({
      route: "board",
      board_column: "review",
    });
    expect(buildTurnContext({ view: { route: "board", boardColumn: "" } })).toEqual({ route: "board" });
  });
});
