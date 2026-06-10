/**
 * Style Distiller — LLM-driven writing rule extraction (PRD §7.2(a))
 *
 * Replaces the 8-regex rule-distiller with fastModel + submit_rules structured output.
 * Input: EditDiffs (or viral sample texts) → new WritingRules added to CreatorProfile.
 * State: <dataDir>/learnings/distill-state.json { lastDistilledAt: ISO }
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runLoop } from "../../engine/loop.js";
import type { LoopTool } from "../../engine/loop.js";
import { loadEngineConfig } from "../../engine/config.js";
import { getDataDir } from "../../storage/local-store.js";
import { listDiffs } from "./diff-tracker.js";
import type { EditDiff } from "./diff-tracker.js";
import { loadProfile, addWritingRule } from "../profile/creator-profile.js";
import type { WritingRule } from "../profile/creator-profile.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StyleDistillResult {
  newRules: WritingRule[];
  skippedDuplicates: number;
  /** distillStyleRules: diffs consumed; analyzeStyleSamples: samples consumed */
  diffsAnalyzed: number;
  summary: string;
}

// ─── State helpers ────────────────────────────────────────────────────────────

interface DistillState {
  lastDistilledAt?: string;
}

async function readState(dataDir?: string): Promise<DistillState> {
  const p = statePath(dataDir);
  try {
    return JSON.parse(await fs.readFile(p, "utf-8")) as DistillState;
  } catch {
    return {};
  }
}

async function writeState(state: DistillState, dataDir?: string): Promise<void> {
  const p = statePath(dataDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(state, null, 2), "utf-8");
}

function statePath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "learnings", "distill-state.json");
}

// ─── submit_rules tool ────────────────────────────────────────────────────────

interface RuleInput {
  rule: string;
  evidence: string;
  confidence: number;
}

type SubmitValidation =
  | { ok: true; rules: RuleInput[] }
  | { ok: false; error: string };

function validateRules(args: Record<string, unknown>): SubmitValidation {
  if (!Array.isArray(args.rules)) {
    return { ok: false, error: "Error: rules 应为数组，请修正后重新调用 submit_rules" };
  }
  const out: RuleInput[] = [];
  for (const item of args.rules as unknown[]) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, error: "Error: rules 每项应为对象，请修正后重新调用 submit_rules" };
    }
    const r = item as Record<string, unknown>;
    if (typeof r.rule !== "string" || r.rule.trim() === "") {
      return { ok: false, error: "Error: rule 字段应为非空字符串，请修正后重新调用 submit_rules" };
    }
    if (typeof r.evidence !== "string") {
      return { ok: false, error: "Error: evidence 字段应为字符串，请修正后重新调用 submit_rules" };
    }
    if (typeof r.confidence !== "number") {
      return { ok: false, error: "Error: confidence 字段应为数值，请修正后重新调用 submit_rules" };
    }
    if (r.confidence < 0 || r.confidence > 1) {
      return {
        ok: false,
        error: `Error: confidence 应在 [0,1] 范围内（收到 ${r.confidence}），请修正后重新调用 submit_rules`,
      };
    }
    out.push({ rule: r.rule.trim(), evidence: String(r.evidence), confidence: r.confidence });
  }
  return { ok: true, rules: out };
}

function buildSubmitTool(captured: { rules: RuleInput[] | null }): LoopTool {
  return {
    name: "submit_rules",
    description: "提交分析出的写作规则，每次最多 3 条。",
    parameters: {
      type: "object",
      properties: {
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rule: { type: "string", description: "中文祈使句，具体可执行" },
              evidence: { type: "string", description: "引自 diff 的具体证据" },
              confidence: { type: "number", description: "0-1 模型把握度" },
            },
            required: ["rule", "evidence", "confidence"],
          },
        },
      },
      required: ["rules"],
    },
    execute(args) {
      const result = validateRules(args);
      if (!result.ok) return result.error;
      captured.rules = result.rules.slice(0, 3);
      return "已收到规则";
    },
  };
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildDiffSystemPrompt(): string {
  return [
    "你是一位专业的内容风格分析师。",
    "根据用户提供的编辑前后对照和现有规则，",
    "提炼最多 3 条新的写作偏好规则。",
    "要求：中文祈使句；具体可执行；",
    "不与现有规则语义重复；每条附 evidence（引自 diff 的具体片段）和 confidence（0-1）。",
    "完成后调用 submit_rules 提交。",
  ].join("\n");
}

function buildSamplesSystemPrompt(): string {
  return [
    "你是一位专业的内容风格分析师。",
    "根据用户提供的爆款样本文本，",
    "提炼最多 3 条写作偏好规则（用词癖好/句子节奏/招牌短语）。",
    "要求：中文祈使句；具体可执行；每条附 evidence 和 confidence（0-1）。",
    "完成后调用 submit_rules 提交。",
  ].join("\n");
}

function buildDiffUserMessage(diffs: EditDiff[], existingRules: WritingRule[]): string {
  const rulesText =
    existingRules.length > 0
      ? existingRules.map((r) => `- ${r.rule}`).join("\n")
      : "（暂无）";
  const diffsText = diffs
    .map(
      (d, i) =>
        `【diff ${i + 1}】\nbefore：${d.before.slice(0, 400)}\nafter：${d.after.slice(0, 400)}`,
    )
    .join("\n\n");
  return `现有规则：\n${rulesText}\n\n编辑记录：\n${diffsText}`;
}

