/**
 * 视图上下文的服务端校验与注入行（对话控制面设计 §Phase 3「常驻与上下文」+ 一审 P2-6）。
 *
 * renderer 报告「用户正看着哪」，模型据此理解「这篇」「这个活动」这类指代。
 * 但 renderer 报的值一律当外部输入看：
 * 1. route / boardColumn 走**枚举白名单**——不在表里就丢弃，绝不原样拼进 prompt；
 * 2. contentId / campaignId 走**存在性查询**——查不到的 id 丢弃（模型别对着幽灵稿件说话）；
 * 3. 丢弃是静默的：上下文是锦上添花，缺了照常对话，不能因为一个坏字段让整轮失败。
 */
import { getContent } from "../storage/local-store.js";
import { getCampaign } from "../storage/campaign-store.js";
import { isCampaignId, isContentId } from "../storage/entity-id.js";

/** 前端 Route["view"] 的终集（frontend/src/App.tsx）——两边改动同步 */
export const VIEW_ROUTES = [
  "dashboard", "board", "editor", "calibration", "report", "library", "logs", "campaigns", "inbox", "settings",
] as const;
export type ViewRoute = (typeof VIEW_ROUTES)[number];

/** 看板列 key 的终集（frontend/src/lib.ts BOARD_COLUMNS）——两边改动同步 */
export const BOARD_COLUMNS = ["idea", "writing", "review", "ready", "published"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

const ROUTE_LABELS: Record<ViewRoute, string> = {
  dashboard: "今日工作台",
  board: "内容看板",
  editor: "稿件编辑器",
  calibration: "品牌校准",
  report: "数据回流",
  library: "素材库",
  logs: "任务日志",
  campaigns: "增长活动",
  inbox: "灵感收件箱",
  settings: "设置",
};

const COLUMN_LABELS: Record<BoardColumn, string> = {
  idea: "灵感库",
  writing: "在写",
  review: "待审",
  ready: "待发布",
  published: "已发布",
};

/** §C1 上下文感知：renderer 报告用户正看着哪（只进模型上下文，不进持久历史） */
export interface ChatViewContext {
  contentId?: string;
  contentTitle?: string;
  platform?: string;
  /** 对话式修改的焦点：选中的一段或整篇。存在时修改意见走 revise_focus。 */
  revisionFocus?: { scope: "selection" | "draft"; selection?: string };
  /** 当前视图（白名单内才留） */
  route?: ViewRoute;
  /** 看板聚焦列（白名单内、且 route=board 才留） */
  boardColumn?: BoardColumn;
  /** 选中的增长活动（存在性校验过才留） */
  campaignId?: string;
  campaignName?: string;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * 把 renderer 传来的原始 context 校验成 ChatViewContext；一个合法字段都没有时返回 undefined
 * （= 老前端不传 context 的行为）。查存在性失败（存储读不动）也按丢弃处理，不抛。
 */
export async function parseViewContext(raw: unknown, dataDir?: string): Promise<ChatViewContext | undefined> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const ctx: ChatViewContext = {};

  // 稿件：沿用既有校验（id 形状合法即收，标题/平台缺则回存储补）——本期不收紧
  const contentId = input.content_id;
  if (isContentId(contentId)) {
    const current = await getContent(contentId, dataDir).catch(() => null);
    ctx.contentId = contentId;
    ctx.contentTitle = String(input.content_title ?? current?.title ?? "");
    ctx.platform = String(input.platform ?? current?.platform ?? "");
    const rf = input.revision_focus;
    if (rf && typeof rf === "object" && !Array.isArray(rf)) {
      const scope = (rf as Record<string, unknown>).scope;
      const selection = (rf as Record<string, unknown>).selection;
      if (scope === "draft") ctx.revisionFocus = { scope: "draft" };
      else if (scope === "selection" && typeof selection === "string" && selection.trim())
        ctx.revisionFocus = { scope: "selection", selection };
    }
  }

  const route = pick(input.route, VIEW_ROUTES);
  if (route) ctx.route = route;
  // 列只在看板视图里有意义——脱离看板的 boardColumn 是没意义的坐标，丢
  const column = pick(input.board_column, BOARD_COLUMNS);
  if (column && route === "board") ctx.boardColumn = column;

  const campaignId = input.campaign_id;
  if (isCampaignId(campaignId)) {
    const campaign = await getCampaign(campaignId, dataDir).catch(() => null);
    if (campaign) {
      ctx.campaignId = campaign.id;
      ctx.campaignName = campaign.name;
    }
  }

  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/**
 * 「用户正看着哪」的一行中文（进本轮 userMessage 的上下文块）。
 * 编辑器路由 + 有稿件时不再重复一遍——稿件那句已经把位置说清了。
 */
export function viewContextLine(ctx: ChatViewContext | undefined): string {
  if (!ctx?.route) return "";
  if (ctx.route === "editor" && ctx.contentId) return "";
  const column = ctx.boardColumn ? `的「${COLUMN_LABELS[ctx.boardColumn]}」列` : "";
  const campaign = ctx.campaignId ? `，选中活动《${ctx.campaignName || ctx.campaignId}》（id: ${ctx.campaignId}）` : "";
  return `用户当前在工作区的「${ROUTE_LABELS[ctx.route]}」页面${column}${campaign}——「这里」「这一列」「这个活动」等指代默认指它。`;
}
