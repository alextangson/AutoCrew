/**
 * 本轮 chat:turn 的视图上下文组装（对话控制面设计 §Phase 3）。
 *
 * 「用户正看着哪」由壳（route/活动选中态）+ 编辑器（稿件/修改焦点）两处拼起来，
 * 组装规则值得单测：修改焦点优先于当前稿件、空上下文回 undefined（等同不传）。
 * 服务端还有一道白名单/存在性校验（chat-view-context.ts）——这里只负责如实报告。
 */
export interface ViewSnapshot {
  /** 当前路由 view（与 App.tsx Route["view"] 同名） */
  route?: string;
  /** 看板聚焦列 key（当前无产出方：看板没有"聚焦列"概念，字段留给后续） */
  boardColumn?: string;
  /** 增长面板选中的活动 */
  campaignId?: string;
}

export interface TurnContextInput {
  view?: ViewSnapshot;
  /** 编辑器打开的稿件 */
  contentId?: string;
  /** 对话式修改焦点（存在时它的 contentId 说了算） */
  focus?: { contentId: string; scope: "selection" | "draft"; selection?: { text: string } };
}

export type TurnContext = Record<string, unknown>;

export function buildTurnContext(input: TurnContextInput): TurnContext | undefined {
  const ctx: TurnContext = {};
  const focus = input.focus;
  if (focus) {
    ctx.content_id = focus.contentId;
    ctx.revision_focus = { scope: focus.scope, ...(focus.selection ? { selection: focus.selection.text } : {}) };
  } else if (input.contentId) {
    ctx.content_id = input.contentId;
  }
  const view = input.view;
  if (view?.route) ctx.route = view.route;
  if (view?.boardColumn) ctx.board_column = view.boardColumn;
  if (view?.campaignId) ctx.campaign_id = view.campaignId;
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}
