/**
 * 宿主显示名（review-inbox §10）：界面里「谁在剪 / 谁在等」按事实的 by.host 显示真实 agent，不写死「Codex」。
 */
const LABELS: Record<string, string> = {
  "claude-code": "Claude", claude: "Claude", "claude-desktop": "Claude", codex: "Codex", workbuddy: "WorkBuddy", founder: "你", "local-user": "你",
};

export function hostLabel(host: string | undefined | null): string {
  if (!host) return "agent";
  return LABELS[host.toLowerCase()] ?? (/claude/i.test(host) ? "Claude" : /codex/i.test(host) ? "Codex" : /workbuddy/i.test(host) ? "WorkBuddy" : "agent");
}

/** 是不是 agent（你自己点的不算「有 agent 在等」） */
export function isAgentHost(host: string | undefined | null): boolean {
  return Boolean(host) && hostLabel(host) !== "你";
}
