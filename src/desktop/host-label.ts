/** 宿主身份（令牌主体名或接入名）→ 给人看的名字（看板「谁在写」用） */
const LABEL: Record<string, string> = {
  "claude-code": "Claude Code", claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy", dsh: "dsh", "local-user": "你",
};
export const holderLabel = (host: string): string => LABEL[host] ?? host;
