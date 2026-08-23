/**
 * AI 审稿 agent（审稿 spec §2）——写稿 loop 收束**之后**的独立收敛循环。
 *
 * 顺序（§2.1）：submit_script 通过 → 组装 → humanizeZh → **审稿** →（有 blocker 时）修订轮
 * → 修订稿重跑 humanizeZh + Quality Gate → 再审 → 违禁词扫描 → 转正。
 * 正则在前：审稿读的是正则改写后的终稿形态，终稿不会再被审稿没见过的替换动过。
 *
 * 三条纪律：
 * 1. **审稿永不弄死写作**：LLM 挂了、schema 违约、轮次耗尽、墙钟到点——统一降级成
 *    `review.status` 留痕，用最后一版过 gate 的稿转正（同写作入口调研闸口的纪律）。
 *    本模块任何路径都不抛。
 * 2. **修订必须重过 gate**：「AI 味修好了但结构改坏了」要当轮抓住，所以修订轮的收束工具
 *    就是写稿那把 submit_script（含 gate 修复轮），gate 仍 FAIL 即整轮作废、回退上一版。
 * 3. **引文必须能定位**：quote 回原文校验，指不到位置的 issue 是幻觉，整份结论打回自纠。
 */
import { resolveEngineRoute, type EngineConfig } from "../../engine/config.js";
import { runLoop, type LoopTool } from "../../engine/loop.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";
import type { GateFailure } from "./quality-gate.js";
import {
  assembleAndHumanize,
  buildSubmitTool,
  type Captured,
  type SubmitPayload,
} from "./script-payload.js";
import {
  buildReviewSystemPrompt,
  buildReviewUserMessage,
  buildRevisionUserMessage,
} from "./script-review-prompt.js";

// ─── 契约 ────────────────────────────────────────────────────────────────────

export type ReviewSeverity = "blocker" | "advisory";

export interface ReviewIssue {
  id: string;
  severity: ReviewSeverity;
  /** 原文定位引文（逐字，代码回原文校验） */
  quote: string;
  /** 判据名，如「排比轰炸」——回看时一眼知道被判了哪一条 */
  rule: string;
  instruction: string;
}

/**
 * passed = 一轮过；revised = 修订后过；failed = 审出问题但没修成（残留在 issues）；
 * skipped = 压根没审成（LLM 挂了/首轮就到点）；stale = 稿子在审稿之后被改过（§2.7）。
 */
export type ReviewStatus = "passed" | "revised" | "failed" | "skipped" | "stale";

export interface ReviewMeta {
  status: ReviewStatus;
  /** 实际发生的修订轮数 */
  rounds: number;
  /** 已交付修订轮处理的 blocker 条数——版本注记与稿卡徽章的 N 用它（spec 只写了 N，没写它从哪儿来） */
  fixed: number;
  /** 最后一轮审稿的结论：残留 blocker + advisory */
  issues: ReviewIssue[];
  reviewedAt: string;
}

export interface ReviewInput {
  payload: SubmitPayload;
  /** 组装 + humanizeZh 之后的终稿正文 */
  humanizedText: string;
  /** 写稿时的 system prompt（人格/包规则/gate 阈值都在里面），修订轮原样复用 */
  system: string;
  /** 写稿时的 user prompt（选题 + 调研槽 + 对标卡），修订轮复用以保住「同批材料」 */
  user: string;
  /**
   * 本稿注入过的调研材料（含简报块）；缺席 = 不判证据深度维度（§2.4）。
   * R2 接点：选中角度卡（thesis/antiScope）在这里并列加一个 `angle?` 字段，
   * 判据随之从「有没有论点」升到「thesis 论证了吗、antiScope 守住了吗」。
   */
  researchSlot?: string;
  voiceSamples: string[];
  gate?: QualityGateSpec;
  platform: string;
}

export interface ReviewDeps {
  runLoopImpl?: typeof runLoop;
  /** 整阶段墙钟；缺省 5 分钟 */
  deadlineMs?: number;
  nowImpl?: () => number;
  runId?: string;
  /** 降级出口：审稿是增益，降级了必须有人话留痕，默认 console.warn */
  onWarn?: (message: string) => void;
}

export interface ReviewOutcome {
  payload: SubmitPayload;
  humanizedText: string;
  /** 采纳了修订稿时 = 修订稿的 gate 结果（必为空）；没换稿时缺席 = 沿用写稿轮的 */
  gateFailures?: GateFailure[];
  review: ReviewMeta;
}

