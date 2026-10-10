/**
 * 写作规则的状态机（spec 2026-09-28 §3 D）。
 *
 * - 取生效规则只有一个函数：rulesForPlatform。初稿、修订、选区改写、画像生成都走它；待批/丢弃/停用都不进写作要求。
 * - 模型可达的入口（蒸馏、MCP editorial feedback、对话 add_style_rule、IPC update_rule）只能产出 pending，
 *   `user_confirmed:true`、`source:"user_explicit"`、认领令牌都不算批准。
 * - 只有 decideWritingRule 能让规则生效。模型可达的入口只产出待批；生效只经两条路：工作台会话路由（desktop/rule-approval，
 *   浏览器会话 + 同源），或带创始人原话的对话决定（chat-approval/rule-decide，记原话、会话、请求编号，事后可查；
 *   spec 2026-10-10 chat-feedback-learning）。不进 IPC。审批事件绑定 rule id + revision + 决定，按 eventId 幂等。
 * - 生效规则总数上限 RULE_CAP：到上限后新规则只能替换某条旧规则才能批准。
 * - 兼容：存量规则缺 status 视为 active，但 disabled:true 仍是停用。新写入时把 disabled 与状态对齐
 *   （非 active 一律 disabled:true），这样还在跑旧代码的进程读到待批规则也会跳过。
 */
import { createHash, randomUUID } from "node:crypto";
import { mutateProfile, type CreatorProfile, type WritingRule } from "./creator-profile.js";

export type RuleStatus = "active" | "pending" | "rejected" | "disabled";
export type RuleDecision = "active" | "rejected" | "disabled";

const EVIDENCE_MAX = 10;
const EVIDENCE_CHARS = 600;
const DECISIONS_KEPT = 500;

export function ruleStatus(r: WritingRule): RuleStatus {
  if (r.status) return r.status;
  return r.disabled ? "disabled" : "active";
}
export function isRuleActive(r: WritingRule): boolean {
  return ruleStatus(r) === "active";
}

/**
 * 本平台实际生效的规则：active 且（voice_core 或 platform:<platform>）。
 * platform 传 null 表示不限平台（画像生成这类不针对单一平台的写作指导）。
 */
export function rulesForPlatform(profile: CreatorProfile, platform: string | null): WritingRule[] {
  return profile.writingRules.filter((r) => {
    if (!isRuleActive(r)) return false;
    if (platform === null) return true;
    const scope = r.scope ?? "voice_core";
    return scope === "voice_core" || scope === `platform:${platform}`;
  });
}

function legacyRuleId(rule: WritingRule, index: number): string {
  return "r-" + createHash("sha256").update(JSON.stringify([index, rule.rule, rule.createdAt, rule.scope ?? null])).digest("hex").slice(0, 20);
}

/** 读侧补 id/revision；不碰 status/disabled（停用的 7 条不能因此复活） */
export function normalizeRules(rules: WritingRule[]): WritingRule[] {
  return rules.map((r, i) => ({ ...r, id: r.id ?? legacyRuleId(r, i), revision: r.revision ?? 1 }));
}

function setStatus(r: WritingRule, status: RuleStatus): void {
  r.status = status;
  r.disabled = status !== "active";
  r.revision = (r.revision ?? 1) + 1;
}

function clipEvidence(evidence: string[] | undefined): string[] {
  return (evidence ?? []).map((e) => e.trim()).filter(Boolean).map((e) => e.slice(0, EVIDENCE_CHARS)).slice(0, EVIDENCE_MAX);
}

export type AddRuleOutcome = "created_pending" | "promotion_proposed" | "already_exists" | "blocked_by_tombstone";

/**
 * 记下一条规则提案。永远不会让任何规则生效：
 * - 同文本有丢弃墓碑 → 挡掉；
 * - 同文本同作用域已存在（不论状态）→ 不重复建，待批的补上证据；
 * - 同文本在另一个平台已生效（自动提炼的跨平台重现）→ 另建一份「升级为全局」提案，原平台规则保持原样继续生效；
 *   用户明确点名平台的（opts.promote=false）照他说的平台另记一条；
 * - 否则新建 pending。
 */
