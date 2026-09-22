export interface HumanizeZhOptions {
  text: string;
}

export type HumanizeZhResult = {
  ok: boolean;
  originalText: string;
  humanizedText: string;
  /** 实际应用的安全格式改动；建议不计入，避免被下游当成必须修复的问题。 */
  changes: string[];
  changeCount: number;
  /** 仅供显式 humanize 调用参考，不自动删词、改人称或替换术语。 */
  suggestions: string[];
  summary: string;
};

const STYLE_SUGGESTIONS: Array<{ pattern: RegExp; note: string }> = [
  {
    pattern: /值得一提的是|需要注意的是|综上所述|总而言之|总的来说|可以说|毫不夸张地说/,
    note: "检查提示、总结或强调句是否带来新信息；若确实承接上下文则保留，不按词表删除。",
  },
  {
    pattern: /赋能|助力|打通|闭环|深度(?:分析|解读|剖析|洞察|融合)|全方位|多维度/,
    note: "检查抽象表达是否有具体所指；可补充实际动作或例子，专有名称、引文和专业术语保持原意。",
  },
  {
    pattern: /首先|其次/,
    note: "检查顺序词是否帮助读者理解步骤；真实操作顺序应保留，不为去模板感打乱逻辑。",
  },
];

/** 不改句内空格、缩进、标点或段落节奏，只清理首尾与行尾空白、统一换行。 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * 自动成稿与显式 humanize 共用安全边界：机器只做空白清理。
 * 风格是否生硬要结合语境判断；正则改人称、删连词、替换术语会改变事实主体或制造病句。
 */
export function humanizeZh(options: HumanizeZhOptions): HumanizeZhResult {
  const originalText = options.text || "";
  const humanizedText = normalizeWhitespace(originalText);
  const changes = humanizedText === originalText ? [] : ["规范化首尾、行尾空白与换行"];
  const suggestions = STYLE_SUGGESTIONS
    .filter(({ pattern }) => pattern.test(originalText))
    .map(({ note }) => note);
  if (originalText.split("\n").filter((line) => line.trim().startsWith("我们")).length > 2) {
    suggestions.push("若多段以“我们”开头，可按上下文调整句式；必须保留原有叙述者与事实主体，不能改成“你”。");
  }
  return {
    ok: true,
    originalText,
    humanizedText,
    changes,
    changeCount: changes.length,
    suggestions,
    summary: `humanizer-zh 完成：${changes.length ? "已规范化空白" : "原文保持不变"}；${suggestions.length ? `有 ${suggestions.length} 条可选表达建议，均未自动应用` : "未提供表达建议，不代表已通过风格或事实审稿"}`,
  };
}
