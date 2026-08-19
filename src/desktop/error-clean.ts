/**
 * 给模型/用户的错误消息清洗（对话控制面设计 §Phase 2 / codex P2-4）。
 *
 * 规矩只有两条：**剥本地绝对路径与堆栈**（对话面不该泄露 /Users/xxx 与调用栈），
 * **语义一个字不改**（失败就是失败，不许在这里包装成"已完成"的话术）。
 * 原始错误照旧进 run-log——runLoop 的 recorder 记的是工具原始输出，不受这层影响。
 */

/** 绝对路径：以 `/` 或 `C:\` 起头，且前一个字符不是 词/冒号/斜杠——避开 https://x/y 这类 URL */
const ABS_PATH = /(?<![A-Za-z0-9:/\\])(?:[A-Za-z]:\\|\/)[^\s"'()（），。；]+/g;

export function cleanErrorMessage(err: unknown, maxLen = 300): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const withoutStack = raw
    .split("\n")
    .filter((line) => !/^\s*at\s/.test(line))
    .join(" ")
    .trim();
  const cleaned = withoutStack.replace(ABS_PATH, "<本地路径>").trim();
  if (!cleaned) return "未知错误";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "…" : cleaned;
}
