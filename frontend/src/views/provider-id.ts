/**
 * 自定义端点的 id 生成（设计 §Phase 4，codex 快审 #1）。
 *
 * id 只在**创建那一刻**生成一次并随配置落盘：改名不重算——否则用户把「DeepSeek」
 * 改成「深度求索」，对话切换器里存着的 `p:deepseek:xxx` 就指向一个不存在的端点了。
 * 字符集与服务端 PROVIDER_ID_RE 同一把尺：`[a-z0-9-]{1,32}`（选项 id 靠冒号定界，id 里不能有冒号）。
 */
const MAX_LEN = 32;
/** 名字里一个可用字符都没有（纯中文/纯符号）时的兜底基名——id 只在配置文件里露面 */
const FALLBACK = "endpoint";

export function slugProviderId(name: string, taken: Iterable<string> = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, MAX_LEN)
      .replace(/-$/, "") || FALLBACK;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_LEN - suffix.length).replace(/-$/, "") + suffix;
    if (!used.has(candidate)) return candidate;
  }
  // 1000 个重名是不可能事件，但也不能回一个已占用的 id
  return `${base.slice(0, 24).replace(/-$/, "")}-${Date.now().toString(36).slice(-6)}`;
}
