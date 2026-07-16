export interface HumanizeZhOptions {
  text: string;
}

export type HumanizeZhResult = {
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
  // 只删套话组合，不裸删“深度”——否则“深度学习/深度智联”这类术语被静默肢解
  { pattern: /深度(?=分析|解读|剖析|洞察|融合)/g, replacement: "", note: "删除空泛形容词“深度”" },
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

// 2026-07-08 dogfood 裁撤记录（真实成稿受损的证据在 SESSION-9 交接）:
// - breakLongClauses（逗号→句号硬切长句）:正则不懂语法,切出「创业者找我的时候。十有八九」
//   这类病句,一篇稿三处;短句节奏由 pack 与风格规则在生成时约束,后处理只会帮倒忙。
// - addRhythmPhraseIfNeeded（缺“说白了”就插一句固定话）:给所有文章盖同一个指纹,
//   且插入的内容与选题无关——与 humanizer 的目标（自然口吻）背道而驰。

function simplifyProgressionPhrases(text: string): { text: string; count: number } {
  // 只把「首先/其次」当模板列表痕迹删除。孤立的叙事「最后」不是列表(「每次浪潮,最后赚钱的
  // 都不是淘金者」),不能计数——旧实现把「最后，」替换成「最后，」(no-op 却 +1),导致检测
  // 永远报 1 处、auto_fix 永远修不掉,发布门禁成死循环;对「最后一个」还会错插逗号。
  let count = 0;
  let next = text.replace(/首先[，,]?/g, () => {
    count += 1;
    return "";
  });
  next = next.replace(/其次[，,]?/g, () => {
    count += 1;
    return "";
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

  const weOpenings = reduceWeOpenings(humanizedText);
  if (weOpenings.count > 0) {
    humanizedText = weOpenings.text;
    changes.push(`减少“我们”开头句子 × ${weOpenings.count}`);
  }

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