export async function addWritingRule(
  rule: Omit<WritingRule, "createdAt" | "id" | "revision" | "status" | "disabled" | "promotes" | "promotesRevision" | "promotedFrom">,
  dataDir?: string,
  opts: { promote?: boolean } = {},
): Promise<CreatorProfile & { lastRuleOutcome?: AddRuleOutcome }> {
  const { profile, result } = await mutateProfile((profile): AddRuleOutcome => {
    const text = rule.rule.trim();
    const matches = profile.writingRules.filter((r) => r.rule.trim() === text);
    if (matches.some((r) => ruleStatus(r) === "rejected")) return "blocked_by_tombstone";
    const scope = rule.scope ?? "voice_core";
    const evidence = clipEvidence(rule.evidence);
    const now = new Date().toISOString();
    // 同文本已是声音内核（不论状态）：内核已覆盖所有平台，不降级、不另起提案
    const same = matches.find((r) => (r.scope ?? "voice_core") === scope) ?? matches.find((r) => (r.scope ?? "voice_core") === "voice_core");
    if (same) {
      if (ruleStatus(same) === "pending" && evidence.length) same.evidence = clipEvidence([...(same.evidence ?? []), ...evidence]);
      return "already_exists";
    }
    const platformRule = matches.find((r) => (r.scope ?? "voice_core") !== "voice_core" && !r.promotes);
    if (platformRule && opts.promote !== false) {
      // 原平台规则还没生效（待批/停用）时谈不上「升级」：不另起提案，免得给创始人堆重复待批项
      if (!isRuleActive(platformRule)) return "already_exists";
      if (matches.some((r) => r.promotes === platformRule.id)) return "already_exists";
      profile.writingRules.push({
        ...rule, rule: text, evidence, id: randomUUID(), revision: 1, status: "pending", disabled: true,
        scope: "voice_core", promotes: platformRule.id, promotesRevision: platformRule.revision, createdAt: now,
      });
      return "promotion_proposed";
    }
    profile.writingRules.push({ ...rule, rule: text, evidence, id: randomUUID(), revision: 1, status: "pending", disabled: true, createdAt: now });
    return "created_pending";
  }, dataDir);
  return Object.assign(profile, { lastRuleOutcome: result });
}

/**
 * 工作台（也经 IPC 可达）改规则：按 id + revision 定位（不再按数组下标）。
 * 改文本 → 回到 pending 等批；停用 → disabled；「启用」只能申请成 pending。这里没有任何一条路能变 active。
 */
export async function updateWritingRule(
  target: { id: string; revision: number },
  patch: { rule?: string; disabled?: boolean },
  dataDir?: string,
): Promise<CreatorProfile> {
  const { profile } = await mutateProfile((profile) => {
    const r = profile.writingRules.find((x) => x.id === target.id);
    if (!r) throw new Error(`规则不存在：${target.id}`);
    if (r.revision !== target.revision) throw new Error("规则已被更新（rule_revision_conflict），请刷新后再改");
    if (ruleStatus(r) === "rejected") throw new Error("这条规则已丢弃，不能再改");
    if (patch.rule !== undefined) {
      const text = patch.rule.trim();
      if (!text) throw new Error("规则内容不能为空");
      if (text !== r.rule) { r.rule = text; setStatus(r, "pending"); }
    }
    if (patch.disabled === true && ruleStatus(r) !== "disabled") setStatus(r, "disabled");
    if (patch.disabled === false && ruleStatus(r) === "disabled") setStatus(r, "pending");
  }, dataDir);
  return profile;
}

export const RULE_CAP = 12;

