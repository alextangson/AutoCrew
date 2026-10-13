/**
 * 手册对比（spec §9.9）：只做两种——提案对它的 based_on 版本、选中的某一版对当前版本。
 * 按段落（空行分隔）对齐，只列有改动的段落：每处一个 {before, after}。
 */
export interface DiffHunk { before: string[]; after: string[] }

const paragraphs = (text: string) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** 最长公共子序列表（段落级，手册不过几十段） */
function lcsTable(a: string[], b: string[]): number[][] {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  return t;
}

export function paragraphDiff(beforeText: string, afterText: string): DiffHunk[] {
  const a = paragraphs(beforeText), b = paragraphs(afterText);
  const t = lcsTable(a, b);
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  const flush = () => { if (cur && (cur.before.length || cur.after.length)) hunks.push(cur); cur = null; };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; continue; }
    cur ??= { before: [], after: [] };
    if (j >= b.length || (i < a.length && t[i + 1][j] >= t[i][j + 1])) cur.before.push(a[i++]);
    else cur.after.push(b[j++]);
  }
  flush();
  return hunks;
}

/** 给对话里的 brief 用：改前改后逐段写出来 */
export function diffText(hunks: DiffHunk[]): string {
  if (!hunks.length) return "（没有改动）";
  return hunks.map((h, n) => [
    `改动 ${n + 1}：`,
    ...(h.before.length ? h.before.map((p) => `改前：${p}`) : ["改前：（无，新增）"]),
    ...(h.after.length ? h.after.map((p) => `改后：${p}`) : ["改后：（删掉）"]),
  ].join("\n")).join("\n\n");
}