/** 整阶段墙钟上限 5 分钟（§2.2 硬闸：runLoop 的 token 限额只是轮前软检查） */
export const DEFAULT_REVIEW_DEADLINE_MS = 300_000;
/** 修订上限 2 轮（§2.2）——再多就是无限润色 */
const MAX_REVISION_ROUNDS = 2;
/** malformed 自纠 1 轮（§2.3） */
const MAX_REVIEW_REPAIRS = 1;
const REVIEW_MAX_TURNS = 4;
const REVIEW_MAX_TOKENS = 40_000;

// ─── submit_review：校验（代码侧，模型说了不算） ─────────────────────────────

interface ReviewCapture {
  verdict: "pass" | "revise" | null;
  issues: ReviewIssue[];
  attempts: number;
  problems: string[];
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const objList = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

/** 引文定位：先逐字找，找不到再按「忽略空白」找一次（模型换行重排不算幻觉） */
function locatable(haystack: string, quote: string): boolean {
  if (haystack.includes(quote)) return true;
  const strip = (s: string) => s.replace(/\s+/g, "");
  return strip(haystack).includes(strip(quote));
}

function readIssues(raw: unknown, haystack: string, round: number, problems: string[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (const [i, item] of objList(raw).entries()) {
    const severity = str(item.severity) === "blocker" ? "blocker" : str(item.severity) === "advisory" ? "advisory" : null;
    const quote = str(item.quote);
    const rule = str(item.rule);
    const instruction = str(item.instruction);
    if (!severity) problems.push(`issues[${i}].severity 只能是 "blocker" 或 "advisory"`);
    if (!rule) problems.push(`issues[${i}].rule 为空：写上判据名`);
    if (!instruction) problems.push(`issues[${i}].instruction 为空：写清楚怎么改，不是只说哪里不好`);
    if (!quote) {
      problems.push(`issues[${i}].quote 为空：必须给一段原文引文用于定位`);
    } else if (!locatable(haystack, quote)) {
      problems.push(`issues[${i}].quote「${quote.slice(0, 20)}…」在稿件里找不到——只能逐字复制原文，不要改写或凭印象写`);
    }
    if (severity && quote && rule && instruction && locatable(haystack, quote)) {
      issues.push({ id: str(item.id) || `r${round}-${i + 1}`, severity, quote, rule, instruction });
    }
  }
  return issues;
}

type Checked = { ok: true; verdict: "pass" | "revise"; issues: ReviewIssue[] } | { ok: false; problems: string[] };

function validateReview(args: Record<string, unknown>, haystack: string, round: number): Checked {
  const problems: string[] = [];
  const raw = str(args.verdict).toLowerCase();
  const verdict = raw === "pass" || raw === "revise" ? raw : null;
  if (!verdict) problems.push('verdict 只能是 "pass" 或 "revise"');
  const issues = readIssues(args.issues, haystack, round, problems);
  if (verdict === "revise" && issues.length === 0) {
    problems.push("verdict=revise 必须附至少一条 issue（可定位的 quote + 具体的 instruction）");
  }
  if (problems.length || !verdict) return { ok: false, problems };
  return { ok: true, verdict, issues };
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"], description: "有 blocker 就 revise，否则 pass" },
    issues: {
      type: "array",
      description: "逐条问题；pass 时可只带 advisory，也可为空",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "本条编号，可留空" },
          severity: { type: "string", enum: ["blocker", "advisory"], description: "blocker 会被打回重写" },
          quote: { type: "string", description: "从稿件逐字复制的短句，用于定位问题所在" },
          rule: { type: "string", description: "判据名，如「排比轰炸」「论点只是材料复述」" },
          instruction: { type: "string", description: "具体怎么改" },
        },
        required: ["severity", "quote", "rule", "instruction"],
      },
    },
  },
  required: ["verdict", "issues"],
};

function buildReviewTool(capture: ReviewCapture, haystack: string, round: number): LoopTool {
  return {
    name: "submit_review",
    description: "提交本轮审稿结论。一次交齐，交完即结束。",
    parameters: REVIEW_SCHEMA,
    execute(args) {
      capture.attempts += 1;
      const checked = validateReview(args, haystack, round);
      if (checked.ok) {
        capture.verdict = checked.verdict;
        capture.issues = checked.issues;
        return "已收到审稿结论";
      }
      capture.problems = checked.problems;
      // 自纠只给一轮：再坏下去就是模型看不懂稿子，继续磨只会烧 token（§2.3）
      if (capture.attempts > MAX_REVIEW_REPAIRS) return "审稿结论仍不合格，本轮审稿作废，不要再调用 submit_review。";
      return `Error: 审稿结论不合格：\n${checked.problems.map((p) => `- ${p}`).join("\n")}\n修正后重新调用 submit_review。`;
    },
  };
}

