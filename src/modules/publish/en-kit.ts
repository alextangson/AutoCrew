/**
 * 英文发布包（YouTube / X，全媒体 spec §3.1 第 5 条、Phase 3）：按 PLATFORM_CAPS 的 kitFields 和上限校验，
 * 字数按字符计（不做中文半字折算），不收中文字。中文四平台的发布包校验一行不动（pre-publish.ts validateKit）。
 *
 * - youtube: post_title ≤100、caption（描述）、tags、chapters（第一个 0:00、≥3 章、每章 ≥10 秒、在片长之内）、16:9 缩略图；
 *   存下来的 caption = 描述 + 章节行 + 标签（就是粘进 YouTube Studio 的那一份），≤5000。
 * - x: post_text ≤280（发布标题 = 帖子正文，X 视频帖没有独立标题），标签并进正文后再数。
 */
import { PLATFORM_CAPS, type PlatformId } from "./platform-caps.js";
import { mergeTags } from "./publish-limits.js";
import { maybeJson } from "./review-gate/plan.js";
import { parseArrayArg } from "../video/tool-args.js";
import type { DubManifest } from "../en-edition/dub.js";
import type { EnScript } from "../en-edition/script.js";

/** 英文版默认发布时段：北京时间 21:00–23:00（美国上午），spec §4 */
export const EN_PUBLISH_WINDOW = { timezone: "Asia/Shanghai", from: "21:00", to: "23:00", note: "北京时间 21:00–23:00（美国上午），不跟中文时段" };

export interface Chapter { at: string; startS: number; title: string }
export interface EnKitFields { postTitle: string; caption: string; tags?: string[]; chapters?: Chapter[] }
export interface EnKitContext { thumbnailProblem: string | null; durationS: number | null }
type Failure = { field: string; detail: string };

const CJK = /[一-鿿]/;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** "1:05" / "01:02:03" / 65 → 秒；认不出 = null */
export function parseTimestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(typeof v === "string" ? v : "");
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function readChapters(raw: unknown, failures: Failure[]): Chapter[] {
  const list = parseArrayArg(raw, "chapters", "用 op:\"chapters\" 拿段起点，挑 3 个以上写成 [{at:\"0:00\", title}]");
  if (typeof list === "string") { failures.push({ field: "chapters", detail: list }); return []; }
  const out: Chapter[] = [];
  for (const x of list) {
    const o = (typeof x === "string" ? { at: x.split(/\s+/)[0], title: x.split(/\s+/).slice(1).join(" ") } : x) as Record<string, unknown> | null;
    const startS = parseTimestamp(o?.at ?? o?.start_s);
    const title = typeof o?.title === "string" ? o.title.trim() : "";
    if (startS === null || !title) { failures.push({ field: "chapters", detail: "每章要 {at:\"m:ss\", title}" }); return []; }
    out.push({ at: fmt(startS), startS, title });
  }
  return out;
}

/** YouTube 章节规则：第一个 0:00、至少 3 章、递增、每章 ≥10 秒、都在片长之内 */
export function chapterProblems(ch: Chapter[], durationS: number | null): string[] {
  const out: string[] = [];
  if (durationS === null) out.push("片长未知（审过的英文成片读不出时长，或还没有配音清单）：章节核不了，看一下英文成片文件能不能播，或先 en_edition dub");
  if (ch.length < 3) out.push(`YouTube 章节至少 3 个（收到 ${ch.length} 个）`);
  if (ch.length && ch[0].startS !== 0) out.push("第一个章节必须从 0:00 开始");
  ch.forEach((c, i) => {
    const next = ch[i + 1]?.startS ?? durationS;
    if (next !== null && next !== undefined && next - c.startS < 10) out.push(`章节「${c.title}」不到 10 秒（YouTube 要求每章 ≥10 秒）`);
    if (CJK.test(c.title)) out.push(`章节「${c.title}」带中文`);
  });
  if (durationS !== null && ch.some((c) => c.startS >= durationS)) out.push(`有章节起点超过片长 ${fmt(durationS)}`);
  return out;
}