function buildSamplesUserMessage(samples: string[], existingRules: WritingRule[]): string {
  const rulesText =
    existingRules.length > 0
      ? existingRules.map((r) => `- ${r.rule}`).join("\n")
      : "（暂无）";
  const samplesText = samples
    .map((s, i) => `【样本 ${i + 1}】\n${s.slice(0, 600)}`)
    .join("\n\n");
  return `现有规则：\n${rulesText}\n\n爆款样本：\n${samplesText}`;
}

// ─── Persist helpers ──────────────────────────────────────────────────────────

async function persistRules(
  rules: RuleInput[],
  dataDir?: string,
): Promise<{ newRules: WritingRule[]; skipped: number }> {
  const profile = await loadProfile(dataDir);
  const existingTexts = new Set((profile?.writingRules ?? []).map((r) => r.rule));

  const newRules: WritingRule[] = [];
  let skipped = 0;

  for (const r of rules) {
    if (existingTexts.has(r.rule)) {
      skipped++;
      continue;
    }
    const written = await addWritingRule(
      { rule: r.rule, source: "auto_distilled", confidence: r.confidence },
      dataDir,
    );
    const added = written.writingRules.find((w) => w.rule === r.rule);
    if (added) {
      newRules.push(added);
      existingTexts.add(r.rule);
    }
  }

  return { newRules, skipped };
}

function buildSummary(newRules: WritingRule[], evidences: string[]): string {
  if (newRules.length === 0) return "🎯 本轮未发现新风格偏好";
  const lines = newRules
    .map((r, i) => `${r.rule}（依据：${evidences[i] ?? ""}）`)
    .join("；");
  return `🎯 学到 ${newRules.length} 条新偏好：${lines}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function distillStyleRules(
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<StyleDistillResult> {
  const state = await readState(dataDir);
  const allDiffs = await listDiffs(undefined, dataDir);
  const newDiffs = state.lastDistilledAt
    ? allDiffs.filter((d) => d.createdAt > state.lastDistilledAt!)
    : allDiffs;

  if (newDiffs.length === 0) {
    return { newRules: [], skippedDuplicates: 0, diffsAnalyzed: 0, summary: "🎯 暂无新编辑记录" };
  }

  const [config, profile] = await Promise.all([
    loadEngineConfig(dataDir),
    loadProfile(dataDir),
  ]);
  const existingRules = profile?.writingRules ?? [];

  const captured: { rules: RuleInput[] | null } = { rules: null };
  const submitTool = buildSubmitTool(captured);
  const loopFn = deps?.runLoopImpl ?? runLoop;

  await loopFn(config, {
    model: config.fastModel,
    systemPrompt: buildDiffSystemPrompt(),
    userMessage: buildDiffUserMessage(newDiffs, existingRules),
    tools: [submitTool],
    maxTurns: 3,
  });

  if (!captured.rules) {
    throw new Error("风格蒸馏失败：模型未调用 submit_rules 工具提交规则");
  }

  const { newRules, skipped } = await persistRules(captured.rules, dataDir);

  // Update state to latest diff timestamp
  const latestTs = newDiffs.reduce((max, d) => (d.createdAt > max ? d.createdAt : max), "");
  await writeState({ lastDistilledAt: latestTs }, dataDir);

  const evidences = captured.rules.slice(0, newRules.length).map((r) => r.evidence);
  return {
    newRules,
    skippedDuplicates: skipped,
    diffsAnalyzed: newDiffs.length,
    summary: buildSummary(newRules, evidences),
  };
}

export async function analyzeStyleSamples(
  samples: string[],
  dataDir?: string,
  deps?: { runLoopImpl?: typeof runLoop },
): Promise<StyleDistillResult> {
  if (samples.length === 0) {
    throw new Error("samples 不能为空：请提供 1-5 条爆款样本");
  }

  const [config, profile] = await Promise.all([
    loadEngineConfig(dataDir),
    loadProfile(dataDir),
  ]);
  const existingRules = profile?.writingRules ?? [];

  const captured: { rules: RuleInput[] | null } = { rules: null };
  const submitTool = buildSubmitTool(captured);
  const loopFn = deps?.runLoopImpl ?? runLoop;

  await loopFn(config, {
    model: config.fastModel,
    systemPrompt: buildSamplesSystemPrompt(),
    userMessage: buildSamplesUserMessage(samples, existingRules),
    tools: [submitTool],
    maxTurns: 3,
  });

  if (!captured.rules) {
    throw new Error("样本分析失败：模型未调用 submit_rules 工具提交规则");
  }

  const { newRules, skipped } = await persistRules(captured.rules, dataDir);
  const evidences = captured.rules.slice(0, newRules.length).map((r) => r.evidence);
  return {
    newRules,
    skippedDuplicates: skipped,
    diffsAnalyzed: samples.length,
    summary: buildSummary(newRules, evidences),
  };
}

export async function shouldDistillStyle(dataDir?: string): Promise<boolean> {
  const state = await readState(dataDir);
  const allDiffs = await listDiffs(undefined, dataDir);
  const newDiffs = state.lastDistilledAt
    ? allDiffs.filter((d) => d.createdAt > state.lastDistilledAt!)
    : allDiffs;
  return newDiffs.length >= 3;
}
