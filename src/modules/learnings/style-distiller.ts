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
import { updateProfile, loadProfile, addWritingRule } from "../profile/creator-profile.js";
import type { WritingRule, RuleScope } from "../profile/creator-profile.js";

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
  /** 纠正路由（PRD-v4 §4.3）：省略 = voice_core */
  scope?: RuleScope;
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
    // Number.isFinite rejects non-numbers AND NaN/Infinity — typeof NaN === "number" would slip through
    if (!Number.isFinite(r.confidence)) {
      return { ok: false, error: "Error: confidence 字段应为有限数值，请修正后重新调用 submit_rules" };
    }
    const confidence = r.confidence as number;
    if (confidence < 0 || confidence > 1) {
      return {
        ok: false,
        error: `Error: confidence 应在 [0,1] 范围内（收到 ${confidence}），请修正后重新调用 submit_rules`,
      };
    }
    if (r.scope !== undefined) {
      if (typeof r.scope !== "string" || (r.scope !== "voice_core" && !r.scope.startsWith("platform:"))) {
        return {
          ok: false,
          error: `Error: scope 应为 "voice_core" 或 "platform:<平台id>"（收到 ${String(r.scope)}），请修正后重新调用 submit_rules`,
        };
      }
    }
    out.push({
      rule: r.rule.trim(),
      evidence: r.evidence,
      confidence,
      ...(r.scope !== undefined ? { scope: r.scope as RuleScope } : {}),
    });
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
              scope: {
                type: "string",
                description:
                  "规则作用域：证据只来自单一已知平台时填 platform:<平台id>（如 platform:wechat_mp）；跨平台声音特征（用词癖好/口头禅/立场/禁忌）或平台未知时填 voice_core 或省略",
              },
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
    "每条规则标注 scope：证据只来自单一已知平台且属于该平台的形式规范（长度/结构/格式/标签惯例）→ platform:<平台id>；",
    "属于跨平台的声音特征（用词癖好/口头禅/立场/禁忌），或证据横跨多个平台，或平台未知 → voice_core。",
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
        `【diff ${i + 1}｜平台：${d.platform ?? "未知"}】\nbefore：${d.before.slice(0, 400)}\nafter：${d.after.slice(0, 400)}`,
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
  forceScope?: RuleScope,
): Promise<{ newRules: WritingRule[]; skipped: number }> {
  const profile = await loadProfile(dataDir);
  const existingTexts = new Set((profile?.writingRules ?? []).map((r) => r.rule));

  const newRules: WritingRule[] = [];
  let skipped = 0;

  for (const r of rules) {
    const scope = forceScope ?? r.scope;
    if (existingTexts.has(r.rule)) {
      // 仍走 addWritingRule：同文本跨平台重现会触发升格路由（§4.3），不是简单跳过
      await addWritingRule(
        { rule: r.rule, source: "auto_distilled", confidence: r.confidence, ...(scope ? { scope } : {}) },
        dataDir,
      );
      skipped++;
      continue;
    }
    const written = await addWritingRule(
      { rule: r.rule, source: "auto_distilled", confidence: r.confidence, ...(scope ? { scope } : {}) },
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

/** Evidence keyed by rule text — positional alignment breaks when duplicates are skipped mid-array. */
function buildSummary(newRules: WritingRule[], evidenceByRule: Map<string, string>): string {
  if (newRules.length === 0) return "🎯 本轮未发现新风格偏好";
  const lines = newRules
    .map((r) => `${r.rule}（依据：${evidenceByRule.get(r.rule) ?? ""}）`)
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
    logMeta: { agent: "writer" },
  });

  if (!captured.rules) {
    throw new Error("风格蒸馏失败：模型未调用 submit_rules 工具提交规则");
  }

  const { newRules, skipped } = await persistRules(captured.rules, dataDir);

  // Update state to latest diff timestamp
  const latestTs = newDiffs.reduce((max, d) => (d.createdAt > max ? d.createdAt : max), "");
  await writeState({ lastDistilledAt: latestTs }, dataDir);

  const evidenceByRule = new Map(captured.rules.map((r) => [r.rule, r.evidence]));
  return {
    newRules,
    skippedDuplicates: skipped,
    diffsAnalyzed: newDiffs.length,
    summary: buildSummary(newRules, evidenceByRule),
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
    logMeta: { agent: "writer" },
  });

  if (!captured.rules) {
    throw new Error("样本分析失败：模型未调用 submit_rules 工具提交规则");
  }

  // 校准样本产出 = 声音内核种子（PRD-v4 §4.3：代表作蒸馏的是"你的声音"，非平台规范）
  const { newRules, skipped } = await persistRules(captured.rules, dataDir, "voice_core");
  // V5.1:代表作吸收成功 = 声音校准完成。此前 styleCalibrated 全库无写入路径,
  // "已校准"态不可达,dashboard 校准卡永远停在未完成。
  if (newRules.length > 0 || skipped > 0) {
    await updateProfile({ styleCalibrated: true }, dataDir);
  }
  const evidenceByRule = new Map(captured.rules.map((r) => [r.rule, r.evidence]));
  return {
    newRules,
    skippedDuplicates: skipped,
    diffsAnalyzed: samples.length,
    summary: buildSummary(newRules, evidenceByRule),
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
