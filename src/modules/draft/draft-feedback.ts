/**
 * 对话里的改稿意见也能被吸取（spec docs/2026-10-10-chat-feedback-learning-spec.md）。
 * save 带 feedback：原话记在稿上；AI 概括出的通用规则进档案待批（new / conflict），或给已有规则添出处（duplicate）。
 * 重复 / 冲突由 AI 判断，这里只按 id 执行。
 */
import { maybeJson, UNPARSABLE } from "../publish/review-gate/plan.js";
import { addWritingRule, appendRuleEvidence, activeRuleCount, RULE_CAP, ruleStatus } from "../profile/writing-rules.js";
import { loadProfile, type CreatorProfile, type RuleScope, type WritingRule } from "../profile/creator-profile.js";
import { proposalFrom, proposeLesson } from "../playbook/changes.js";
import { loadManifest } from "../playbook/store.js";
import { PLAYBOOK_IDS, type PlaybookId, type PlaybookPin } from "../playbook/types.js";
import { isOptionCode } from "../production/lesson-view.js";

export type LessonRelation = "new" | "duplicate" | "conflict";
/** playbook:<id> = 针对某种体裁的写法：不进档案，挂成那本手册的待批提案（spec 2026-10-13 §3、§9.5） */
export type LessonScope = RuleScope | `playbook:${PlaybookId}`;
export interface FeedbackLesson { rule: string; scope: LessonScope; relation: LessonRelation; relates_to?: string }
/** chosen_option：founder_words 只是选项代号（「A」「2」「第 3 个」）时，那个选项的全文（spec 2026-10-15 §A3） */
export interface DraftFeedbackInput { founder_words: string; chosen_option?: string; lessons: FeedbackLesson[] }
export type LessonOutcome = "created_pending" | "already_exists" | "blocked_by_tombstone" | "evidence_added" | "playbook_proposed" | "playbook_duplicate" | "blocked_by_rejected";
export interface LessonResult { rule: string; outcome: LessonOutcome; rule_id?: string; proposal_id?: string; note?: string }
/** 稿上的意见记录：版本号、原话、每条概括的去向；playbook = 写入时立意记的手册版本（统计按它对，spec §9.4） */
export interface DraftFeedbackRecord { version: number; founder_words: string; chosen_option?: string; at: string; playbook?: PlaybookPin; lessons: Array<{ rule_id?: string; proposal_id?: string; outcome: LessonOutcome }> }

const RULE_MAX = 200;
const REJECTED_SHOWN = 30;
const SCOPE = new RegExp(`^(voice_core|platform:[a-z0-9_]+|playbook:(${PLAYBOOK_IDS.join("|")}))$`);
const isPlaybookScope = (scope: string): scope is `playbook:${PlaybookId}` => scope.startsWith("playbook:");
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
  if (typeof scope !== "string" || !SCOPE.test(scope)) return `${at}.scope 只能是 voice_core、platform:<平台>（如 platform:douyin）或 playbook:<${PLAYBOOK_IDS.join("|")}>`;
  if (isPlaybookScope(scope)) {
    if (x.relation === "conflict") return `${at} 是手册类意见：不支持 conflict，重复由服务端按原文判断（relation 传 new）`;
    return { rule, scope, relation: "new" };
  }
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
  const chosen = typeof v.chosen_option === "string" ? v.chosen_option.trim() : "";
  if (isOptionCode(words) && !chosen) return `feedback.founder_words「${words}」只是选项代号：再带上 feedback.chosen_option（他选的那个选项的全文），不然以后没人看得懂这句`;
  const rawLessons = v.lessons === undefined || v.lessons === null || v.lessons === "" ? [] : maybeJson(v.lessons);
  if (rawLessons === UNPARSABLE) return "feedback.lessons 看着是 JSON，但修过引号也解析不了";
  if (!Array.isArray(rawLessons)) return "feedback.lessons 要是数组（只管这篇就不传或传 []）";
  const lessons: FeedbackLesson[] = [];
  for (const [i, l] of rawLessons.entries()) {
    const got = lessonOf(l, i);
    if (typeof got === "string") return got;
    lessons.push(got);
  }
  return { founder_words: words, ...(chosen ? { chosen_option: chosen } : {}), lessons };
}

const ruleIdOf = (p: CreatorProfile, text: string, scope: string) =>
  p.writingRules.find((r) => r.rule.trim() === text && (r.scope ?? "voice_core") === scope)?.id ?? p.writingRules.find((r) => r.rule.trim() === text)?.id;

