/** 「去『等你拍板』处理」落到哪一件（纯函数，单独放：review-api 在测试里常被整体 mock） */
/** 要打开的那件事：这条稿的、（带类型时）那一类的第一件 */
export function focusPick<T extends { content_id: string; type: string }>(items: T[], contentId: string, types?: string[]): T | undefined {
  return items.find((i) => i.content_id === contentId && (!types?.length || types.includes(i.type)));
}
