/**
 * 写作规则在对话里批（spec docs/2026-10-10-chat-feedback-learning-spec.md §C）：要 / 不要 / 替换。
 * 落到 decideWritingRule：eventId 由 request_id 派生，沿用它的 revision 校验、幂等、否决留墓碑、生效上限；
 * 来源记 chat + 原话 + 发起方 + 请求号。「你定 / 都行」这类授权式回答不算批准。
 */
import { decideWritingRule, RuleDecisionError, type RuleDecision } from "../../profile/writing-rules.js";
import type { InboxItem } from "../inbox.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });

export const RULE_DECISIONS: ReadonlySet<string> = new Set(["approve_rule", "reject_rule", "replace_rule"]);

/** 授权式回答：去掉标点、空白和语气词后整句就是这些 */
const DELEGATION = new Set(["你定", "你来定", "你决定", "你看着办", "你看", "你看吧", "都行", "都可以", "随便", "随你", "听你的", "你说了算", "无所谓", "看你", "upto you", "uptoyou", "whatever"]);

export function isDelegation(words: string): boolean {
  const t = words.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "").replace(/[吧啊呗呀哈嘛的了]+$/u, "");
  return DELEGATION.has(t);
}

const SCOPE_TEXT = (scope: unknown) => (scope === "voice_core" || !scope ? "所有平台" : `只在${String(scope).replace(/^platform:/, "")}`);

/** 给创始人的「要你判断」 */
export function ruleBrief(item: InboxItem): string {
  const d = item.detail;
  const conflict = d.conflicts_with as { id: string; rule: string } | null;
  const count = Number(d.active_rule_count ?? 0), cap = Number(d.rule_cap ?? 12);
  return [
    `写作规则提案：${String(d.rule ?? item.summary)}`,
    `适用：${SCOPE_TEXT(d.scope)}`,
    ...(d.founder_words ? [`你当时的原话：「${String(d.founder_words)}」`] : []),
    ...(conflict ? [`和这条已有规则矛盾：「${conflict.rule}」（${conflict.id}）——替换它 / 两条都留 / 这条不要`] : []),
    `现在生效 ${count} / ${cap} 条${count >= cap ? "，已满：要这条就得替换掉一条" : ""}`,
    "要你判断：这是以后每篇都该照着写的，还是只管那一篇？",
    "回我「要」/「不要」/「要，替换第 X 条」",
  ].join("\n");
}

const DECISION_OF: Record<string, RuleDecision> = { approve_rule: "active", replace_rule: "active", reject_rule: "rejected" };
const HANDLED = new Set(["rule_revision_conflict", "rule_tombstoned", "rule_not_pending"]);

export interface RuleCommitInput { decision: string; founder_words: string; request_id: string; requester: string; target_rule_id?: string }

/** 提交一条规则决定；失败换成对话口径（已在别处处理 / 到上限 / 替换目标不对） */
export async function ruleCommit(item: InboxItem, input: RuleCommitInput, dataDir: string): Promise<Result> {
  const ruleId = String(item.detail.rule_id ?? "");
  const revision = Number(item.detail.revision ?? 0);
  const replaces = input.decision === "replace_rule" ? input.target_rule_id : undefined;
  try {
    await decideWritingRule({
      ruleId, revision, decision: DECISION_OF[input.decision], eventId: `chat-${input.request_id}`, ...(replaces ? { replaces } : {}),
      provenance: { source: "chat", founder_words: input.founder_words, requested_by: input.requester, request_id: input.request_id },
    }, dataDir);
  } catch (e) {
    if (!(e instanceof RuleDecisionError)) throw e;
    if (HANDLED.has(e.code)) return fail("already_handled", "这条已在别处处理过（比如工作台刚批过 / 丢过），不用再定：重新 list 看现在的样子");
    if (e.code === "rule_cap_reached") return fail("rule_cap_reached", `${e.message}。把 active 列给创始人，问他换掉哪一条，再用 replace_rule 带 target_rule_id`, e.extra);
    if (e.code === "approval_event_conflict") return fail("request_conflict", "这个 request_id 已经用在另一个决定上了：换一个新的");
    return fail(e.code, e.message, e.extra);
  }
  const done = input.decision === "reject_rule" ? "这条不要了，以后同一句不会再提" : replaces ? `这条生效，替换掉了 ${replaces}` : "这条生效了，之后 start 的写稿就会带上";
  return { ok: true, rule_id: ruleId, decision: input.decision, recorded_as: "chat", next_action: `告诉创始人：${done}。` };
}
