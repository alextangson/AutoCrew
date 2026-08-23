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
import { runQualityGate, formatGateFeedback } from "./quality-gate.js";
import type { GateFailure } from "./quality-gate.js";

export interface SubmitPayload {
  title: string;
  hook: string;
  body: string;
  cta: string;
  hashtags: string[];
}

const TEXT_FIELDS = ["title", "hook", "body", "cta"] as const;
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

export interface Captured {
  payload: SubmitPayload | null;
  gateFailures: GateFailure[];
}

/**
 * Build the submit_script LoopTool; the captured variable is mutated on success.
 * 有 gate 时：字段校验通过后跑 Quality Gate，FAIL 且修复轮未耗尽 → 返回修复指令
 * 打回（复用模型自纠通道）；每稿都先落 captured——loop 提前终止时最后一稿仍可用，
 * 残余 FAIL 经 gateFailures 透出（禁止静默失败）。
 */
export function buildSubmitTool(captured: Captured, gate?: QualityGateSpec): LoopTool {
  let repairRounds = 0;
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
      if (gate) {
        const failures = runQualityGate(gate, result.payload);
        captured.gateFailures = failures;
        if (failures.length > 0 && repairRounds < (gate.maxRepairRounds ?? 2)) {
          repairRounds += 1;
          return formatGateFeedback(failures);
        }
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
