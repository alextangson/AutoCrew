/**
 * 发布台「各平台」表的一行（spec 2026-10-12 发布台 §3 / 吸收 2、3、6、9、10、11）。纯函数，读盘在 publish-desk.ts。
 * 状态取回执槽推导（targets.ts），时间按平台分开给，数据按本轮回执槽认出的这件作品取，文案以服务端为准。
 */
import type { Content } from "../../storage/local-store.js";
import type { PlatformPublication } from "../../storage/publish-record.js";
import type { Work } from "../flywheel/data-rows.js";
import { latest } from "../flywheel/data-rows.js";
import { compareViews, comparisonText, type Baseline } from "../flywheel/compare.js";
import type { Backflow } from "../flywheel/backflow.js";
import { platformLabel } from "../publish/review-gate/platforms.js";
import { captionTags } from "../publish/publish-limits.js";
import { videoKitFor } from "../../storage/video-kits.js";
import { staleKit } from "../../tools/pre-publish-kit.js";
import type { PublishTarget, TargetAction } from "./targets.js";
import type { ObsFact, Slot } from "./receipts.js";
import { publicTimeOf, workIdOf } from "./desk-plan.js";

const HOUR = 3600_000, DAY = 24 * HOUR;
export type RowAction = { kind: TargetAction; label: string; fact_id?: string };
export type MoreAction = "correct_publish" | "add_work_url" | "record_metrics" | "i_published";
export type RowData =
  | { kind: "metrics"; warning?: string; views: number; likes: number | null; comments: number | null; metric_date: string; first_at: string; compare: { text: string; tone: string } }
  | { kind: "note"; text: string; why: "not_public" | "fresh" | "mismatch" | "no_identity" | "unmatched" | Backflow["kind"] };
export type RowCopy =
  | { kind: "ready"; source: "实发" | "拟发"; title: string; caption: string; tags: string[] }
  | { kind: "missing" | "stale"; text: string };
export interface DeskRow {
  platform: string; label: string; state: PublishTarget["state"]; status: string; tone: string; reason: string | null; url: string | null;
  slot_id: string | null; campaigns: string[]; work_id: string | null;
  times: { scheduled_at: string | null; submitted_at: string | null; observed_at: string | null; public_at: string | null };
  when: string | null; data: RowData; copy: RowCopy; action: RowAction | null; more: MoreAction[]; backflow: { kind: Backflow["kind"]; auto: boolean; text: string };
}
export interface RowInput {
  content: Content; target: PublishTarget; slot: Slot | null; entry: PlatformPublication | undefined; overdue: ObsFact | null;
  works: Work[]; baselines: Map<string, Baseline>; backflow: Backflow; now: number;
}

