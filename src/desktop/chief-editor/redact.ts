/**
 * 总编辑本机 agent 的脱敏（spec §地基 13 / 10）：卡片字段白名单，错误先脱敏再截断。
 *
 * 为什么「先脱敏再截断」：先截断可能把一枚令牌切成半截，半截令牌不再匹配正则，
 * 反而原样漏出去。claim_token 永远不进卡片、日志、SSE——这里是它们共同的出口。
 */

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // JSON / 文本里的 claim_token、各类 token/key/secret 字段值
  [/("?(?:claim_token|approval_token|token|api[_-]?key|secret|password|authorization)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[已隐藏]"'],
  [/((?:claim_token|approval_token|api[_-]?key|secret|password)\s*[:=]\s*)[^\s,;"'}]+/gi, "$1[已隐藏]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [已隐藏]"],
  // 认领令牌（clm-<毫秒>-<随机>）与总编辑会话令牌（ce_…）：agent 在正文里复述时也要挡住
  [/\bclm-\d{10,}-[a-z0-9]{4,}/g, "[已隐藏]"],
  [/\bce_[A-Za-z0-9_-]{8,}/g, "[已隐藏]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[已隐藏]"],
  // 32 位以上十六进制/base64url 串：令牌、会话 id、审批凭证都长这样
  [/\b[A-Fa-f0-9]{32,}\b/g, "[已隐藏]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[已隐藏]"],
];

export function redactText(input: string): string {
  let out = input;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * 流式正文脱敏：令牌可能被切在两个分块之间，所以末尾留一段不发，等后文到了再判。
 * 每次对全文重新脱敏，只把「已稳定」的前缀增量发出去；finish 时把剩下的全发。
 */
export class StreamRedactor {
  private raw = "";
  private sent = 0;
  constructor(private readonly holdback = 160) {}

  push(chunk: string): string {
    this.raw += chunk;
    const clean = redactText(this.raw);
    const stable = Math.max(this.sent, clean.length - this.holdback);
    const out = clean.slice(this.sent, stable);
    this.sent = stable;
    return out;
  }

  finish(): string {
    const clean = redactText(this.raw);
    const out = clean.slice(this.sent);
    this.sent = clean.length;
    return out;
  }
}

/** 脱敏后按码点截断，超长补 … */
export function redactAndTruncate(input: string, max = 300): string {
  const clean = redactText(input).replace(/\s+\n/g, "\n").trim();
  const points = Array.from(clean);
  return points.length > max ? `${points.slice(0, max).join("")}…` : clean;
}

/** stderr 尾部：最后几行，脱敏后再截断（适配器崩溃时附在报错里，§边界 12） */
export function redactedTail(stderr: string, lines = 6, max = 600): string {
  const tail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join("\n");
  // 逐行截断前先整体脱敏；再从尾部保留 max 个码点（尾部才是报错本身）
  const clean = redactText(tail);
  const points = Array.from(clean);
  return points.length > max ? `…${points.slice(-max).join("")}` : clean;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * MCP 工具结果 → v1 卡片（spec §v1 卡片）。字段白名单：只挑出列在这里的键，
 * structuredContent 里其余一切（含 claim_token、完整正文）一律不出执行上下文。
 */
export function cardFromToolResult(tool: string, action: string, result: Json, callId: string, args: Json = {}): Json {
  const content = (result.content ?? result.draft) as Json | undefined;
  const contentId = str(result.content_id) ?? str(content?.id) ?? str(result.contentId) ?? str(args.content_id) ?? str(args.id);
  const title = str(content?.title) ?? str(result.title);
  const ok = result.ok !== false;
  if (ok && contentId && (tool === "autocrew_writer" || tool === "autocrew_review_desk" || tool === "autocrew_content" || tool === "autocrew_editorial")) {
    return {
      type: "agent_draft",
      callId,
      data: {
        contentId,
        ...(title ? { title: redactAndTruncate(title, 60) } : {}),
        ...(str(content?.status) ?? str(result.status) ? { status: str(content?.status) ?? str(result.status) } : {}),
        tool,
        action,
      },
    };
  }
  const taskId = str(result.task_id) ?? str(result.job_id) ?? str(result.run_id);
  if (ok && taskId) {
    return { type: "agent_task", callId, data: { tool, action, taskId, status: str(result.status) ?? "已受理" } };
  }
  const text = ok
    ? str(result.message) ?? str(result.summary) ?? "已完成"
    : str(result.error) ?? "调用失败";
  return { type: "agent_text", callId, data: { tool, action, ok, text: redactAndTruncate(text, 200) } };
}