function readTags(raw: unknown, field: string, failures: Failure[]): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const list = parseArrayArg(raw, field, "不要标签就不写");
  if (typeof list === "string") { failures.push({ field, detail: list }); return []; }
  const tags = [...new Set(list.filter((t): t is string => typeof t === "string").map((t) => t.trim().replace(/^#+/, "")).filter(Boolean))];
  if (tags.some((t) => CJK.test(t))) failures.push({ field, detail: "英文平台的标签不能有中文" });
  return tags;
}

function limit(platform: PlatformId, field: string, text: string, max: number | undefined, failures: Failure[], what: string): void {
  if (!text) failures.push({ field, detail: `缺${what}` });
  else if (CJK.test(text)) failures.push({ field, detail: `${what}里有中文：英文平台只发英文` });
  else if (max !== undefined && [...text].length > max) failures.push({ field, detail: `${[...text].length} 字符，超出 ${platform} 上限 ${max}（按字符计）：压缩后重交` });
}

function youtubeKit(obj: Record<string, unknown>, ctx: EnKitContext, failures: Failure[]): EnKitFields {
  const caps = PLATFORM_CAPS.youtube;
  const text = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string).trim() : "");
  limit("youtube", "post_title", text("post_title"), caps.titleMax, failures, "标题");
  const tags = readTags(obj.tags, "tags", failures);
  if (!tags.length) failures.push({ field: "tags", detail: "YouTube 要 tags（英文关键词，3–15 个）" });
  else if (tags.join(",").length > 500) failures.push({ field: "tags", detail: "YouTube tags 合计不能超过 500 字符" });
  const chapters = readChapters(obj.chapters, failures);
  for (const p of chapterProblems(chapters, ctx.durationS)) failures.push({ field: "chapters", detail: p });
  const description = text("caption") || text("description");
  const block = chapters.map((c) => `${c.at} ${c.title}`).join("\n");
  const caption = description ? mergeTags(`${description}\n\n${block}`.trim(), readTags(obj.hashtags, "hashtags", failures)) : "";
  limit("youtube", "caption", caption, caps.bodyMax, failures, "描述");
  if (ctx.thumbnailProblem) failures.push({ field: "thumbnail", detail: ctx.thumbnailProblem });
  return { postTitle: text("post_title"), caption, tags, chapters };
}

function xKit(obj: Record<string, unknown>, failures: Failure[]): EnKitFields {
  const raw = typeof obj.post_text === "string" ? obj.post_text.trim() : "";
  const post = raw ? mergeTags(raw, readTags(obj.hashtags, "hashtags", failures)) : "";
  limit("x", "post_text", post, PLATFORM_CAPS.x.bodyMax, failures, "帖子正文");
  return { postTitle: post, caption: post };
}

/** 按平台的 kitFields 校验；返回逐字段失败和要存的字段 */
export function validateEnKit(raw: unknown, platform: PlatformId, ctx: EnKitContext): { failures: Failure[]; fields: EnKitFields } {
  const parsed = maybeJson(raw);
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const failures: Failure[] = [];
  const fields = platform === "youtube" ? youtubeKit(obj, ctx, failures) : xKit(obj, failures);
  return { failures, fields };
}

/** 章节候选：每段配音的起点 + 英文开头几个词（宿主据此挑章节、写标题） */
export function chaptersFromManifest(m: DubManifest, script: EnScript): Array<{ segment: number; at: string; start_s: number; en_head: string }> {
  return m.lines.map((l, i) => {
    const en = script.segments.find((s) => s.index === l.index)?.en ?? "";
    const start = i === 0 ? 0 : l.startS;
    return { segment: l.index, at: fmt(start), start_s: start, en_head: en.split(/\s+/).slice(0, 8).join(" ") };
  });
}