async function addLesson(l: FeedbackLesson & { scope: RuleScope }, origin: NonNullable<WritingRule["origin"]>, evidence: string, dataDir?: string): Promise<LessonResult> {
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
  const said = input.chosen_option ? `${input.founder_words}（选的是：${input.chosen_option}）` : input.founder_words;
  const evidence = `稿件 ${contentId} 第 ${version} 版 创始人原话：${said}`;
  const origin = { content_id: contentId, version, founder_words: input.founder_words, ...(input.chosen_option ? { chosen_option: input.chosen_option } : {}) };
  for (const l of input.lessons) {
    if (isPlaybookScope(l.scope)) {
      const r = await proposeLesson({ id: l.scope.slice("playbook:".length) as PlaybookId, lesson: l.rule, founder_words: input.founder_words, ...(input.chosen_option ? { chosen_option: input.chosen_option } : {}), origin: { content_id: contentId, version } }, dataDir);
      out.push({ rule: l.rule, outcome: r.outcome, proposal_id: r.proposal_id });
      continue;
    }
    if (l.relation === "duplicate" && l.relates_to) {
      if (await appendRuleEvidence(l.relates_to, evidence, dataDir) === "evidence_added") { out.push({ rule: l.rule, outcome: "evidence_added", rule_id: l.relates_to }); continue; }
      out.push({ ...await addLesson({ ...l, scope: l.scope as RuleScope, relation: "new" }, origin, evidence, dataDir), note: `relates_to ${l.relates_to} 不存在或已否决，按新规则记成待批` });
      continue;
    }
    out.push(await addLesson(l as FeedbackLesson & { scope: RuleScope }, origin, evidence, dataDir));
  }
}

/** 否决过的规则按否决时间排（不是建规则的顺序）；没有决定记录的排最前 */
function rejectedByTime(profile: CreatorProfile): string[] {
  const at = new Map<string, string>();
  for (const d of profile.ruleDecisions ?? []) if (d.decision === "rejected") at.set(d.ruleId, d.at);
  return profile.writingRules.filter((r) => ruleStatus(r) === "rejected")
    .map((r) => ({ rule: r.rule, at: (r.id && at.get(r.id)) || "" }))
    .sort((a, b) => a.at.localeCompare(b.at)).map((x) => x.rule);
}

const brief = (r: WritingRule) => ({ id: r.id, scope: r.scope ?? "voice_core", rule: r.rule });

/** start 给 AI 判断 new / duplicate / conflict 用：生效（带 id）、待批、最近否决、生效数与上限 */
export function ruleJudgeContext(profile: CreatorProfile, active: WritingRule[]): Record<string, unknown> {
  return {
    rules_detail: active.map(brief),
    pending_rules: profile.writingRules.filter((r) => ruleStatus(r) === "pending").map(brief),
    rejected_rules: rejectedByTime(profile).slice(-REJECTED_SHOWN),
    active_rule_count: activeRuleCount(profile),
    rule_cap: RULE_CAP,
  };
}

/** 这篇产生的、还在待批的手册提案（prepare_final 一起列给创始人） */
async function pendingPlaybookLessons(contentId: string, dataDir?: string): Promise<Array<Record<string, unknown>>> {
  const m = await loadManifest(dataDir);
  return m.playbooks.flatMap((e) => e.proposals.filter((p) => p.status === "pending" && proposalFrom(p, contentId))
    .map((p) => ({ kind: "playbook", proposal_id: p.id, playbook: e.id, playbook_name: e.name, rule: p.lesson ?? p.reason, scope: `playbook:${e.id}`, founder_words: p.founder_words })));
}

/** prepare_final：这篇攒下的、仍待批的规则与手册提案（编号、原话、冲突规则原文），以及「已有但没管住」的那几条 */
export async function pendingLessons(contentId: string, feedback: DraftFeedbackRecord[] | undefined, dataDir?: string): Promise<Record<string, unknown>> {
  const profile = await loadProfile(dataDir);
  const playbook = await pendingPlaybookLessons(contentId, dataDir);
  const rules = profile?.writingRules ?? [];
  const byId = new Map(rules.map((r) => [r.id, r]));
  const pending = rules.filter((r) => r.origin?.content_id === contentId && ruleStatus(r) === "pending");
  const repeatedIds = [...new Set((feedback ?? []).flatMap((f) => f.lessons.filter((l) => l.outcome === "evidence_added" && l.rule_id).map((l) => l.rule_id!)))];
  const ruleLessons = pending.map((r) => {
    const c = r.conflictsWith ? byId.get(r.conflictsWith) : undefined;
    return { kind: "rule", rule_id: r.id, rule: r.rule, scope: r.scope ?? "voice_core", founder_words: r.origin?.founder_words ?? null,
      conflicts_with: c ? { id: c.id, rule: c.rule, status: ruleStatus(c) } : null };
  });
  return {
    pending_lessons: [...ruleLessons, ...playbook].map((l, i) => ({ number: i + 1, ...l })),
    repeated_rules: repeatedIds.map((id) => byId.get(id)).filter((r): r is WritingRule => Boolean(r)).map((r) => ({ ...brief(r), status: ruleStatus(r) })),
    active_rule_count: profile ? activeRuleCount(profile) : 0,
    rule_cap: RULE_CAP,
  };
}
