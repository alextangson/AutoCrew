/**
 * 定时群发排期（spec §4）：默认 = 视频号原片发出后几个小时、当天晚上；当天的群发通知额度已被别的文章占了就顺延到第二天同一时间。
 * 编辑器的定时只能选今天到 +6 天、精确到分钟（spec §7a）。时间一律按北京时间（+08:00，无夏令时）算。
 * 视频号时间读不到（只知道已公开、不知道几点）时不猜：要宿主带创始人原话给 slot。
 */
import { getContent, listContents } from "../../storage/local-store.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { readPublishState, type PlannedSlot } from "./publish-state.js";

const TZ_MS = 8 * 3600_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const SLOT_DELAY_HOURS = 3;
const LATEST_MINUTE = 22 * 60 + 30;
const DEFAULT_EVENING_MINUTE = 20 * 60;

/** 北京时间的日期 YYYY-MM-DD */
export const localDate = (t: number) => new Date(t + TZ_MS).toISOString().slice(0, 10);
const localMinute = (t: number) => { const d = new Date(t + TZ_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const atLocal = (date: string, minute: number) => Date.parse(`${date}T00:00:00+08:00`) + minute * 60_000;

/** 北京时间的 ISO（带 +08:00，精确到分钟） */
export function isoLocal(t: number): string {
  return `${new Date(Math.floor(t / 60_000) * 60_000 + TZ_MS).toISOString().slice(0, 16)}:00+08:00`;
}

/** 时间字符串 → 毫秒。不带时区的一律按北京时间解释（Codex 审 2b P2-11），不随本机时区漂；读不出 = null */
export function parseShanghai(raw: string | null | undefined): number | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00+08:00` : `${v.replace(" ", "T")}+08:00`;
  const t = Date.parse(withZone);
  return Number.isFinite(t) ? t : null;
}

export interface VideoLive { live: boolean; at: number | null; raw: string }

/** 源视频在视频号上的状态：已公开（或创始人手动标了发了）才算 live；时间取实际公开时间，没有就取定时 / 手动标记时间 */
export async function videoChannelState(sourceId: string, dataDir: string, now = Date.now()): Promise<VideoLive> {
  const src = await getContent(sourceId, dataDir);
  if (!src) return { live: false, at: null, raw: "源视频不存在" };
  const record = await readPublishRecord(sourceId, src.manualPublications, dataDir, now);
  if (record.kind === "none") return { live: false, at: null, raw: "源视频还没有发布记录（06-publish/publish-plan.json）" };
  const p = record.platforms.find((x) => x.platform === "wechat_video");
  if (!p) return { live: false, at: null, raw: record.kind === "unreadable" ? record.reason : "发布记录里没有视频号" };
  const t = p.publishedAt ?? p.time;
  const at = parseShanghai(t);
  if (p.state === "public" || p.state === "manual") return { live: true, at, raw: `视频号：${p.state}${t ? ` ${t}` : ""}` };
  // 发布台计划停在 overdue / scheduled，但制作记录里已认可了视频号发布回执（老视频常见：发完只在资料库登记）→ 按已公开算
  const fact = await acceptedChannelsPublish(sourceId, dataDir);
  if (fact) return { live: true, at: parseShanghai(fact) ?? at, raw: `视频号：已登记发布 ${fact}（发布台计划是 ${p.state}）` };
  return { live: false, at, raw: `视频号：${p.state}${t ? ` ${t}` : ""}` };
}

async function acceptedChannelsPublish(sourceId: string, dataDir: string): Promise<string | null> {
  const doc = await readProductionDocOrEmpty(sourceId, dataDir);
  const f = doc.facts.find((x) => x.kind === "publish" && x.platform === "wechat_video" && x.state === "accepted" && !x.replaced_at && x.published_at);
  return f?.published_at ?? null;
}

/** 别的派生文章已占的群发日（已进编辑器排了时间 / 等扫码 / 已定时 / 已发） */
export async function occupiedDays(selfId: string, dataDir: string): Promise<Set<string>> {
  const days = new Set<string>();
  for (const c of await listContents(dataDir)) {
    if (c.id === selfId || c.derivedFrom?.kind !== "wechat_article") continue;
    const s = await readPublishState(c.id, dataDir);
    // 结果不明的也占着那天，直到核对清楚（Codex 审 2b P2-10）
    const holds = s.phase === "editor_finishing" || s.phase === "scheduled_waiting_scan" || s.phase === "unknown";
    const t = parseShanghai(s.receipt?.scheduledAt ?? (holds ? s.slot?.at : undefined));
    if (t !== null) days.add(localDate(t));
  }
  return days;
}

/**
 * 视频号时间之后 3 小时；那个时间过了当天 22:30（Codex 审 2b P2-12），就排第二天的默认晚间 20:00 并说明；
 * 已过去就挪到最近一个还来得及的同一时刻；占了就顺延；超出 +6 天就拒
 */
export function planSlot(videoAt: number, now: number, occupied: Set<string>): PlannedSlot | { error: string } {
  let t = videoAt + SLOT_DELAY_HOURS * HOUR;
  const notes = [`视频号 ${isoLocal(videoAt)} 发出，默认晚 ${SLOT_DELAY_HOURS} 小时`];
  if (localDate(t) !== localDate(videoAt) || localMinute(t) > LATEST_MINUTE) {
    t = atLocal(localDate(videoAt + DAY), DEFAULT_EVENING_MINUTE);
    notes.push(`晚 ${SLOT_DELAY_HOURS} 小时会过当天 22:30，改排第二天晚上 20:00`);
  } else notes.push("当天晚上");
  if (t < now + 15 * 60_000) {
    while (t < now + 15 * 60_000) t += DAY;
    notes.push("那个时间已经过了，挪到最近一天的同一时刻");
  }
  while (occupied.has(localDate(t))) {
    notes.push(`${localDate(t)} 已有别的文章用掉群发通知，顺延一天`);
    t += DAY;
  }
  const check = windowError(t, now);
  return check ? { error: check } : { at: isoLocal(t), basis: notes.join("；") };
}

/** 编辑器定时窗口：今天到 +6 天（按北京日期），且至少 5 分钟以后 */
export function windowError(t: number, now: number): string | null {
  if (t < now + 5 * 60_000) return `定时 ${isoLocal(t)} 已经过了或太近（至少 5 分钟后）`;
  const last = localDate(now + 6 * DAY);
  if (localDate(t) > last) return `定时 ${isoLocal(t)} 超出公众号编辑器的定时范围（最晚 ${last}）：请创始人给一个范围内的时间`;
  return null;
}

/** 宿主带创始人原话给的时间：要带时区、精确到分钟、在窗口内、当天群发额度没被占 */
export function hostSlot(raw: string, founderWords: string, now: number, occupied: Set<string>): PlannedSlot | { error: string } {
  const t = parseShanghai(raw);
  if (t === null) return { error: `slot 要是时间，如 2026-10-25T21:00:00+08:00（不带时区按北京时间；收到 ${raw || "空"}）` };
  if (t % 60_000 !== 0) return { error: "编辑器的定时精确到分钟：slot 的秒要是 0" };
  const w = windowError(t, now);
  if (w) return { error: w };
  if (occupied.has(localDate(t))) return { error: `${localDate(t)} 已有别的文章用掉当天的群发通知：换一天` };
  return { at: isoLocal(t), basis: "创始人给的时间", founderWords };
}
