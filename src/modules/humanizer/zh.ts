export interface HumanizeZhOptions {
  text: string;
}

export interface HumanizeZhResult {
  ok: boolean;
  originalText: string;
  humanizedText: string;
  changes: string[];
  changeCount: number;
  summary: string;
}

const DIRECT_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string; note: string }> = [
  { pattern: /值得一提的是/g, replacement: "", note: "删除空转折词“值得一提的是”" },
  { pattern: /需要注意的是/g, replacement: "", note: "删除空提醒词“需要注意的是”" },
  { pattern: /综上所述|总而言之|总的来说/g, replacement: "", note: "删除套路化总结句式" },
  { pattern: /可以说|毫不夸张地说/g, replacement: "", note: "删除夸张前缀，直接表达判断" },
  { pattern: /赋能/g, replacement: "帮", note: "把“赋能”改成具体动作词" },
  { pattern: /助力/g, replacement: "帮", note: "把“助力”改成具体动作词" },
  { pattern: /打通/g, replacement: "连接", note: "把“打通”改成更具体表达" },
  { pattern: /闭环/g, replacement: "跑通", note: "把“闭环”改成更口语化表达" },
  { pattern: /深度/g, replacement: "", note: "删除空泛形容词“深度”" },
  { pattern: /全方位/g, replacement: "", note: "删除空泛形容词“全方位”" },
  { pattern: /多维度/g, replacement: "", note: "删除空泛形容词“多维度”" },
];

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function replaceWithTracking(
  text: string,
  pattern: RegExp,
  replacement: string,
): { text: string; count: number } {
  let count = 0;
  const nextText = text.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return { text: nextText, count };
}

function breakLongClauses(text: string): { text: string; count: number } {
  const lines = text.split("\n");
  let count = 0;
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    const chineseLength = (trimmed.match(/[\u4e00-\u9fff]/g) || []).length;
    if (chineseLength <= 40) return line;

    // Use /g flag to apply ALL breaks in one pass (convergence guarantee)
    let replaced = line;
    replaced = replaced.replace(/，(?=[^，。！？]{10,})/g, "。");
    replaced = replaced.replace(/；(?=[^；。！？]{8,})/g, "。");
    if (replaced !== line) {
      count += 1;
      return replaced;
    }
    return line;
  });
  return { text: nextLines.join("\n"), count };
}

function simplifyProgressionPhrases(text: string): { text: string; count: number } {
  let count = 0;
  let next = text.replace(/首先[，,]?/g, () => {
    count += 1;
    return "";
  });
  next = next.replace(/其次[，,]?/g, () => {
    count += 1;
    return "";
  });
  next = next.replace(/最后[，,]?/g, () => {
    count += 1;
    return "最后，";
  });
  return { text: next, count };
}

function reduceWeOpenings(text: string): { text: string; count: number } {
  const lines = text.split("\n");
  let weCount = 0;
  for (const line of lines) {
    if (line.trim().startsWith("我们")) {
      weCount += 1;
    }
  }
  if (weCount <= 2) {
    return { text, count: 0 };
  }

  let changed = 0;
  const nextLines = lines.map((line) => {
    if (changed >= weCount - 2) return line;
    if (line.trim().startsWith("我们")) {
      changed += 1;
      return line.replace("我们", "你");
    }
    return line;
  });
  return { text: nextLines.join("\n"), count: changed };
}

// addRhythmPhraseIfNeeded removed.
// Previously inserted a hardcoded sentence ("说白了，这件事拼的不是工具数量，而是表达和执行。")
// that was unrelated to the actual content. Humanizer should only do
// substitution and deletion — never insert new content.

export function humanizeZh(options: HumanizeZhOptions): HumanizeZhResult {
  const originalText = options.text || "";
  let humanizedText = originalText;
  const changes: string[] = [];

  for (const replacement of DIRECT_REPLACEMENTS) {
    const result = replaceWithTracking(humanizedText, replacement.pattern, replacement.replacement);
    if (result.count > 0) {
      humanizedText = result.text;
      changes.push(`${replacement.note} × ${result.count}`);
    }
  }

  const progression = simplifyProgressionPhrases(humanizedText);
  if (progression.count > 0) {
    humanizedText = progression.text;
    changes.push(`打散“首先/其次/最后”顺序词 × ${progression.count}`);
  }

  const longClauses = breakLongClauses(humanizedText);
  if (longClauses.count > 0) {
    humanizedText = longClauses.text;
    changes.push(`拆开过长句子 × ${longClauses.count}`);
  }

  const weOpenings = reduceWeOpenings(humanizedText);
  if (weOpenings.count > 0) {
    humanizedText = weOpenings.text;
    changes.push(`减少“我们”开头句子 × ${weOpenings.count}`);
  }

  // No content insertion — humanizer only substitutes and deletes.

  humanizedText = normalizeWhitespace(humanizedText);
  return {
    ok: true,
    originalText,
    humanizedText,
    changes,
    changeCount: changes.length,
    summary:
      changes.length > 0
        ? `humanizer-zh 完成：修改了 ${changes.length} 类问题`
        : "humanizer-zh 完成：确认无明显 AI 痕迹",
  };
}
