/**
 * 「发之前再看一眼」在对话里定（spec 2026-10-06 proactive-chat-review，Addendum 2）。
 * brief：计划条目原样（标题、简介、话题、封面字、定时带时区）、成片绝对路径、检查结果按 通过 / 没查实 / 被拦 分组，被拦的依据原文照录。
 */
import path from "node:path";
import { checkView } from "../../publish/review-gate/check.js";
import { platformLabel } from "../../publish/review-gate/platforms.js";
import type { CheckItem } from "../../publish/review-gate/types.js";
import type { InboxItem } from "../inbox.js";
import type { PreviewFile } from "./preview.js";

export const NO_TAGS = "没写话题";
export const NO_SCHEDULE = "没定时（审核过了就发）";
/** info（比如 B站「16:9 裁切核对」要人手核）不算通过：归「没查实」，依据原文照录 */
const PASSED = new Set(["pass", "override"]);
const BLOCKED = new Set(["block"]);

const quoted = (v: string | null | undefined, empty: string) => (v?.trim() ? `「${v}」` : empty);
const name = (i: CheckItem) => i.check || i.rule || i.field || "检查项";

/** 检查结果分组：通过 / 没查实（没查、没跑成、提醒）/ 被拦（依据原文） */
export function groupedResults(items: CheckItem[]): string[] {
  const passed = items.filter((i) => PASSED.has(i.result));
  const blocked = items.filter((i) => BLOCKED.has(i.result));
  const rest = items.filter((i) => !PASSED.has(i.result) && !BLOCKED.has(i.result));
  return [
    `通过（${passed.length}）：${passed.map(name).join("、") || "无"}`,
    `没查实（${rest.length}）：${rest.map((i) => `${name(i)}${i.basis ? `——${i.basis}` : ""}`).join("；") || "无"}`,
    `被拦（${blocked.length}）：${blocked.map((i) => `${name(i)}——${i.basis}`).join("；") || "无"}`,
  ];
}

const replyLine = (blocked: boolean) => (blocked ? "被拦了，「没问题」用不了：要破例就说你的原话（会原样记下），或回我「还要改：……」" : "回我「没问题」/「还要改：……」");

/** 计划条目读不出来（比如计划里已经没有这个平台）：照样给留档的检查结果、拦的原因和能做的决定 */
function missingEntryBrief(item: InboxItem, head: string, blocked: boolean): string {
  return [
    head,
    "计划条目读不出来了（计划里可能已经没有这个平台），下面是这次检查留档的结果：",
    ...groupedResults((item.detail.items as CheckItem[]) ?? []),
    ...(item.blocked_reason ? [`注意：${item.blocked_reason}`] : []),
    replyLine(blocked),
  ].join("\n");
}

export async function publishView(item: InboxItem, dataDir: string): Promise<{ brief: string; files: PreviewFile[] }> {
  const d = item.detail;
  const who = platformLabel(String(d.platform));
  const view = await checkView(item.content_id!, String(d.check_id), dataDir);
  const blocked = d.verdict === "block";
  const head = `《${item.title}》发之前再看一眼（${who}）`;
  if (!view) return { brief: missingEntryBrief(item, head, blocked), files: [] };
  const e = view.entry;
  const lines = [
    head,
    `标题：${quoted(e.title, "没写标题")}`,
    `简介：${quoted(e.caption, "没写简介")}`,
    `话题：${e.tags.length ? e.tags.join(" ") : NO_TAGS}`,
    `封面字：${quoted(e.cover_text, "没写封面字")}`,
    `定时：${e.scheduled_at ? `${e.scheduled_at}（${e.timezone ?? "没写时区"}）` : NO_SCHEDULE}`,
    `成片：${view.video_path ?? "计划里没写成片"}`,
    `封面：${view.covers.map((c) => `${c.usage} ${c.ratio} ${path.basename(c.path)}`).join("、") || "没有"}`,
    "检查结果：",
    ...groupedResults((d.items as CheckItem[]) ?? []),
    ...(item.blocked_reason && !blocked ? [`注意：${item.blocked_reason}`] : []),
    replyLine(blocked),
  ];
  const files = view.covers.map((c, i) => ({ source: c.path, name: `${who}-封面${i + 1}-${path.basename(c.path)}`, video: false }));
  return { brief: lines.join("\n"), files };
}