/** 审批被拒：code 给调用方分流（对话回执 / 工作台人话），extra 带现有生效规则等 */
export class RuleDecisionError extends Error {
  constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export interface RuleDecisionEvent {
  ruleId: string; revision: number; decision: RuleDecision; eventId: string;
  /** 替换：本条生效的同一次写入里停用这条（只在 decision=active 时） */
  replaces?: string;
  /** 对话里定的：原话、发起方、请求号（工作台的不带） */
  provenance?: { source: "chat"; founder_words: string; requested_by: string; request_id: string };
}

const sameEvent = (a: RuleDecisionEvent, b: { ruleId: string; revision: number; decision: string; replaces?: string }) =>
  a.ruleId === b.ruleId && a.revision === b.revision && a.decision === b.decision && (a.replaces ?? undefined) === (b.replaces ?? undefined);

export const activeRuleCount = (profile: CreatorProfile) => profile.writingRules.filter(isRuleActive).length;

/** 生效数会超过上限 → 拒，回执列出现有生效规则 */
function checkCap(profile: CreatorProfile, r: WritingRule, input: RuleDecisionEvent): void {
  if (input.decision !== "active") return;
  const delta = (isRuleActive(r) ? 0 : 1) - (r.promotes ? 1 : 0) - (input.replaces ? 1 : 0);
  const count = activeRuleCount(profile);
  if (delta <= 0 || count + delta <= RULE_CAP) return;
  const active = profile.writingRules.filter(isRuleActive).map((x) => ({ id: x.id, scope: x.scope ?? "voice_core", rule: x.rule }));
  throw new RuleDecisionError("rule_cap_reached", `生效规则已经有 ${count} 条（上限 ${RULE_CAP} 条）：新规则只能替换掉一条旧规则才能生效——先停用一条，或选「替换」`, { active, rule_cap: RULE_CAP });
}

function replaceTarget(profile: CreatorProfile, r: WritingRule, input: RuleDecisionEvent): WritingRule | null {
  if (!input.replaces) return null;
  const t = profile.writingRules.find((x) => x.id === input.replaces);
  if (input.decision !== "active" || !t || t.id === r.id || !isRuleActive(t)) {
    throw new RuleDecisionError("replace_target_invalid", "要替换的那条规则不存在或现在没生效：按现有生效规则重新选一条");
  }
  return t;
}

/** 升级提案生效：只停用提案点名的那一版原规则 */
function applyPromotion(profile: CreatorProfile, r: WritingRule): void {
  // 原规则之后被改过或重新批过，提案就过时了，不能去停用一条它没见过的规则
  const original = profile.writingRules.find((x) => x.id === r.promotes);
  if (!original || original.revision !== r.promotesRevision || !isRuleActive(original)) {
    throw new RuleDecisionError("promotion_stale", "升级提案已过时（promotion_stale）：原平台规则已被修改或不再生效，请丢弃这份提案，等下次重新提出");
  }
  setStatus(original, "disabled");
  // 提案完成：之后它就是一条普通的全局规则，停用/再启用/改文本都不再碰原平台规则（Codex 第三轮 P2）
  r.promotedFrom = r.promotes;
  delete r.promotes;
  delete r.promotesRevision;
}

function checkDecidable(profile: CreatorProfile, input: RuleDecisionEvent): WritingRule {
  const r = profile.writingRules.find((x) => x.id === input.ruleId);
  if (!r || r.revision !== input.revision) throw new RuleDecisionError("rule_revision_conflict", "规则已变化（rule_revision_conflict），请刷新后再批");
  if (ruleStatus(r) === "rejected") throw new RuleDecisionError("rule_tombstoned", "这条规则已丢弃（墓碑），不能再改决定");
  if (input.decision === "rejected" && ruleStatus(r) !== "pending") throw new RuleDecisionError("rule_not_pending", "只有待批规则可以丢弃；已生效的请停用");
  return r;
}

/**
 * 创始人决定（唯一能让规则生效的函数）。工作台会话路由与对话决定调用。
 * 同一 eventId 重放返回同一结果；eventId 相同但内容不同 → 冲突；revision 对不上 → 冲突（防止批到已被改过的文本）。
 * 校验全在改动之前：任何一项不过就抛，整次不落盘。
 */
export async function decideWritingRule(input: RuleDecisionEvent, dataDir?: string): Promise<CreatorProfile> {
  const { profile } = await mutateProfile((profile) => {
    const prior = profile.ruleDecisions?.find((e) => e.eventId === input.eventId);
    if (prior) {
      if (!sameEvent(input, prior)) throw new RuleDecisionError("approval_event_conflict", "审批事件冲突（approval_event_conflict）：同一 eventId 已用于另一决定");
      return;
    }
    const r = checkDecidable(profile, input);
    const target = replaceTarget(profile, r, input);
    checkCap(profile, r, input);
    if (input.decision === "active" && r.promotes) applyPromotion(profile, r);
    if (target) { setStatus(target, "disabled"); target.disabledReason = `被 ${r.id} 替换`; }
    setStatus(r, input.decision);
    const { provenance, ...event } = input;
    profile.ruleDecisions = [...(profile.ruleDecisions ?? []), { ...event, ...(provenance ?? {}), at: new Date().toISOString() }].slice(-DECISIONS_KEPT);
  }, dataDir);
  return profile;
}

/**
 * 对话里的改稿意见和一条已有规则意思重复：只把原话追加为它的出处，不动 status / revision。
 * 规则不在或已否决 → "missing"（调用方按新规则处理）。
 */
export async function appendRuleEvidence(ruleId: string, evidence: string, dataDir?: string): Promise<"evidence_added" | "missing"> {
  const { result } = await mutateProfile((profile): "evidence_added" | "missing" => {
    const r = profile.writingRules.find((x) => x.id === ruleId);
    if (!r || ruleStatus(r) === "rejected") return "missing";
    const added = clipEvidence([evidence]);
    r.evidence = [...(r.evidence ?? []), ...added].slice(-EVIDENCE_MAX);
    return "evidence_added";
  }, dataDir);
  return result;
}
