/**
 * 实拍版口播：从成片字幕（SRT）还原实际说出口的话，并找出定稿里没有的新数字、新出处。
 * 纯函数，不碰盘；登记（register.ts）与「我的内容」视图共用。
 */

export const SPOKEN_DIFF_NOTE = "实拍口播与定稿的差异";
/** 两条字幕间隔 ≥ 1.5 秒视为换段 */
const PARAGRAPH_GAP_MS = 1500;
const TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

export interface SrtCue { startMs: number; endMs: number; text: string }

function toMs(stamp: string): number | null {
  const m = TIME_RE.exec(stamp.trim());
  if (!m) return null;
  const [, h, mi, s, ms] = m;
  if (Number(mi) > 59 || Number(s) > 59) return null;
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(ms.padEnd(3, "0"));
}

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
/** 中文之间直接拼，西文之间补空格 */
function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return CJK.test(a.slice(-1)) || CJK.test(b[0]) ? a + b : `${a} ${b}`;
}

/** 解析 SRT；格式不对抛人话错误（登记据此拒收，不静默跳过） */
export function parseSrt(raw: string): SrtCue[] {
  const blocks = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const cues: SrtCue[] = [];
  for (const [i, block] of blocks.entries()) {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const [times, ...textLines] = lines;
    const parts = (times ?? "").split("-->");
    const start = parts.length === 2 ? toMs(parts[0]) : null;
    const end = parts.length === 2 ? toMs(parts[1].trim().split(/\s+/)[0]) : null;
    if (start === null || end === null) throw new Error(`第 ${i + 1} 条字幕的时间轴不是「00:00:01,000 --> 00:00:02,000」格式：${times ?? "（空）"}`);
    if (end < start) throw new Error(`第 ${i + 1} 条字幕结束早于开始：${times}`);
    const text = textLines.map((l) => l.replace(/<[^>]+>/g, "").trim()).filter(Boolean).reduce(joinText, "");
    if (text) cues.push({ startMs: start, endMs: end, text });
  }
  if (!cues.length) throw new Error("字幕文件里没有任何带文字的字幕条");
  return cues;
}

/** 字幕 → 实拍口播正文：去序号和时间轴，拼句，停顿 ≥ 1.5 秒换段 */
export function spokenFromSrt(raw: string): string {
  const cues = parseSrt(raw);
  const paragraphs: string[] = [];
  let current = "", lastEnd = -Infinity;
  for (const cue of cues) {
    if (current && cue.startMs - lastEnd >= PARAGRAPH_GAP_MS) { paragraphs.push(current); current = ""; }
    current = joinText(current, cue.text);
    lastEnd = cue.endMs;
  }
  if (current) paragraphs.push(current);
  return `${paragraphs.join("\n\n")}\n`;
}

const NUMBER_RE = /\d+(?:[.,]\d+)*\s*(?:%|％|万|亿)?|百分之[零一二三四五六七八九十百千两点]+|[零一二三四五六七八九十百千两]+(?:万|亿)/g;
const ATTRIBUTION_RE = /据|报告|说/;
const CLAUSE_SPLIT = /[，。！？；、,.!?;\n]+/;
const squash = (s: string) => s.replace(/\s+/g, "");

function numbersIn(text: string): Set<string> {
  return new Set((text.match(NUMBER_RE) ?? []).map(squash));
}

/** 实拍版里新出现、定稿里没有的数字与出处说法（只提示，不拦发布） */
export function unverifiedAdditions(finalScript: string, spoken: string): string[] {
  const known = numbersIn(finalScript), finalFlat = squash(finalScript);
  const out: string[] = [], seen = new Set<string>();
  for (const clause of spoken.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean)) {
    for (const n of numbersIn(clause)) {
      if (known.has(n) || seen.has(`n:${n}`)) continue;
      seen.add(`n:${n}`);
      out.push(`数字「${n}」：${clause}`);
    }
    if (ATTRIBUTION_RE.test(clause) && !finalFlat.includes(squash(clause)) && !seen.has(`a:${clause}`)) {
      seen.add(`a:${clause}`);
      out.push(`出处「${clause}」`);
    }
  }
  return out;
}

export function renderCheckList(items: string[]): string {
  return `实拍时新说的数字和出处，还没核验，发布前看一眼（只是提醒，不挡发布）：\n\n${items.map((i) => `- ${i}`).join("\n")}\n`;
}