const md = (iso: string) => { const d = new Date(Date.parse(iso) + 8 * HOUR); return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const TONE: Record<string, string> = { 已公开: "done", 已定时: "wait", 审核中: "wait", 应已公开: "wait", 未发: "todo", 被驳回: "bad", 待核: "unknown", 读不到: "unknown" };
const LIVE = new Set(["已定时", "审核中", "已公开", "应已公开"]);

function timesOf(i: RowInput): DeskRow["times"] {
  const e = i.entry, s = i.slot;
  const scheduled = e?.scheduledAt ?? (s?.pub_state === "scheduled" ? s.published_at ?? null : null);
  // 实际公开时间只认明写的（publicTimeOf）；回流按 id / 你标的已发布不知道真实公开时刻
  const publicAt = i.target.state === "已公开" ? publicTimeOf(s, e) : null;
  return { scheduled_at: scheduled ?? null, submitted_at: e?.submittedAt ?? null, observed_at: s?.seen_at ?? null, public_at: publicAt };
}

/** 状态文字：应已公开一律「应已公开 · 还没核到」（吸收 6）；按标题认的是待核（吸收 2） */
function statusOf(i: RowInput, t: DeskRow["times"]): { state: PublishTarget["state"]; text: string } {
  const st = i.target.state;
  const due = t.scheduled_at && Date.parse(t.scheduled_at) <= i.now;
  if (st === "应已公开" || (st === "已定时" && due)) return { state: "应已公开", text: "应已公开 · 还没核到" };
  if (st === "已定时") return { state: st, text: `定时 ${md(t.scheduled_at!)}${i.entry?.review === "reviewing" || i.entry?.state === "reviewing" ? " · 审核中" : ""}` };
  if (st === "审核中") return { state: st, text: t.scheduled_at ? `定时 ${md(t.scheduled_at)} · 审核中` : "审核中" };
  if (st === "已公开") return { state: st, text: i.target.url ? "已公开" : "已公开（没有作品链接）" };
  if (st === "被驳回") return { state: st, text: `被驳回${i.target.reason ? `：${i.target.reason}` : ""}` };
  if (st === "待核") return { state: st, text: `待核：${i.slot?.evidence ?? "AI 说发了，还没核到"}` };
  if (st === "读不到") return { state: st, text: "发布计划里这个平台读不懂" };
  return { state: st, text: "未发" };
}

function whenOf(state: string, t: DeskRow["times"], now: number): string | null {
  if (state === "已定时" && t.scheduled_at) {
    const ms = Date.parse(t.scheduled_at) - now;
    return ms >= DAY ? `还有 ${Math.floor(ms / DAY)} 天公开` : `还有 ${Math.max(1, Math.ceil(ms / HOUR))} 小时公开`;
  }
  if (state !== "已公开") return null;
  if (!t.public_at) return "不知道实际公开时间";
  return `公开第 ${Math.floor((now - Date.parse(t.public_at)) / DAY) + 1} 天`;
}

/** 本轮这件作品：回执槽的作品 id / 链接解析出的 id；回流里同平台同 id 的作品（吸收 3） */
function dataOf(i: RowInput, state: string, t: DeskRow["times"]): RowData {
  if (state !== "已公开") return { kind: "note", why: "not_public", text: "公开后回流" };
  const id = i.slot ? workIdOf(i.slot) : null;
  const ids = new Set(id ? [id] : []);
  const works = ids.size ? i.works.filter((w) => w.platform === i.target.platform && w.platformItemId && ids.has(w.platformItemId)) : [];
  if (works.length > 1) return { kind: "note", why: "mismatch", text: `数据对不上是哪一条（对上了 ${works.length} 件作品）` };
  if (works.length === 1) {
    const snap = latest(works[0]);
    const views = snap.metrics.views;
    if (typeof views === "number") {
      const first = works[0].snapshots[0];
      // 回流断了照样给旧数字，但写清截至哪天 + 怎么接上（Codex 审 P2-6）
      const broken = i.backflow.kind !== "ok" && i.backflow.kind !== "unsupported" ? { warning: i.backflow.text } : {};
      return { kind: "metrics", ...broken, views, likes: snap.metrics.likes ?? null, comments: snap.metrics.comments ?? null, metric_date: snap.metricDate, first_at: first.recordedAt ?? first.metricDate,
        compare: comparisonText(compareViews(views, i.baselines.get(i.target.platform)), platformLabel(i.target.platform)) };
    }
  }
  if (!ids.size && i.backflow.kind !== "unsupported") return { kind: "note", why: "no_identity", text: "没有作品链接，认不出是哪一条：在「更多」里补链接" };
  if (i.backflow.kind !== "ok") return { kind: "note", why: i.backflow.kind, text: i.backflow.text };
  const age = t.public_at ? i.now - Date.parse(t.public_at) : null;
  if (age !== null && age < DAY) return { kind: "note", why: "fresh", text: `公开 ${Math.max(1, Math.floor(age / HOUR))} 小时，数据还没回来` };
  return { kind: "note", why: "unmatched", text: "回流抓到了数据，但没对上这件作品" };
}

const stripTags = (caption: string) => caption.replace(/#[^\s#]+/g, "").replace(/[ \t]+\n/g, "\n").trim();

/** 已投出的显示实发（计划里的），未发的显示拟发（发布包）；发布包没备 / 过期不显示旧文案（边界 2 / 吸收 11） */
function copyOf(i: RowInput, state: string): RowCopy {
  const e = i.entry;
  if ((LIVE.has(state) || state === "被驳回") && e?.submitted && (e.title || e.caption)) {
    return { kind: "ready", source: "实发", title: e.title ?? i.content.title, caption: stripTags(e.caption ?? ""), tags: e.tags?.length ? e.tags : captionTags(e.caption ?? "") };
  }
  const kit = videoKitFor(i.content, i.target.platform);
  if (!kit?.caption?.trim()) return { kind: "missing", text: "发布包还没备" };
  const stale = staleKit(i.content, i.target.platform);
  if (stale) return { kind: "stale", text: `发布包已过期：${stale.error}` };
  return { kind: "ready", source: "拟发", title: kit.postTitle?.trim() || i.content.title, caption: stripTags(kit.caption), tags: captionTags(kit.caption) };
}

/** 每行最多一个显眼的动作；应已公开只有 24h 追问成立时才给「确认发了」（带 fact_id） */
function actionOf(i: RowInput, state: string): RowAction | null {
  const a = i.target.actions;
  if (state === "未发" && a.includes("prepare_publish")) return { kind: "prepare_publish", label: "让 Codex 发" };
  if (state === "被驳回" && a.includes("resubmit")) return { kind: "resubmit", label: "重新提交" };
  if (state === "待核" && a.includes("confirm_receipt") && i.target.fact_id) return { kind: "confirm_receipt", label: "确认发了", fact_id: i.target.fact_id };
  if (state === "应已公开" && i.overdue) return { kind: "confirm_receipt", label: "确认发了", fact_id: i.overdue.id };
  return null;
}

function moreOf(i: RowInput, state: string): MoreAction[] {
  const out: MoreAction[] = [];
  if (state === "未发" && i.target.actions.includes("i_published")) out.push("i_published");
  if (LIVE.has(state) && i.slot?.verified) out.push("add_work_url");
  if (state === "已公开" && i.slot?.verified && !i.backflow.auto) out.push("record_metrics");
  if (i.target.actions.includes("correct_publish")) out.push("correct_publish");
  return out;
}

export function deskRow(i: RowInput): DeskRow {
  const t = timesOf(i);
  const { state, text } = statusOf(i, t);
  return {
    platform: i.target.platform, label: platformLabel(i.target.platform), state, status: text, tone: TONE[state] ?? "unknown",
    reason: i.target.reason ?? null, url: i.target.url ?? null, slot_id: i.target.slot_id ?? null, campaigns: i.entry?.campaigns ?? [],
    work_id: i.slot ? workIdOf(i.slot) : null,
    times: t, when: whenOf(state, t, i.now), data: dataOf(i, state, t), copy: copyOf(i, state), action: actionOf(i, state), more: moreOf(i, state),
    backflow: { kind: i.backflow.kind, auto: i.backflow.auto, text: i.backflow.text },
  };
}
