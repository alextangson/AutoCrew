/**
 * 发布计划里某平台那一条能不能算「本轮这件作品」的元数据（Codex 审 P2-2 / P2-3 / P2-4）：
 * 计划按平台存、不分轮次，重开后它还是上一轮的。只有提交时间晚于最近一次重开（第 1 轮不限），
 * 且两边都有作品 id / 链接时对得上，才拿它的时间、活动、实发文案；否则当没有计划元数据。
 */
import type { PlatformPublication, PublishRecord } from "../../storage/publish-record.js";
import type { ProductionDoc } from "../../storage/production-types.js";
import { canonPlatform, type Slot } from "./receipts.js";
import { itemIdOf } from "./desk-writes.js";

export function planEntryFor(doc: ProductionDoc, record: PublishRecord, platform: string, slot: Slot | null): PlatformPublication | undefined {
  const e = record.kind === "none" ? undefined : record.platforms.find((p) => canonPlatform(p.platform) === platform);
  if (!e) return undefined;
  if (doc.round > 1) {
    const reopen = Math.max(...doc.decisions.filter((d) => d.type === "reopen").map((d) => Date.parse(d.at)), -Infinity);
    if (!e.submittedAt || !(Date.parse(e.submittedAt) > reopen)) return undefined;
  }
  const mine = slot ? workIdOf(slot) : null;
  const theirs = e.postId ?? itemIdOf(platform, e.url ?? undefined);
  if (mine && theirs && mine !== theirs) return undefined;
  return e;
}

/** 这个槽指认的作品：作品 id，否则链接解析出的 id */
export const workIdOf = (s: Slot): string | null => s.item_id ?? itemIdOf(s.platform, s.url);

/** 明写的实际公开时间：计划里的 published_at，或 AI 回执里报公开时带的时间；你标的 / 回流按 id 的不知道 */
export function publicTimeOf(slot: Slot | null, entry: PlatformPublication | undefined): string | null {
  if (!slot || slot.pub_state !== "public") return null;
  if (entry?.publishedAt) return entry.publishedAt;
  return slot.source === "claim" && slot.published_at ? slot.published_at : null;
}