// ─── 两个 pass ───────────────────────────────────────────────────────────────

interface Draft {
  payload: SubmitPayload;
  humanizedText: string;
  /** 只有换成修订稿时才有值（必空数组）——写稿轮的 gate 结果由调用方持有 */
  gateFailures?: GateFailure[];
}

type ReviewPass = { ok: true; issues: ReviewIssue[] } | { ok: false; reason: string };
type RevisionPass = { ok: true; draft: Draft } | { ok: false; reason: string };

/** 审一轮。永不抛：审稿失败只是「这轮没审成」，不是写作失败。 */
async function reviewOnce(
  input: ReviewInput,
  draft: Draft,
  config: EngineConfig,
  deps: ReviewDeps,
  round: number,
): Promise<ReviewPass> {
  const capture: ReviewCapture = { verdict: null, issues: [], attempts: 0, problems: [] };
  // 标题也进定位面：标题里的 AI 味同样要判，quote 指到标题必须找得到
  const haystack = `${draft.payload.title}\n\n${draft.humanizedText}`;
  const reviewer = resolveEngineRoute(config, "reviewer", config.strongModel);
  try {
    const result = await (deps.runLoopImpl ?? runLoop)(reviewer.config, {
      model: reviewer.model,
      systemPrompt: buildReviewSystemPrompt(Boolean(input.researchSlot?.trim())),
      userMessage: buildReviewUserMessage({
        payload: draft.payload,
        humanizedText: draft.humanizedText,
        ...(input.researchSlot ? { researchSlot: input.researchSlot } : {}),
        voiceSamples: input.voiceSamples,
        platform: input.platform,
      }),
      tools: [buildReviewTool(capture, haystack, round)],
      maxTurns: REVIEW_MAX_TURNS,
      maxTotalTokens: REVIEW_MAX_TOKENS,
      logMeta: { ...(deps.runId ? { runId: deps.runId } : {}), agent: "reviewer" },
    });
    if (capture.verdict) return { ok: true, issues: capture.issues };
    return {
      ok: false,
      reason:
        capture.attempts === 0
          ? `审稿模型没有调用 submit_review（loop ${result.stopReason}，turns=${result.turns}）`
          : `审稿结论不合格：${capture.problems.join("；")}`,
    };
  } catch (err) {
    return { ok: false, reason: `审稿调用失败：${errText(err)}` };
  }
}

/** 修一轮：写稿的 system + 同批材料 + blocker 清单，收束工具是同一把 submit_script（带 gate）。 */
async function reviseOnce(
  input: ReviewInput,
  draft: Draft,
  blockers: ReviewIssue[],
  config: EngineConfig,
  deps: ReviewDeps,
): Promise<RevisionPass> {
  const captured: Captured = { payload: null, gateFailures: [] };
  const writer = resolveEngineRoute(config, "writer", config.strongModel);
  const gate = input.gate;
  try {
    const result = await (deps.runLoopImpl ?? runLoop)(writer.config, {
      model: writer.model,
      systemPrompt: input.system,
      userMessage: buildRevisionUserMessage(draft.payload, blockers, input.user),
      tools: [buildSubmitTool(captured, gate)],
      maxTurns: gate ? 4 + (gate.maxRepairRounds ?? 2) * 2 : 4,
      maxTotalTokens: gate ? 80000 : undefined,
      logMeta: { ...(deps.runId ? { runId: deps.runId } : {}), agent: "reviser" },
    });
    if (!captured.payload) {
      return { ok: false, reason: `修订轮没有提交成稿（loop ${result.stopReason}，turns=${result.turns}）` };
    }
    if (captured.gateFailures.length > 0) {
      // 修订把结构改坏了：整轮作废，回退到修订前那版（§2.2 每轮重验的全部意义）
      return { ok: false, reason: `修订稿仍未过 Quality Gate：${captured.gateFailures.map((f) => f.check).join("、")}` };
    }
    return {
      ok: true,
      draft: { payload: captured.payload, humanizedText: assembleAndHumanize(captured.payload), gateFailures: [] },
    };
  } catch (err) {
    return { ok: false, reason: `修订调用失败：${errText(err)}` };
  }
}

