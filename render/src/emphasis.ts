/**
 * 强调词匹配（横屏 spec §2.7）。
 *
 * 修的是精确字符串匹配的两个死角：
 * 1. **大小写/标点**：转写里是「FDE，」，强调词写的是「fde」，`===` 判定永远不亮。
 * 2. **跨词短语**：ASR 把「工程师」切成「工」「程」「师」三个词，任何单词都对不上整条短语。
 *    所以匹配单位不是「一个词」而是「从某个词开始的连续词序列」。
 *
 * 归一化只做小写化 + 去标点/空白：不做同义词、不做模糊匹配——猜错了亮错词比不亮更糟，
 * 而「归一化后仍无匹配 → 不亮」是设计里写死的合法结果（边界 #14）。
 */
import type { CaptionWord } from './manifest';

/** 去掉标点、空白与各类分隔符；Unicode 属性类保证中英文标点一视同仁。 */
export function normalizeEmphasis(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, '');
}

/** 一条短语最多跨几个词——不设上限的话，一个长短语会把半屏字都点亮。 */
const MAX_PHRASE_WORDS = 8;

/**
 * 逐词判定是否命中强调词，返回与 words 等长的布尔数组。
 * 命中一条短语就把它覆盖的每个词都标上；重叠的短语取并集。
 */
export function markEmphasis(
  words: readonly CaptionWord[],
  emphasisWords: readonly string[],
): boolean[] {
  const marks = words.map(() => false);
  const phrases = [...new Set(emphasisWords.map(normalizeEmphasis))].filter((p) => p.length > 0);
  if (phrases.length === 0) return marks;

  const normalized = words.map((w) => normalizeEmphasis(w.w));
  for (let start = 0; start < normalized.length; start++) {
    if (normalized[start]!.length === 0) continue;
    let joined = '';
    for (let end = start; end < normalized.length && end - start < MAX_PHRASE_WORDS; end++) {
      joined += normalized[end]!;
      // 没有任何短语以当前拼接串为前缀时提前收手——再往后拼只会更长，不可能命中
      if (!phrases.some((p) => p.startsWith(joined))) break;
      if (phrases.includes(joined)) {
        for (let i = start; i <= end; i++) marks[i] = true;
        break;
      }
    }
  }
  return marks;
}
