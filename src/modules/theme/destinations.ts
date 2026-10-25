/**
 * 去向回执适配（首页与管线重规划 §8-3）：每个去向的状态只从它自己的回执推。纯函数。
 *
 * - 中文视频平台：父视频稿本轮的发布槽 / 发布计划（`publishTargets` 已按本体规则算好）。
 * - 公众号：派生文章自己的 article-publish.json（`ArticlePublishState`），从不喂给父视频的 D1。
 * - YouTube / X：英文版自己的发布槽（同样是 `publishTargets`，只是挂在英文版那条稿上）。
 *
 * 状态六种：没开始 / 在做 / 待你定 / 已定时 / 已发 / 没发成（被驳回、结果不明、过点没发）。
 */
import type { PublishTarget, TargetState } from "../production/targets.js";
import type { ArticlePublishState } from "../wechat-article/publish-state.js";

/** 所有能当去向的平台，按卡上显示的顺序 */
export const DESTINATIONS = ["douyin", "wechat_video", "xiaohongshu", "bilibili", "wechat_mp", "youtube", "x"] as const;
export type Destination = (typeof DESTINATIONS)[number];
export const ZH_VIDEO: ReadonlySet<string> = new Set(["douyin", "wechat_video", "xiaohongshu", "bilibili"]);
export const EN_VIDEO: ReadonlySet<string> = new Set(["youtube", "x"]);
export const isDestination = (p: string): p is Destination => (DESTINATIONS as readonly string[]).includes(p);

export const DEST_LABEL: Record<Destination, string> = {
  douyin: "抖音", wechat_video: "视频号", xiaohongshu: "小红书", bilibili: "B站", wechat_mp: "公众号", youtube: "YouTube", x: "X",
};

export type DestState = "没开始" | "在做" | "待你定" | "已定时" | "已发" | "没发成";

export interface DestRow {
  platform: Destination;
  state: DestState;
  /** 一句人话：「待你核对」「被驳回：封面违规」「等新成片」 */
  detail: string;
  /** 右侧小字：时间（MM-DD）等 */
  at?: string;
  /** 承载这个去向的稿：父视频 / 公众号文章 / 英文版；计划里有、稿还没派生 = null */
  content_id: string | null;
  /** 同一去向有两条稿时的区分（「公众号 · 第 2 篇」） */
  tag?: string;
  /** 计划里要发（不出的、计划外的为 false） */
  required: boolean;
  /** 被标了「不出」：谁定的、原话 */
  skipped?: { by: string; founder_words: string; at: string };
  /** 派生去向暂停（重拍 / 源成片换了）：显示「等新成片」 */
  paused?: boolean;
  /** 已发但不在计划里（取消勾选 / 标不出之前发的）：历史照样保留 */
  history?: boolean;
  /** 父视频的平台动作（前端带平台 + 轮次调现有命令） */
  actions?: PublishTarget["actions"];
  slot_id?: string;
  fact_id?: string;
  url?: string;
}

const mmdd = (iso: string | undefined | null): string | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t + 8 * 3600_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

/** 稿还没到能发的时候（写稿 / 录制 / 剪辑）的「没发」怎么说 */
export interface PreReady { ready: boolean; reason: string; waitingFounder: boolean }

const TARGET_STATE: Record<Exclude<TargetState, "未发">, { state: DestState; detail: (t: PublishTarget) => string }> = {
  已公开: { state: "已发", detail: () => "已发" },
  已定时: { state: "已定时", detail: () => "已定时" },
  审核中: { state: "已定时", detail: () => "审核中" },
  应已公开: { state: "没发成", detail: () => "过点了，还没核到公开" },
  被驳回: { state: "没发成", detail: (t) => `被驳回${t.reason ? `：${t.reason}` : ""}` },
  读不到: { state: "没发成", detail: () => "结果不明，先去后台核对" },
  待核: { state: "待你定", detail: () => "待你核对" },
};

/** 视频稿的一个平台槽 → 去向状态。父视频和英文版共用 */
export function fromTarget(t: PublishTarget, pre: PreReady, contentId: string): Omit<DestRow, "platform" | "required"> {
  const base = { content_id: contentId, actions: t.actions, ...(t.slot_id ? { slot_id: t.slot_id } : {}), ...(t.fact_id ? { fact_id: t.fact_id } : {}), ...(t.url ? { url: t.url } : {}) };
  if (t.state !== "未发") {
    const m = TARGET_STATE[t.state];
    return { ...base, state: m.state, detail: m.detail(t) };
  }
  if (pre.ready) return { ...base, state: "待你定", detail: "可以发了" };
  return { ...base, state: pre.waitingFounder ? "待你定" : "没开始", detail: pre.reason };
}

/** 公众号文章的发布状态 → 去向状态（只读它自己的 article-publish.json） */
export function fromArticle(s: ArticlePublishState, pre: PreReady, contentId: string, now = new Date()): Omit<DestRow, "platform" | "required"> {
  const base = { content_id: contentId };
  const r = s.receipt;
  if (s.phase === "published" && r?.published) return { ...base, state: "已发", detail: "已发表", at: mmdd(r.scheduledAt) };
  if (s.phase === "scheduled" && r) {
    return Date.parse(r.scheduledAt) <= now.getTime()
      ? { ...base, state: "没发成", detail: "定时过了，还没核到已发表", at: mmdd(r.scheduledAt) }
      : { ...base, state: "已定时", detail: "已定时", at: mmdd(r.scheduledAt) };
  }
  if (s.phase === "scheduled_waiting_scan") return { ...base, state: "待你定", detail: "等你扫码" };
  if (s.phase === "failed") return { ...base, state: "没发成", detail: "推送失败，可以重推" };
  if (s.phase === "unknown") return { ...base, state: "没发成", detail: "结果不明，先去后台核对" };
  if (s.phase === "waiting_video_live") return { ...base, state: "在做", detail: "等视频号原片公开" };
  if (s.phase === "pushed_draft" || s.phase === "editor_finishing") return { ...base, state: "在做", detail: "在编辑器里排版" };
  if (pre.ready) return { ...base, state: "待你定", detail: "可以推送了" };
  return { ...base, state: pre.waitingFounder ? "待你定" : "在做", detail: pre.reason };
}

/** 去向计划里有、但稿还没有（公众号 / 英文版还没派生）的那一行 */
export function notStarted(platform: Destination): Omit<DestRow, "required"> {
  return { platform, state: "没开始", detail: EN_VIDEO.has(platform) ? "英文版还没做" : platform === "wechat_mp" ? "公众号文章还没做" : "还没发", content_id: null };
}

export const SENT: ReadonlySet<DestState> = new Set(["已发", "已定时"]);
export const HOT: ReadonlySet<DestState> = new Set(["待你定", "没发成"]);
export { mmdd };
