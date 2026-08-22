/**
 * LLM 工具入参的形态归一（两条真实链路教训，粗剪与剪辑师共用一份）。
 *
 * 1. **中转层会把数组序列化成 JSON 字符串**（`code.newcli.com/claude/ultra`）。
 *    字符串不是错误，是这条链路的常态，必须无声吃掉——旧实现 `Array.isArray(x) ? x : []`
 *    把模型找出的四十来处剔除静默当成「无需剔除」，跑完一无所获还报告成功。
 * 2. **串里常带未转义的半角引号**（中文写作习惯，爱用引号强调词句）。这也不该让模型背——
 *    它再交一遍还是这样，打回只会把三轮自纠瞬间烧完。
 *
 * 只有**真的解析不出数组**才打回，且错误信息要说清是解析问题、不是类型问题。
 */

/** 索引以字符串数字到达时照收（上游序列化口径不一），转不动就是转不动，打回不猜 */
export function asIndex(v: unknown): number | null {
  if (Number.isInteger(v)) return v as number;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * 修掉模型在 JSON 字符串值里写的**未转义 `"`**。
 * 实测原样：`"note": "口误，应为"所以今天想"，但话未说完就改口重来"` —— JSON.parse 当场炸。
 *
 * 判定：串内遇到 `"`，只有当它后面（跳过空白）紧跟 `,` `}` `]` `:` 时才是真正的收尾引号，
 * 否则是正文里的引号，转义掉。只在 parse 失败后兜底跑一次，正常报文不经过这里。
 */
export function escapeStrayQuotes(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      out += c + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (c !== '"') {
      out += c;
      continue;
    }
    if (!inString) {
      inString = true;
      out += c;
    } else if (/^\s*[,}\]:]/.test(text.slice(i + 1))) {
      inString = false;
      out += c;
    } else {
      out += '\\"';
    }
  }
  return out;
}

/**
 * 数组参数归一：数组照收，JSON 字符串解析后照收，其余打回。
 * `emptyHint` 是「收到空字符串」时给模型的那句人话——每个工具的空数组语义不一样。
 */
export function parseArrayArg(value: unknown, field: string, emptyHint: string): unknown[] | string {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") {
    return `${field} 必须是数组（或数组的 JSON 字符串），收到的是 ${value === undefined ? "空" : typeof value}`;
  }
  const text = value.trim();
  if (!text) return `${field} 是空字符串；${emptyHint}`;
  for (const candidate of [text, escapeStrayQuotes(text)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      return `${field} 解析出来是 ${parsed === null ? "null" : typeof parsed}，不是数组；请交 [{...}, {...}] 这样的数组`;
    } catch {
      /* 试下一个候选 */
    }
  }
  return (
    `${field} 这段 JSON 解析不了（多半是文字字段里写了没转义的引号）。` +
    "请重新提交合法 JSON：正文里的引号改用「」，或干脆不写引号。"
  );
}
