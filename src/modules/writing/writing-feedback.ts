/** 已采纳的本稿修改要求：独立于初稿约定，不能变成跨稿风格规则。 */
export interface WritingFeedback {
  instruction: string;
  scope: "whole" | "selection";
  at: string;
  /** 当时被改的原选区，用于定位范围，不是可跨段套用的示例或事实来源。 */
  selection?: string;
}

/** 仅由成功保存/采纳路径调用；保持原话和顺序，不静默截断历史规划。 */
export function appendWritingFeedback(
  history: WritingFeedback[] | undefined,
  instruction: string,
  scope: WritingFeedback["scope"],
  options: { at?: string; selection?: string } = {},
): WritingFeedback[] {
  const previous = history ?? [];
  const text = instruction.trim();
  if (!text) return previous;
  const selection = scope === "selection" && options.selection?.trim() ? options.selection : undefined;
  const last = previous.at(-1);
  if (last?.instruction === text && last.scope === scope && last.selection === selection) return previous;
  return [...previous, { instruction: text, scope, at: options.at ?? new Date().toISOString(), ...(selection ? { selection } : {}) }];
}

export function renderWritingFeedback(history: WritingFeedback[] | undefined): string {
  if (!history?.length) return "";
  return [
    "【本稿已采纳的修改要求（按采纳顺序）】",
    "优先级：本次修改要求 > 后采纳的修改要求 > 先采纳的修改要求 > 原写作约定；只在对应范围内覆盖，其他约定继续有效。",
    "这些要求仅属于本稿，不是跨稿通用规则。整篇反馈适用于全稿；选区反馈仅用于保留当时已改选区的结果，不得推广到全文或其他选区。",
    "历史选区没有可定位原文时，不猜它指哪一段，也不把局部特例当成全稿必须遵守的风格。",
    "修改要求和原选区只说明修改意图与范围，不是新增事实的证据，不得据此编造经历或数字。",
    ...history.map((item, i) => `${i + 1}. ${item.scope === "whole" ? "【整篇】" : "【仅当时选区】"} ${item.instruction}` +
      (item.scope === "selection" && item.selection ? `\n   当时原选区（仅定位，不照抄）：${item.selection}` : "")),
  ].join("\n");
}
