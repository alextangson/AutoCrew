/**
 * 成稿载荷（submit_script）—— 定义、校验、收束工具、组装。
 *
 * 从 generate-script.ts 抽出来的原因只有一个：AI 审稿的**修订轮**是一次独立的 runLoop，
 * 它必须用同一把尺收稿（同字段校验 + 同 Quality Gate 修复轮），否则「修 AI 味把结构改坏了」
 * 这类问题会绕过门禁。写稿与审稿两侧共用本模块，避免二者互相 import 成环。
 */
import type { LoopTool } from "../../engine/loop.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";
import { humanizeZh } from "../humanizer/zh.js";
import {
  runQualityGate,
  formatGateFeedback,
  formatMarkerFailure,
  unverifiedNumberFailure,
  HARD_GATE_CHECKS,
} from "./quality-gate.js";
import type { GateFailure } from "./quality-gate.js";
import { findFormatMarkers } from "./format-gate.js";
import { verifyNumbers } from "./number-gate.js";
import type { LedgerEntry } from "./number-gate.js";

export interface SubmitPayload {
  title: string;
  hook: string;
  body: string;
  cta: string;
  hashtags: string[];
}

const TEXT_FIELDS = ["title", "hook", "body", "cta"] as const;
/**
 * 写手/修订轮的 token 总预算。**不能按 pack 有没有 gate 分叉**：runLoop 缺省只有 20000，
 * 而 v3 角度块 + 12k 研究槽 + 补证块一轮就能用掉——2026-09-05 端到端里抖音稿一轮即 max_tokens，
 * 写手连 submit_script 都没来得及调。
 */
export const WRITER_MAX_TOKENS = 120_000;

export const REQUIRED_FIELDS: (keyof SubmitPayload)[] = [...TEXT_FIELDS, "hashtags"];

