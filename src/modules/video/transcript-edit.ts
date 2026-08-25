/**
 * 手工改字的确定性部分（转写纠错 spec §6 的「兜底」）：把「这一个剪辑单元的新文字」
 * 落回它所属的清洗分句里。**零 IO、零模型**，全是纯函数，用边界用例锁死。
 *
 * 与 LLM 清洗共用同一套时间语义（`transcript-clean-align.ts` 的 `realignWords`）——
 * 机器改与人改各写一套对齐，迟早在某个边界上分叉：同一个字，字幕逐词高亮的位置因为
 * 「是谁改的」而不同，那种 bug 没人查得出来。
 *
 * 三条口径与清洗一致：
 * - **词只重排不新造**：新词的时间从被替换的那几个词的跨度里分，永不越界；
 * - **标点只进 text 不进 words**（spec §0）：字幕消费 words，人加的逗号只改善阅读；
 * - **只改目标单元**：同一个分句里的其它单元，词与文字一个字都不动。
 */
import { norm } from "./rough-cut-units.js";
import { lcsMatches, realignWords, tokenWords, tokenizeWordUnits } from "./transcript-clean-align.js";
import type { TranscriptSegment, TranscriptWord } from "./types.js";

/**
 * 单句改后的字数上限。一句口播说不到这么长，超了基本是整段粘错了框；
 * 而一句被撑到几千字会让下游的词重分把一整段静音塞满零宽词。
 */
export const MAX_MANUAL_TEXT_CHARS = 500;

/** 改后的文字合不合法：不合法回一句人话，合法回 null（判定在这里，门只负责抛） */
export function manualTextReason(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "改成空的等于把这一句删掉——不想要它就在左边取消勾选，别把文字清空";
  const chars = [...trimmed].length;
  if (chars > MAX_MANUAL_TEXT_CHARS) {
    return `改后有 ${chars} 字，超过单句上限 ${MAX_MANUAL_TEXT_CHARS} 字（一句口播不该这么长，多半是粘错了）`;
  }
  // 纯标点/纯 emoji：分词出 0 个词 → 字幕会是一片空白，且没有任何时间可分
  if (tokenizeWordUnits(trimmed).length === 0) return "改完一个字都不剩（只有标点或表情），字幕会变成空白";
  return null;
}

/** 单元在清洗分句里的落点：第 `segmentIndex` 句的词序列 `[from, to)` */
export interface UnitSpot {
  segmentIndex: number;
  from: number;
  to: number;
}

/**
 * 词的身份 = 文字 + 起止时间。单元表的词是从清洗分句里**逐字段复制**过去的
 * （`flattenWords`），所以三元组相等就是同一个词；时间戳单调不重叠，重复文字也不会认错人。
 */
const wordKey = (w: TranscriptWord): string => `${w.w}|${w.startMs}|${w.endMs}`;

/**
 * 找出这个单元占的是哪一句的哪一段词。
 *
 * 为什么按词身份搜而不是按下标累加：单元表有两种来源——AI 重分的 `unit-XXXX`（按词流切，
 * 与分句一一对应不上）与转写兜底的原样搬运（单元就是分句本身）。按身份搜对两种都成立，
 * 也顺带扛住「文字已经换过一版」——那时找不到，调用方据此人话拒绝而不是改错地方。
 *
 * 切分保证单元不跨分句（`splitEditUnits` 把分句边界也当切点），所以命中必是**某一句内部的
 * 连续子区间**；真找不到就返回 null。
 */
export function locateUnitWords(
  segments: readonly TranscriptSegment[],
  unitWords: readonly TranscriptWord[],
): UnitSpot | null {
  if (unitWords.length === 0) return null;
  const target = unitWords.map(wordKey);
  for (const [segmentIndex, seg] of segments.entries()) {
    const keys = (seg.words ?? []).map(wordKey);
    for (let from = 0; from + target.length <= keys.length; from++) {
      if (target.every((k, i) => keys[from + i] === k)) return { segmentIndex, from, to: from + target.length };
    }
  }
  return null;
}

export interface UnitEditResult {
  /** 改完的整句（其余词与文字原样） */
  segment: TranscriptSegment;
  /** 目标单元自己的新词序列——单元表要用它同号重出 */
  words: TranscriptWord[];
}

/**
 * 重拼分句 text：**只换目标单元那几个词占的字符区间**，两侧连标点原样留着
 * （同一句里另一个单元的文字与句中逗号都不受影响）。
 *
 * 词与 text 的对应靠 **LCS 而不是「第 i 个词 = 第 i 个 token」**：原样搬运的 ASR 分句里
 * text 有词表覆盖不到的字（真机上覆盖率只有 83% 的那种），逐位对应会整体错位一格，
 * 改一个字能把半句话吃掉。对不上的字一律留在区间外——宁可不动，不可吞。
 */
function spliceText(seg: TranscriptSegment, from: number, to: number, text: string): string {
  const tokens = tokenizeWordUnits(seg.text);
  // 这一句的 text 里一个字都没有（只有符号）：没有可保留的前后文，整句就是这次改的结果
  if (tokens.length === 0) return text;
  const matches = lcsMatches((seg.words ?? []).map((w) => norm(w.w)), tokens.map((t) => norm(t.w)));
  const head = matches.find((m) => m.origIndex >= from);
  const tail = [...matches].reverse().find((m) => m.origIndex >= from && m.origIndex < to);
  // 一个词都没对上（文字与词表严重脱节）→ 区间退化成零宽，只插不删：宁可多一段，不可吃掉原文
  const start = head ? tokens[head.tokenIndex].start : seg.text.length;
  const end = tail ? Math.max(start, tokens[tail.tokenIndex].end) : start;
  return `${seg.text.slice(0, start)}${text}${seg.text.slice(end)}`.trim();
}

/**
 * 把 `[from, to)` 这几个词换成人改后的文字。
 *
 * 分句的 `startMs/endMs` **一毫秒都不动**：源区间是这一段音频的事实，`buildOutputMap`
 * 按它取素材。改字只改字，改到成片时长上去就是另一回事了（spec §8 明确不做）。
 */
export function editUnitText(
  seg: TranscriptSegment,
  from: number,
  to: number,
  text: string,
): UnitEditResult {
  const words = seg.words ?? [];
  const replaced = realignWords(words.slice(from, to), tokenWords(tokenizeWordUnits(text)));
  return {
    segment: {
      ...seg,
      text: spliceText(seg, from, to, text),
      words: [...words.slice(0, from), ...replaced, ...words.slice(to)],
    },
    words: replaced,
  };
}
