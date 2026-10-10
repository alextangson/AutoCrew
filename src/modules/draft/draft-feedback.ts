/**
 * 对话里的改稿意见也能被吸取（spec docs/2026-10-10-chat-feedback-learning-spec.md）。
 * save 带 feedback：原话记在稿上；AI 概括出的通用规则进档案待批（new / conflict），或给已有规则添出处（duplicate）。
 * 重复 / 冲突由 AI 判断，这里只按 id 执行。
 */
import { maybeJson, UNPARSABLE } from "../publish/review-gate/plan.js";
import { addWritingRule, appendRuleEvidence, activeRuleCount, RULE_CAP, ruleStatus } from "../profile/writing-rules.js";
import { loadProfile, type CreatorProfile, type RuleScope, type WritingRule } from "../profile/creator-profile.js";

export type LessonRelation = "new" | "duplicate" | "conflict";
export interface FeedbackLesson { rule: string; scope: RuleScope; relation: LessonRelation; relates_to?: string }
export interface DraftFeedbackInput { founder_words: string; lessons: FeedbackLesson[] }
export type LessonOutcome = "created_pending" | "already_exists" | "blocked_by_tombstone" | "evidence_added";
export interface LessonResult { rule: string; outcome: LessonOutcome; rule_id?: string; note?: string }
/** 稿上的意见记录：版本号、原话、每条概括的去向 */
export interface DraftFeedbackRecord { version: number; founder_words: string; at: string; lessons: Array<{ rule_id?: string; outcome: LessonOutcome }> }

const RULE_MAX = 200;
const REJECTED_SHOWN = 30;
const SCOPE = /^(voice_core|platform:[a-z0-9_]+)$/;
const RELATIONS: readonly string[] = ["new", "duplicate", "conflict"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function lessonOf(raw: unknown, i: number): FeedbackLesson | string {
  const x = maybeJson(raw);
  const at = `lessons[${i}]`;
  if (!isObj(x)) return `${at} 要是对象 {rule, scope, relation, relates_to?}`;
  const rule = typeof x.rule === "string" ? x.rule.trim() : "";
  if (!rule) return `${at}.rule 是空的`;
  if (Array.from(rule).length > RULE_MAX) return `${at}.rule 超过 ${RULE_MAX} 字：概括成一条通用写法`;
  const scope = x.scope === undefined ? "voice_core" : x.scope;
  if (typeof scope !== "string" || !SCOPE.test(scope)) return `${at}.scope 只能是 voice_core 或 platform:<平台>（如 platform:douyin）`;
  if (typeof x.relation !== "string" || !RELATIONS.includes(x.relation)) return `${at}.relation 只能是 new / duplicate / conflict`;
  const relatesTo = typeof x.relates_to === "string" && x.relates_to.trim() ? x.relates_to.trim() : undefined;
  if (x.relation !== "new" && !relatesTo) return `${at} 是 ${x.relation}，要带 relates_to（已有规则的 id，见 start 回执的 rules_detail / pending_rules）`;
  return { rule, scope: scope as RuleScope, relation: x.relation as LessonRelation, ...(relatesTo ? { relates_to: relatesTo } : {}) };
}

/**
 * feedback 参数归一（仓库约定：中转会把对象 / 数组变字符串）：对象直接用，字符串先解析（修引号重试），
 * 真解析不了才拒；lessons 缺省 / 空 = 只管这篇；不是数组绝不当空数组。返回 string = 拒绝原因。
 */
export function parseFeedback(raw: unknown): DraftFeedbackInput | string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const v = maybeJson(raw);
  if (v === UNPARSABLE) return "feedback 看着是 JSON，但修过引号也解析不了：检查括号与逗号";
  if (!isObj(v)) return "feedback 要是对象 {founder_words, lessons?}";
  const words = typeof v.founder_words === "string" ? v.founder_words.trim() : "";
  if (!words) return "feedback.founder_words 必填：创始人这次的原话，逐字";
  const rawLessons = v.lessons === undefined || v.lessons === null || v.lessons === "" ? [] : maybeJson(v.lessons);
  if (rawLessons === UNPARSABLE) return "feedback.lessons 看着是 JSON，但修过引号也解析不了";
  if (!Array.isArray(rawLessons)) return "feedback.lessons 要是数组（只管这篇就不传或传 []）";
  const lessons: FeedbackLesson[] = [];
  for (const [i, l] of rawLessons.entries()) {
    const got = lessonOf(l, i);
    if (typeof got === "string") return got;
    lessons.push(got);
  }
  return { founder_words: words, lessons };
}

