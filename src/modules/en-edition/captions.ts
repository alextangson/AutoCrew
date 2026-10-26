/**
 * 英文字幕的分条（全媒体 spec §3.3「Captions」style A）：文字只取批过的英文脚本，时间取配音的字级时间戳；
 * 每条最多两行、每行不超过 42 个字符（装满再换行、句末收条），整条一起出一起收，每条最多一个标黄关键词（脚本里该段的 keyword）。
 * 产出给 `sidecars/captions/burn_captions.py` 烧进画面的 cues JSON；样式参数只在那个脚本里写一份。
 */
import type { DubManifest, WordTime } from "./dub.js";
import type { EnScript } from "./script.js";

export const LINE_MAX = 42;
export interface Cue { start: number; end: number; lines: string[] }

const SENTENCE_END = /[.?!]["'”’)\]]*$/;

/** 把 w 放进这一条：本行放得下就接上，放不下换第二行；两行都满 = false（要另起一条） */
function place<T extends { word: string }>(cue: T[][], w: T): boolean {
  const line = cue.at(-1);
  if (line && [...line, w].map((x) => x.word).join(" ").length <= LINE_MAX) { line.push(w); return true; }
  if (cue.length < 2) { cue.push([w]); return true; }
  return false;
}

/**
 * 词 → 若干条，每条 1–2 行（每行 ≤ 42）：一行装满再换行，两行满了另起一条；句末（. ? !）一定收住这一条。
 * 规则同 2026-10-26 安克首跑创始人认过的 captions-v1-retimed.json（那份手工版偶有句末并条，这里一律在句末断）；
 * 之前按「两行能否平衡」判，两行都放不下时会漏出 136 字符的一行。
 */
export function chunkLines<T extends { word: string }>(words: T[]): T[][][] {
  const out: T[][][] = [];
  let cue: T[][] = [];
  words.forEach((w) => {
    if (!place(cue, w)) { out.push(cue); cue = [[w]]; }
    if (SENTENCE_END.test(w.word)) { out.push(cue); cue = []; }
  });
  if (cue.length) out.push(cue);
  return out;
}

/** 关键词被换行拆开、且整体挪到第二行放得下：把换行提前到关键词前（keep = 关键词在这条里的词序号区间） */
export function keepKeyword(lines: string[][], keep: [number, number] | null): string[][] {
  if (lines.length !== 2 || !keep) return lines;
  const n1 = lines[0].length;
  if (!(keep[0] < n1 && keep[1] >= n1) || keep[0] === 0) return lines;
  const all = [...lines[0], ...lines[1]];
  const a = all.slice(0, keep[0]), b = all.slice(keep[0]);
  return b.join(" ").length <= LINE_MAX ? [a, b] : lines;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 关键词在这组词里的位置（整词、不分大小写，可跨多个词）；没有 = null */
export function keywordSpan(words: string[], keyword: string | undefined): [number, number] | null {
  const kw = keyword?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!kw.length) return null;
  const re = kw.map((k, j) => new RegExp(`${j === 0 ? "^[^A-Za-z0-9]*" : "^"}${escapeRe(k)}${j === kw.length - 1 ? "(?![A-Za-z0-9])" : "$"}`, "i"));
  for (let i = 0; i + kw.length <= words.length; i++) {
    if (re.every((r, j) => r.test(words[i + j]))) return [i, i + kw.length - 1];
  }
  return null;
}

/** 把关键词包成 [..]（整词匹配、只标第一次出现）；跨行时两行各包一半，算同一个关键词 */
function markKeyword(lines: string[], span: [number, number] | null): string[] {
  if (!span) return lines;
  const perLine = lines.map((l) => l.split(" "));
  let at = 0;
  return perLine.map((ws) => {
    const from = at; at += ws.length;
    const a = Math.max(span[0], from) - from, b = Math.min(span[1], at - 1) - from;
    if (a > b) return ws.join(" ");
    const out = [...ws];
    const lead = out[a].match(/^[^A-Za-z0-9]*/)![0];
    out[a] = `${lead}[${out[a].slice(lead.length)}`;
    const m = out[b].match(/^(.*?[A-Za-z0-9])([^A-Za-z0-9]*)$/);
    out[b] = m ? `${m[1]}]${m[2]}` : `${out[b]}]`;
    return out.join(" ");
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
    const long = words.find((w) => w.word.length > LINE_MAX);
    if (long) return { ok: false, error: `第 ${line.index} 段有一个词「${long.word}」超过 ${LINE_MAX} 个字符，一行字幕放不下：把这段改短（比如网址改成口头说法）重交脚本、重新批准，不在字幕里截断批过的文字` };
    let keywordLeft = seg.keyword;
    for (const group of chunkLines(words)) {
      const flat = group.flat();
      const span = keywordSpan(flat.map((w) => w.word), keywordLeft);
      if (span) keywordLeft = undefined;
      const lines = keepKeyword(group.map((l) => l.map((w) => w.word)), span).map((l) => l.join(" "));
      cues.push({ start: flat[0].startS, end: flat.at(-1)!.endS, lines: markKeyword(lines, span) });
    }
  }
  return { ok: true, cues };
}
