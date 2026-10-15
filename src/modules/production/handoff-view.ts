/**
 * 「开始写」交出去之后的样子（spec 2026-10-15 §B5），看板卡和卡片面板共用。
 * 接手的信号：agent 用 autocrew_draft start 接了这篇（pickedUpAt），或交出之后有人认领过它，或稿子已经往后走了。
 * 有活着的认领 → holder（谁在写），不给「重新交给」。
 */
import { activeClaim } from "../../storage/claims.js";
import type { Content } from "../../storage/local-store.js";

/** 宿主身份（令牌主体名或接入名）→ 给人看的名字 */
const LABEL: Record<string, string> = { "claude-code": "Claude Code", claude: "Claude Code", codex: "Codex", workbuddy: "WorkBuddy", chief: "总编辑", dsh: "dsh", "local-user": "你" };
export const holderLabel = (host: string): string => LABEL[host] ?? host;

export interface HandoffView { host: string; label: string; at: string; pickedUp: boolean; holder: string | null }

/**
 * 接手的信号：agent 用 autocrew_draft start 接了这篇（pickedUpAt），或交出之后有人认领过它，或稿子已经往后走了。
 * 有活着的认领 → holder（谁在写），看板不给「重新交给」。
 */
export function handoffView(c: Pick<Content, "writingHandoff" | "claim" | "status" | "body">, now = Date.now()): HandoffView | undefined {
  const h = c.writingHandoff;
  if (!h) return undefined;
  const claim = activeClaim(c, now);
  const claimedAfter = Boolean(c.claim && Date.parse(c.claim.at) >= Date.parse(h.at));
  // 看板建的是空稿：正文有了字也算有人接手（任何写稿路径存过一版）
  const pickedUp = Boolean(h.pickedUpAt) || claimedAfter || c.status !== "drafting" || Boolean(c.body?.trim());
  // 实际接手的是谁就说谁（交给 Codex、结果 Claude 接了 → 「Claude Code 在写」）
  const who = !pickedUp ? h.host : h.pickedUpBy ?? (claimedAfter ? c.claim!.host : h.host);
  return { host: h.host, label: holderLabel(who), at: h.at, pickedUp, holder: claim ? holderLabel(claim.host) : null }
}