const ruleIdOf = (p: CreatorProfile, text: string, scope: string) =>
  p.writingRules.find((r) => r.rule.trim() === text && (r.scope ?? "voice_core") === scope)?.id ?? p.writingRules.find((r) => r.rule.trim() === text)?.id;

async function addLesson(l: FeedbackLesson, origin: NonNullable<WritingRule["origin"]>, evidence: string, dataDir?: string): Promise<LessonResult> {
  const added = await addWritingRule({
    rule: l.rule, scope: l.scope, source: "user_explicit", confidence: 1, evidence: [evidence], origin,
    ...(l.relation === "conflict" && l.relates_to ? { conflictsWith: l.relates_to } : {}),
  }, dataDir, { promote: false });
  const outcome = (added.lastRuleOutcome === "promotion_proposed" ? "created_pending" : added.lastRuleOutcome ?? "created_pending") as LessonOutcome;
  const id = outcome === "blocked_by_tombstone" ? undefined : ruleIdOf(added, l.rule, l.scope);
  return { rule: l.rule, outcome, ...(id ? { rule_id: id } : {}) };
}

/** 逐条落档案，结果写进 out；任何一次档案写失败就抛（out 里留着已落的），调用方把原始错误放进回执（这一版已存，不回滚） */
export async function applyLessons(input: DraftFeedbackInput, contentId: string, version: number, dataDir: string | undefined, out: LessonResult[]): Promise<void> {
  const evidence = `稿件 ${contentId} 第 ${version} 版 创始人原话：${input.founder_words}`;
  const origin = { content_id: contentId, version, founder_words: input.founder_words };
  for (const l of input.lessons) {
    if (l.relation === "duplicate" && l.relates_to) {
      if (await appendRuleEvidence(l.relates_to, evidence, dataDir) === "evidence_added") { out.push({ rule: l.rule, outcome: "evidence_added", rule_id: l.relates_to }); continue; }
      out.push({ ...await addLesson({ ...l, relation: "new" }, origin, evidence, dataDir), note: `relates_to ${l.relates_to} 不存在或已否决，按新规则记成待批` });
      continue;
    }
    out.push(await addLesson(l, origin, evidence, dataDir));
  }
}

const brief = (r: WritingRule) => ({ id: r.id, scope: r.scope ?? "voice_core", rule: r.rule });

/** start 给 AI 判断 new / duplicate / conflict 用：生效（带 id）、待批、最近否决、生效数与上限 */
export function ruleJudgeContext(profile: CreatorProfile, active: WritingRule[]): Record<string, unknown> {
  return {
    rules_detail: active.map(brief),
    pending_rules: profile.writingRules.filter((r) => ruleStatus(r) === "pending").map(brief),
    rejected_rules: profile.writingRules.filter((r) => ruleStatus(r) === "rejected").map((r) => r.rule).slice(-REJECTED_SHOWN),
    active_rule_count: activeRuleCount(profile),
    rule_cap: RULE_CAP,
  };
}

/** prepare_final：这篇攒下的、仍待批的规则（编号、原话、冲突规则原文），以及「已有但没管住」的那几条 */
export async function pendingLessons(contentId: string, feedback: DraftFeedbackRecord[] | undefined, dataDir?: string): Promise<Record<string, unknown>> {
  const profile = await loadProfile(dataDir);
  if (!profile) return { pending_lessons: [], repeated_rules: [], active_rule_count: 0, rule_cap: RULE_CAP };
  const byId = new Map(profile.writingRules.map((r) => [r.id, r]));
  const pending = profile.writingRules.filter((r) => r.origin?.content_id === contentId && ruleStatus(r) === "pending");
  const repeatedIds = [...new Set((feedback ?? []).flatMap((f) => f.lessons.filter((l) => l.outcome === "evidence_added" && l.rule_id).map((l) => l.rule_id!)))];
  return {
    pending_lessons: pending.map((r, i) => {
      const c = r.conflictsWith ? byId.get(r.conflictsWith) : undefined;
      return { number: i + 1, rule_id: r.id, rule: r.rule, scope: r.scope ?? "voice_core", founder_words: r.origin?.founder_words ?? null,
        conflicts_with: c ? { id: c.id, rule: c.rule, status: ruleStatus(c) } : null };
    }),
    repeated_rules: repeatedIds.map((id) => byId.get(id)).filter((r): r is WritingRule => Boolean(r)).map((r) => ({ ...brief(r), status: ruleStatus(r) })),
    active_rule_count: activeRuleCount(profile),
    rule_cap: RULE_CAP,
  };
}