function missingField(field: string): string {
  return `Error: 缺少字段 ${field}，请补全后重新调用 submit_script`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

type SubmitValidation = { ok: true; payload: SubmitPayload } | { ok: false; error: string };

/** LLM 输出是不可信边界：缺失/空之外还必须校验类型，否则坏数据存进稿件后才爆。 */
export function validateSubmitArgs(args: Record<string, unknown>): SubmitValidation {
  const text: Record<string, string> = {};
  for (const field of TEXT_FIELDS) {
    const val = args[field];
    if (val === undefined || val === null) return { ok: false, error: missingField(field) };
    if (typeof val !== "string") {
      return { ok: false, error: `Error: 字段 ${field} 应为字符串，请修正后重新调用 submit_script` };
    }
    if (val.trim() === "") return { ok: false, error: missingField(field) };
    text[field] = val;
  }
  const hashtags = args.hashtags;
  if (hashtags === undefined || hashtags === null) return { ok: false, error: missingField("hashtags") };
  if (!isStringArray(hashtags)) {
    return { ok: false, error: "Error: 字段 hashtags 应为字符串数组，请修正后重新调用 submit_script" };
  }
  if (hashtags.length === 0) return { ok: false, error: missingField("hashtags") };
  return {
    ok: true,
    payload: { title: text.title, hook: text.hook, body: text.body, cta: text.cta, hashtags },
  };
}

/** 硬门拦下的原因（P1 §4.4）：needs_evidence 对应稿件状态 `needs_evidence`，不得转 draft_ready */
export interface CaptureBlock {
  reason: "needs_evidence" | "format_markers";
  detail: string;
}

export interface Captured {
  payload: SubmitPayload | null;
  gateFailures: GateFailure[];
  /**
   * 最后一次提交仍被硬门拦下。非空 = `payload` 只是「最后一版」，**不是**可转正的成稿。
   * 修复轮没耗尽时也会置上，模型改好重交才清空——否则 loop 半路终止（模型不再交稿）
   * 会留下一个 blocked 为空、实际带镜头标注/无据数字的稿被当成品收走。
   */
  blocked?: CaptureBlock | null;
  /** 唯一的「这稿能不能当成稿用」判据；软门 FAIL 不影响它（沿用旧行为：接受最后一稿 + 透出未过项） */
  accepted?: boolean;
  /** 模糊量词（十几、数十）：advisory，不拦门，交给审稿与看板展示 */
  needsHumanNumbers?: string[];
}

export function createCapture(): Captured {
  return { payload: null, gateFailures: [], blocked: null, accepted: false, needsHumanNumbers: [] };
}

/** 调用方判 draft_ready 只看这一个函数，不要自己拼条件 */
export function isAcceptedCapture(captured: Captured): boolean {
  return captured.payload !== null && !captured.blocked;
}

/** 硬门依赖：账本用 getter 传，因为写手 `find_evidence` 会在同一轮里往账本里加条目 */
export interface SubmitGateDeps {
  ledger?: () => readonly LedgerEntry[];
  /** 数字硬门开关（§4.4）；开了但没账本 = 没有任何证据，所有数字都会被拦 */
  requireNumberEvidence?: boolean;
  /** 口播格式硬门开关（§4.4，与赛道包无关） */
  forbidFormatMarkers?: boolean;
}

/** 包无 qualityGate 时硬门也要有修复预算（抖音包就没有 gate，codex #22/#12） */
export const DEFAULT_REPAIR_ROUNDS = 2;

function runAllGates(
  payload: SubmitPayload,
  gate: QualityGateSpec | undefined,
  deps: SubmitGateDeps | undefined,
): { failures: GateFailure[]; needsHumanNumbers: string[] } {
  const failures: GateFailure[] = [];
  const needsHumanNumbers: string[] = [];
  if (deps?.forbidFormatMarkers) {
    const failure = formatMarkerFailure(findFormatMarkers(payload));
    if (failure) failures.push(failure);
  }
  if (deps?.requireNumberEvidence) {
    const verdict = verifyNumbers(payload, deps.ledger?.() ?? []);
    needsHumanNumbers.push(...verdict.needsHuman.map((m) => m.raw));
    const failure = unverifiedNumberFailure(verdict);
    if (failure) failures.push(failure);
  }
  if (gate) failures.push(...runQualityGate(gate, payload));
  return { failures, needsHumanNumbers };
}

/** 硬门文案各自完整（自带改法清单），软门走既有 formatGateFeedback 汇总 */
function buildRepairMessage(failures: GateFailure[]): string {
  const hard = failures.filter((f) => HARD_GATE_CHECKS.has(f.check));
  const soft = failures.filter((f) => !HARD_GATE_CHECKS.has(f.check));
  const blocks = hard.map((f) => f.detail);
  if (soft.length > 0) blocks.push(formatGateFeedback(soft));
  return blocks.join("\n\n");
}

/**
 * Build the submit_script LoopTool; the captured variable is mutated on success.
 * 顺序（spec §4.4）：形状 → 口播格式硬门 → 数字硬门 → 质量门；三者**共用同一个修复计数**。
 * FAIL 且修复轮未耗尽 → 返回修复指令打回（复用模型自纠通道）；每稿都先落 captured——
 * loop 提前终止时最后一稿仍可读，残余 FAIL 经 gateFailures 透出（禁止静默失败）。
 * 修复轮耗尽后：软门 FAIL 照旧接受最后一稿；硬门 FAIL 则 `blocked` 置位，稿件不得转正。
 */
export function buildSubmitTool(
  captured: Captured,
  gate?: QualityGateSpec,
  deps?: SubmitGateDeps,
): LoopTool {
  let repairRounds = 0;
  const maxRepairRounds = gate?.maxRepairRounds ?? DEFAULT_REPAIR_ROUNDS;
  return {
    name: "submit_script",
    description: "提交最终成稿。所有字段必填。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "标题" },
        hook: { type: "string", description: "开篇钩子" },
        body: { type: "string", description: "正文内容" },
        cta: { type: "string", description: "行动号召/引导语结尾" },
        hashtags: { type: "array", items: { type: "string" }, description: "话题标签/关键词列表" },
      },
      required: REQUIRED_FIELDS,
    },
    execute(args) {
      const result = validateSubmitArgs(args);
      if (!result.ok) return result.error;
      // Last valid submission wins — a corrected resubmission replaces the earlier capture.
      captured.payload = result.payload;
      const { failures, needsHumanNumbers } = runAllGates(result.payload, gate, deps);
      captured.gateFailures = failures;
      captured.needsHumanNumbers = needsHumanNumbers;
      const hard = failures.filter((f) => HARD_GATE_CHECKS.has(f.check));
      captured.blocked =
        hard.length > 0
          ? {
              reason: hard[0].check === "format_markers" ? "format_markers" : "needs_evidence",
              detail: hard[0].detail,
            }
          : null;
      captured.accepted = isAcceptedCapture(captured);
      if (failures.length > 0 && repairRounds < maxRepairRounds) {
        repairRounds += 1;
        return buildRepairMessage(failures);
      }
      if (hard.length > 0) {
        return `修复轮已用尽，硬门仍未通过——本稿不作为成稿收下（状态 ${captured.blocked?.reason}）。未过项：\n${buildRepairMessage(hard)}`;
      }
      return "已收到脚本";
    },
  };
}

/** hook + 正文 + CTA 的组装口径（成稿正文的唯一定义，写稿与审稿修订共用） */
export function assembleScript(payload: SubmitPayload): string {
  return `${payload.hook}\n\n${payload.body}\n\n${payload.cta}`;
}

/**
 * 组装 + 正则去 AI 味 = 终稿形态（审稿 spec §2.1：正则在前，审稿读的是正则改写**后**的文本，
 * 终稿不会再被审稿没见过的替换动过）。写稿一次、每轮修订一次，口径必须是同一个函数。
 */
export function assembleAndHumanize(payload: SubmitPayload): string {
  return humanizeZh({ text: assembleScript(payload) }).humanizedText;
}
