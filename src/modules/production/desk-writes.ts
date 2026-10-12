/**
 * 发布台手动工具的两个创始人写操作（spec 2026-10-12 发布台 吸收 4 / 5）：都走 founderDecision（模型调用一律拒），
 * 都显式带平台 + 轮次，只动本轮这个平台的槽。
 * - add_work_url：给槽补作品链接（服务端 isWorkUrl 校验）；不改发布状态、时间、把关来源，不复用 i_published。
 * - record_metrics：给这个平台这件作品手填一天的数据；只在这个平台不自动回流时收。
 */
import { canonPlatform, slotOf, type Slot } from "./receipts.js";
import { isWorkUrl, urlMismatch } from "./chat-approval/post-publish-view.js";
import { parsePublishUrl } from "../flywheel/publish-url.js";
import { recordOutcome } from "../flywheel/outcome-store.js";
import { readPullState } from "../flywheel/pull-state.js";
import { backflowOf } from "../flywheel/backflow.js";
import { push, staleRound, type Ctx } from "./decisions.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { planEntryFor, publicTimeOf } from "./desk-plan.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");

/** 链接里的作品 id：三平台按回流同一套解析；B站取 BV / av 号 */
export function itemIdOf(platform: string, url: string | undefined): string | null {
  if (!url) return null;
  const parsed = parsePublishUrl(url, platform);
  if (parsed) return parsed.itemId;
  if (platform !== "bilibili") return null;
  return /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/.exec(url)?.[1] ?? null;
}

/** 本轮这个平台已投出的槽；没有 / 被驳回 / 待核 = 原因 */
function liveSlot(ctx: Ctx, platform: string): Slot | string {
  const s = slotOf(ctx.doc, ctx.doc.round, platform);
  if (!s) return "这个平台本轮还没有发布记录：先标已发，再补";
  if (!s.verified) return "这个平台的发布还待核：先确认发了，再补";
  if (s.pub_state === "rejected") return "这个平台被驳回了，没有作品可补";
  return s;
}

function platformAndRound(ctx: Ctx): string | Result {
  const platform = canonPlatform(str(ctx.params.platform));
  if (!platform) return fail("platform_required", "说一下是哪个平台");
  if (ctx.params.round === undefined || ctx.params.round === null || ctx.params.round === "") return fail("round_required", "要带你看到的轮次（round），刷新后再点");
  return staleRound(ctx) ?? platform;
}

export async function addWorkUrl(ctx: Ctx): Promise<Result> {
  const platform = platformAndRound(ctx);
  if (typeof platform !== "string") return platform;
  const url = str(ctx.params.url);
  if (!url) return fail("url_required", "贴一个作品链接");
  if (!isWorkUrl(platform, url)) return fail("bad_url", (urlMismatch(platform, url) ?? `这不是一个${platform}的作品链接（要作品页，不是主页或后台）`).replace(/：问一下创始人.*$|，这次什么都没记$/, ""));
  const slot = liveSlot(ctx, platform);
  if (typeof slot === "string") return fail("no_slot", slot);
  if (slot.url === url) return { ok: true, unchanged: true };
  // 一个槽只指认一件作品（Codex 审 P1）：新链接是另一件 / 认不出是哪件，就不混
  const had = slot.item_id ?? itemIdOf(platform, slot.url);
  const next = itemIdOf(platform, url);
  if (had && next !== had) return fail("work_conflict", next ? "这个链接是另一件作品：要换作品，先在「更多」里纠正这个平台，再标已发" : "认不出这个链接是哪件作品（短链要换成作品页链接），和已记的作品对不上");
  return { ok: true, decision: await push(ctx, { type: "publish_link", platform, note: url }, "publish_link_added") };
}

const METRIC_KEYS = ["views", "likes", "comments", "shares", "favorites"] as const;

function metricsOf(raw: unknown): Record<string, number> | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "要填数据（播放 / 点赞 / 评论）";
  const out: Record<string, number> = {};
  for (const k of METRIC_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < 0) return "数据要是不小于 0 的整数";
    out[k] = n;
  }
  return out.views === undefined ? "至少要填播放数" : out;
}

function metricDateOf(raw: unknown, publicAt: string | null, now: number): string | Result {
  const d = str(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return fail("bad_date", "数据日期要是 YYYY-MM-DD");
  if (Date.parse(`${d}T00:00:00+08:00`) > now) return fail("bad_date", "数据日期不能在今天之后");
  if (publicAt && d < new Date(Date.parse(publicAt) + 8 * 3600_000).toISOString().slice(0, 10)) return fail("bad_date", "数据日期早于这件作品的发布时间");
  return d;
}

export async function recordMetrics(ctx: Ctx): Promise<Result> {
  const platform = platformAndRound(ctx);
  if (typeof platform !== "string") return platform;
  const slot = liveSlot(ctx, platform);
  if (typeof slot === "string") return fail("no_slot", slot);
  const flow = backflowOf(platform, await readPullState(ctx.dataDir).catch(() => null));
  if (flow.auto) return fail("auto_backflow", "这个平台有自动回流，数据会自己回来；回流断了先接上回流");
  const itemId = slot.item_id ?? itemIdOf(platform, slot.url);
  if (!itemId) return fail("work_unknown", "认不出是哪件作品：先在「补作品链接」里补上这个平台的作品链接");
  // 页面上看到的那件作品（Codex 审 P2-5）：弹窗开着时槽换了作品，拒，不记到替换后的那件上
  if (str(ctx.params.expected_work_id) !== itemId) return fail("stale", "这个平台的作品刚变过：刷新看一下再填");
  const metrics = metricsOf(ctx.params.metrics);
  if (typeof metrics === "string") return fail("bad_metrics", metrics);
  const record = await readPublishRecord(ctx.content.id, ctx.content.manualPublications, ctx.dataDir);
  const publicAt = publicTimeOf(slot, planEntryFor(ctx.doc, record, platform, slot));
  const date = metricDateOf(ctx.params.metric_date, publicAt, Date.now());
  if (typeof date !== "string") return date;
  const w = await recordOutcome({ contentId: ctx.content.id, platform, platformTitle: ctx.content.title, publishedAt: publicAt, metricDate: date, metrics, source: "paste", platformItemId: itemId }, ctx.dataDir);
  return w.ok ? { ok: true, replaced: w.replaced } : fail("record_failed", w.error ?? "数据没记上");
}
