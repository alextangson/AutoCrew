/**
 * 「开始写」交出去之后的样子（spec 2026-10-15 §B5），看板卡和卡片面板共用。
 * 接手的信号：agent 用 autocrew_draft start 接了这篇（pickedUpAt），或交出之后有人认领过它，或稿子已经往后走了。
 * 有活着的认领 → holder（谁在写），不给「重新交给」。
 */
import { activeClaim } from "../../storage/claims.js";
import type { Content } from "../../storage/local-store.js";

/** 宿主身份（令牌主体名或接入名）→ 给人看的名字 */
const LABEL: Record<string, string> = { "claude-code": "Claude Code", claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy", dsh: "dsh", "local-user": "你" };
export const holderLabel = (host: string): string => LABEL[host] ?? host;

export interface HandoffView { host: string; label: string; at: string; pickedUp: boolean; holder: string | null }

/**
 * 接手的信号：agent 用 autocrew_draft start 接了这篇（pickedUpAt），或交出之后有人认领过它，或稿子已经往后走了。
 * 有活着的认领 → holder（谁在写），看板不给「重新交给」。
 */
export function handoffView(c: Content, now = Date.now()): HandoffView | undefined {
  const h = c.writingHandoff;
  if (!h) return undefined;
  const claim = activeClaim(c, now);
  const claimedAfter = Boolean(c.claim && Date.parse(c.claim.at) >= Date.parse(h.at));
  const pickedUp = Boolean(h.pickedUpAt) || claimedAfter || c.status !== "drafting";
  return { host: h.host, label: holderLabel(h.host), at: h.at, pickedUp, holder: claim ? holderLabel(claim.host) : null }
}