// ─── 收敛循环 ────────────────────────────────────────────────────────────────

const DEADLINE = Symbol("review-deadline");

/**
 * 墙钟竞速（同视角调研的取舍）：runLoop 不可中断，到点只能**丢弃结果**——底层那轮请求会
 * 自然跑完（token 上限兜底）。work 契约上永不 reject，所以竞速输了也不会有掉在地上的 rejection。
 * 传 thunk 不传 promise：已经到点时连这轮请求都不该发出去。
 */
async function withDeadline<T>(start: () => Promise<T>, remainingMs: number): Promise<T | typeof DEADLINE> {
  if (remainingMs <= 0) return DEADLINE;
  const work = start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE), remainingMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function settle(
  draft: Draft,
  status: ReviewStatus,
  rounds: number,
  fixed: number,
  issues: ReviewIssue[],
): ReviewOutcome {
  return {
    payload: draft.payload,
    humanizedText: draft.humanizedText,
    ...(draft.gateFailures ? { gateFailures: draft.gateFailures } : {}),
    // reviewedAt 用真实时钟：nowImpl 是给墙钟算差用的，测试里的假时钟不该变成稿件上的假时间
    review: { status, rounds, fixed, issues, reviewedAt: new Date().toISOString() },
  };
}

/**
 * 审 →（有 blocker 就）修 → 再审，直到 pass / 轮次耗尽 / 墙钟到点。
 * 返回的永远是**最后一版过 gate 的稿**——降级时它就是原稿。
 */
export async function reviewAndConverge(
  input: ReviewInput,
  config: EngineConfig,
  deps: ReviewDeps = {},
): Promise<ReviewOutcome> {
  const now = deps.nowImpl ?? Date.now;
  const startedAt = now();
  const deadlineMs = deps.deadlineMs ?? DEFAULT_REVIEW_DEADLINE_MS;
  const remaining = () => deadlineMs - (now() - startedAt);
  const warn = deps.onWarn ?? ((message: string) => console.warn(`[script-review] ${message}`));

  let draft: Draft = { payload: input.payload, humanizedText: input.humanizedText };
  let issues: ReviewIssue[] = [];
  let rounds = 0;
  let fixed = 0;

  for (;;) {
    const pass = await withDeadline(() => reviewOnce(input, draft, config, deps, rounds), remaining());
    if (pass === DEADLINE || !pass.ok) {
      const reason = pass === DEADLINE ? `审稿超时（${Math.round(deadlineMs / 1000)} 秒）` : pass.reason;
      // 首轮就没审成 = 这稿压根没经 AI 审稿；已经修过再失手 = 审出过问题但收不了尾
      warn(rounds === 0 ? `本稿未经 AI 审稿：${reason}` : `审稿未能收尾（已修订 ${rounds} 轮）：${reason}`);
      return settle(draft, rounds === 0 ? "skipped" : "failed", rounds, fixed, issues);
    }
    issues = pass.issues;
    // 打不打回由**代码**按 blocker 判，不看模型自报的 verdict：说 pass 却列了 blocker 要打回，
    // 说 revise 却只有 advisory 不打回（§2.3 修订轮只处理 blocker，防无限润色）。
    const blockers = issues.filter((i) => i.severity === "blocker");
    if (blockers.length === 0) return settle(draft, rounds === 0 ? "passed" : "revised", rounds, fixed, issues);
    if (rounds >= MAX_REVISION_ROUNDS) {
      warn(`修订 ${rounds} 轮后仍有 ${blockers.length} 项 blocker，按残留转正`);
      return settle(draft, "failed", rounds, fixed, issues);
    }
    const revised = await withDeadline(() => reviseOnce(input, draft, blockers, config, deps), remaining());
    if (revised === DEADLINE || !revised.ok) {
      warn(revised === DEADLINE ? "修订超时，丢弃在途修订，用最后一版过 gate 的稿" : `修订失败：${revised.reason}`);
      return settle(draft, "failed", rounds, fixed, issues);
    }
    if (remaining() <= 0) {
      // 修订跑完了但墙钟已过：结果作废（同上，到点即丢），用上一版转正
      warn("修订跑完时墙钟已到点，丢弃在途修订，用最后一版过 gate 的稿");
      return settle(draft, "failed", rounds, fixed, issues);
    }
    draft = revised.draft;
    rounds += 1;
    fixed += blockers.length;
  }
}
