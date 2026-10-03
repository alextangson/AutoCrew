/**
 * 口播稿的确定性提示（审稿规则补强 spec §三）：代码扫长句与书面语，交给审稿人当 advisory 参考，
 * 和数字硬门放行的 needsHumanNumbers 一样——只提醒，从不打回。
 *
 * 计数口径只数汉字：引号里的引文、英文、代码、数字串天然不计入。
 * 没有句末标点的超长段落整段算一次，不按逗号拆成一串去刷屏。
 */

export const LONG_SENTENCE_HAN_CHARS = 30;
const MAX_LONG_HINTS = 8;
const SNIPPET_CHARS = 24;

export const WRITTEN_STYLE_WORDS = [
  "鉴于", "基于以上", "综上所述", "针对", "由此可见", "予以", "旨在", "业已", "诸如此类",
];

const QUOTED = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"|《[^》]*》/g;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const SENTENCE_END = /[。！？!?；;…]+/;
const HAN = /\p{Script=Han}/gu;

export interface SpokenHints {
  /** 超长句的开头片段（供审稿人定位，不是 quote） */
  longSentences: string[];
  writtenWords: string[];
}

function stripExcluded(text: string): string {
  return text.replace(CODE, " ").replace(QUOTED, " ");
}

function hanCount(text: string): number {
  return text.match(HAN)?.length ?? 0;
}

function snippet(text: string): string {
  const t = text.trim();
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
}

/** 一段里的超长句；整段没有句末标点时整段算一次 */
function longInParagraph(paragraph: string): string[] {
  const plain = stripExcluded(paragraph);
  if (!SENTENCE_END.test(plain)) {
    return hanCount(plain) > LONG_SENTENCE_HAN_CHARS ? [snippet(paragraph)] : [];
  }
  // 用原文切句做片段，用剥过引文的那句计数——两边按同一套句末标点切，序号对得上
  const raw = paragraph.split(SENTENCE_END);
  const cleaned = plain.split(SENTENCE_END);
  if (raw.length !== cleaned.length) {
    // 引文里带句末标点会让两边错位：退回只用剥过的文本
    return cleaned.filter((s) => hanCount(s) > LONG_SENTENCE_HAN_CHARS).map(snippet);
  }
  return raw.filter((_, i) => hanCount(cleaned[i] ?? "") > LONG_SENTENCE_HAN_CHARS).map(snippet);
}

export function findSpokenHints(text: string): SpokenHints {
  const body = text.replace(CODE, (m) => m.replace(/\n/g, " "));
  const longSentences = body
    .split(/\n+/)
    .filter((p) => p.trim())
    .flatMap(longInParagraph)
    .slice(0, MAX_LONG_HINTS);
  const plain = stripExcluded(body);
  const writtenWords = WRITTEN_STYLE_WORDS.filter((w) => plain.includes(w));
  return { longSentences, writtenWords };
}

/** 进审稿 user message 的提示块；什么都没扫到就整块不出现 */
export function spokenHintsBlock(text: string): string[] {
  const { longSentences, writtenWords } = findSpokenHints(text);
  if (longSentences.length === 0 && writtenWords.length === 0) return [];
  return [
    "【确定性提示（代码扫的，只作 advisory 参考，不得据此给 blocker）】",
    ...(longSentences.length > 0
      ? [`超过 ${LONG_SENTENCE_HAN_CHARS} 个汉字的长句（开头片段）：`, ...longSentences.map((s) => `- ${s}`)]
      : []),
    ...(writtenWords.length > 0 ? [`书面语：${writtenWords.join("、")}`] : []),
    "",
  ];
}
