/**
 * 英文字幕的分条（全媒体 spec §3.3「Captions」style A）：文字只取批过的英文脚本，时间取配音的字级时间戳；
 * 每条最多两行、每行不超过 42 个字符，整条一起出一起收，每条最多一个标黄关键词（脚本里该段的 keyword）。
 * 产出给 `sidecars/captions/burn_captions.py` 烧进画面的 cues JSON；样式参数只在那个脚本里写一份。
 */
import type { DubManifest } from "./dub.js";
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

export function buildCues(manifest: DubManifest, script: EnScript): CueResult {
  const cues: Cue[] = [];
  for (const line of manifest.lines) {
    if (!line.words.length) return { ok: false, error: `第 ${line.index} 段配音没有字级时间戳：重新配这一段（ElevenLabs with-timestamps）再出字幕` };
    const seg = script.segments.find((s) => s.index === line.index);
    let keywordLeft = seg?.keyword;
    for (const group of chunkWords(line.words)) {
      const lines = wrap(group.map((w) => w.word));
      const marked = markKeyword(lines, keywordLeft);
      if (marked.join("\n") !== lines.join("\n")) keywordLeft = undefined;
      cues.push({ start: group[0].startS, end: group.at(-1)!.endS, lines: marked });
    }
  }
  return { ok: true, cues };
}
