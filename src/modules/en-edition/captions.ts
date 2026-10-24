/**
 * 英文字幕的分条（全媒体 spec §3.3「Captions」style A）：文字只取批过的英文脚本，时间取配音的字级时间戳；
 * 每条最多两行、每行不超过 42 个字符，整条一起出一起收，每条最多一个标黄关键词（脚本里该段的 keyword）。
 * 产出给 `sidecars/captions/burn_captions.py` 烧进画面的 cues JSON；样式参数只在那个脚本里写一份。
 */
import type { DubManifest, WordTime } from "./dub.js";
import type { EnScript } from "./script.js";

export const LINE_MAX = 42;
export interface Cue { start: number; end: number; lines: string[] }

/** 词数组按 ≤ 2 行 × 42 字符切成若干条；句末标点（. ? ! :）后尽量断 */
export function chunkWords<T extends { word: string }>(words: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  const fits = (list: T[]) => wrap(list.map((w) => w.word)).length <= 2;
  for (const w of words) {
    if (cur.length && !fits([...cur, w])) { out.push(cur); cur = []; }
    cur.push(w);
    if (/[.?!:]$/.test(w.word) && cur.map((x) => x.word).join(" ").length >= LINE_MAX / 2) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 词 → 行（贪心，每行 ≤ 42）；两行时尽量平衡 */
export function wrap(words: string[]): string[] {
  const text = words.join(" ");
  if (text.length <= LINE_MAX) return [text];
  let best: string[] | null = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    if (a.length > LINE_MAX || b.length > LINE_MAX) continue;
    if (!best || Math.abs(a.length - b.length) < Math.abs(best[0].length - best[1].length)) best = [a, b];
  }
  return best ?? [text.slice(0, LINE_MAX), text.slice(LINE_MAX)].concat(text.length > LINE_MAX * 2 ? ["…"] : []);
}

/** 把关键词包成 [..]（只标第一次出现，每条最多一个） */
function markKeyword(lines: string[], keyword: string | undefined): string[] {
  if (!keyword) return lines;
  let done = false;
  return lines.map((l) => {
    if (done || !l.includes(keyword)) return l;
    done = true;
    return l.replace(keyword, `[${keyword}]`);
  });
}

export type CueResult = { ok: true; cues: Cue[] } | { ok: false; error: string };

/** 至少这么多词要对上，才认这份时间戳是这段批过的文字念出来的 */
export const MIN_WORD_MATCH = 0.9;
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * 文字只取批过的脚本，时间戳只借来卡时间：批过的词和时间戳的词逐个对，词数要相等、≥90% 对得上；
 * 对不上就失败（不拿服务商念出来的字顶替批过的文字）。
 */
export function alignApproved(approved: string, timed: WordTime[]): WordTime[] | string {
  const words = approved.split(/\s+/).filter(Boolean);
  if (words.length !== timed.length) return `批过的英文有 ${words.length} 个词，配音时间戳有 ${timed.length} 个`;
  const same = words.filter((w, i) => norm(w) === norm(timed[i].word)).length;
  if (same / words.length < MIN_WORD_MATCH) return `批过的英文和配音时间戳只有 ${same}/${words.length} 个词对得上`;
  return words.map((w, i) => ({ word: w, startS: timed[i].startS, endS: timed[i].endS }));
}

export function buildCues(manifest: DubManifest, script: EnScript): CueResult {
  const cues: Cue[] = [];
  for (const line of manifest.lines) {
    const seg = script.segments.find((s) => s.index === line.index);
    if (!seg) return { ok: false, error: `配音清单第 ${line.index} 段在批过的脚本里找不到：重新配音` };
    const words = alignApproved(seg.en, line.words);
    if (typeof words === "string") return { ok: false, error: `第 ${line.index} 段字幕对不上：${words}。重新配这一段再出字幕` };
    let keywordLeft = seg.keyword;
    for (const group of chunkWords(words)) {
      const lines = wrap(group.map((w) => w.word));
      const marked = markKeyword(lines, keywordLeft);
      if (marked.join("\n") !== lines.join("\n")) keywordLeft = undefined;
      cues.push({ start: group[0].startS, end: group.at(-1)!.endS, lines: marked });
    }
  }
  return { ok: true, cues };
}
