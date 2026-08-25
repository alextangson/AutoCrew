/**
 * 中文标题按词断行（看板卡片用）。
 *
 * 为什么不用 CSS `word-break: auto-phrase`：Chromium 的分词断行至今只认日文，
 * 中文下整条声明被静默忽略（2026-08 真机验证过一轮，灵感库标题纹丝不动）。
 * 所以断点自己造：`Intl.Segmenter` 中文词典切词（浏览器内置，零依赖），词间插
 * 零宽空格（U+200B）当断行机会，配合 CSS `word-break: keep-all` 禁掉字中间的
 * 断行——「拦截」「迁移」从此不会被劈成两行。
 *
 * ICU 词典漏收的技术词（运维/重构/模态…）用 LEXICON 合并兜底：切词后相邻段
 * 拼起来命中词表就重新粘住。词表只收这个产品标题里反复出现的圈内词，别当
 * 通用分词器养。
 */

/** ICU 不认识、但我们标题里天天见的词。只收确定的整词，最长 4 段 */
const LEXICON = new Set([
  "运维", "重构", "模态", "多模态", "工程师", "智能体", "大模型",
  "开源", "闭环", "护城河", "流片", "评审", "灵感库", "工作流", "上线",
]);
const LEXICON_MAX_PARTS = 4;

const ZWSP = "​";
const CJK_RE = /[⺀-鿿㐀-䶿豈-﫿]/;
// 行首禁排（点号/收尾括号引号/百分号）与行尾禁排（起始括号引号）：
// ZWSP 是无条件断行机会，插错位置会让逗号顶到行首，比劈词更难看。
// ASCII 直引号开闭同形分不出方向，一律并入行首禁排——宁可少一个断点，
// 不赌「"，」这种闭引号组合顶到行首（真机截图抓到过）
const NO_BREAK_BEFORE = /^[，。、：；！？…％%”』」》〉）)\]}－—"']/;
const NO_BREAK_AFTER = /[“『「《〈（(\[{]$/;

function segment(text: string): string[] {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return [text];
  const seg = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return [...seg.segment(text)].map((s) => s.segment);
}

/** 相邻段拼起来命中词表 → 粘回一段（贪心取最长） */
function mergeLexicon(parts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; ) {
    let take = 1;
    let joined = parts[i]!;
    for (let n = 2; n <= LEXICON_MAX_PARTS && i + n <= parts.length; n++) {
      const candidate = parts.slice(i, i + n).join("");
      if (LEXICON.has(candidate)) {
        take = n;
        joined = candidate;
      }
    }
    out.push(joined);
    i += take;
  }
  return out;
}

/** 标题 → 带零宽空格断点的标题。剥掉所有 U+200B 后与原文逐字相等（不改内容只加断点） */
export function phraseBreak(text: string): string {
  const parts = mergeLexicon(segment(text));
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1]!;
    const cur = parts[i]!;
    const wantBreak =
      (CJK_RE.test(prev) || CJK_RE.test(cur)) && // 纯拉丁/数字交界（如 5.4 与 %）不新增断点
      !NO_BREAK_BEFORE.test(cur) &&
      !NO_BREAK_AFTER.test(prev);
    out += wantBreak ? ZWSP + cur : cur;
  }
  return out;
}
