/**
 * 改稿攒下的经验（写作规则提案 + 手册改动提案）在「等你拍板」里的说法（spec 2026-10-15 §A）。
 * 一处定义，看板面板和对话 brief 都引用这里：要判断的问题、原话怎么显示、按稿分组的标题与编号。
 */

/** 只是选项代号：单个字母 / 一两位数字 / 「第 N 个」（可带句号、感叹号） */
const OPTION_CODE = /^\s*(?:[A-Za-z]|\d{1,2}|第\s*[一二三四五六七八九十\d]{1,3}\s*[个张条]?)\s*[。.!！]?\s*$/u;

export const UNRECORDED_CARD = "（选卡时的回复，原卡没记下）";
export const DELETED_CONTENT = "已删的稿";

export function isOptionCode(words: string | null | undefined): boolean {
  return typeof words === "string" && OPTION_CODE.test(words);
}

/**
 * 原话那一行：选项代号带了选项内容 →「你选了 A：……」；代号没记下内容 → 固定一句说明，不显示孤零零的「A」；
 * 普通原话 →「……」。没有原话 → null。
 */
export function wordsLine(words: string | null | undefined, chosen?: string | null): string | null {
  const w = words?.trim();
  if (!w) return null;
  const option = chosen?.trim();
  if (option) return `你选了 ${w.replace(/[。.!！]+$/u, "")}：${option}`;
  if (isOptionCode(w)) return UNRECORDED_CARD;
  return `「${w}」`;
}

/** 要判断的问题：规则 →「以后每篇都这样写？」；手册 →「以后《体裁》都这样写？」 */
export function lessonQuestion(type: "writing_rule" | "playbook_change", playbookName?: string): string {
  return type === "writing_rule" ? "以后每篇都这样写？" : `以后《${playbookName ?? "这种体裁"}》都这样写？`;
}

/** 一组的标题：「《稿名》改稿攒下 N 条经验，要不要以后都照着写」 */
export function lessonGroupTitle(contentTitle: string | null | undefined, n: number): string {
  return `《${contentTitle?.trim() || DELETED_CONTENT}》改稿攒下 ${n} 条经验，要不要以后都照着写`;
}

export const isLessonType = (type: string): type is "writing_rule" | "playbook_change" => type === "writing_rule" || type === "playbook_change";

/** 同一本手册、同一个底版本的意见补充：合并成一份改动（spec §A4）。整本修订不合并 → null */
export function mergeKeyOf(detail: Record<string, unknown>): string | null {
  return detail.kind === "lesson" && detail.playbook && detail.based_on !== undefined ? `${String(detail.playbook)}@${String(detail.based_on)}` : null;
}

export interface LessonGroup<T> { content_id: string; title: string; items: T[] }

/** 按稿分组：同一 content_id 的规则 / 手册提案收成一组（没挂稿的不分组，留给调用方单列） */
export function groupLessons<T extends { type: string; content_id: string | null; detail: Record<string, unknown> }>(items: T[]): LessonGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const i of items) if (isLessonType(i.type) && i.content_id) by.set(i.content_id, [...(by.get(i.content_id) ?? []), i]);
  return [...by.entries()].map(([content_id, list]) => ({ content_id, title: lessonGroupTitle(list[0].detail.content_title as string | undefined, list.length), items: list }));
}
