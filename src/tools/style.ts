/**
 * autocrew_style — LLM-driven style learning tool (PRD §7.2(a))
 *
 * Two actions:
 * - distill: consume EditDiffs and generate new WritingRules
 * - absorb_samples: consume viral sample texts and generate rules
 *
 * 建议在累计 3+ 次编辑后调用 distill（shouldDistillStyle 语义）
 */
import { Type } from "@sinclair/typebox";
import {
  distillStyleRules,
  analyzeStyleSamples,
  type StyleDistillResult,
} from "../modules/learnings/style-distiller.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

export const styleSchema = Type.Object({
  action: Type.Unsafe<"distill" | "absorb_samples">({
    type: "string",
    enum: ["distill", "absorb_samples"],
    description: "distill: consume EditDiffs and generate rules; absorb_samples: consume viral texts",
  }),
  samples: Type.Optional(
    Type.Array(Type.String({ description: "Sample text (1-5 entries, required for absorb_samples)" })),
  ),
});

// ─── Result types ─────────────────────────────────────────────────────────────

type StyleSuccess = {
  ok: true;
  data: StyleDistillResult;
};

type StyleFailure = { ok: false; error: string };
type StyleResult = StyleSuccess | StyleFailure;

// ─── Deps (for testability) ───────────────────────────────────────────────────

export interface StyleDeps {
  distillImpl?: typeof distillStyleRules;
  analyzeImpl?: typeof analyzeStyleSamples;
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateSamples(
  samplesRaw: unknown,
): { ok: true; samples: string[] } | { ok: false; error: string } {
  if (!Array.isArray(samplesRaw)) {
    return { ok: false, error: "缺少必填参数 samples：请提供 1-5 条爆款样本数组" };
  }
  if (samplesRaw.length < 1 || samplesRaw.length > 5) {
    return { ok: false, error: `samples 应包含 1-5 条数据（收到 ${samplesRaw.length} 条）` };
  }
  for (let i = 0; i < samplesRaw.length; i++) {
    const s = samplesRaw[i];
    if (typeof s !== "string" || s.trim() === "") {
      return { ok: false, error: `samples[${i}] 应为非空字符串` };
    }
  }
  return { ok: true, samples: (samplesRaw as string[]).map((s) => s.trim()) };
}

// ─── Core execute ─────────────────────────────────────────────────────────────

export async function executeStyle(
  params: Record<string, unknown>,
  deps: StyleDeps = {},
): Promise<StyleResult> {
  const action = params.action as string;
  const dataDir = (params._dataDir as string) || undefined;

  if (action === "distill") {
    const distillFn = deps.distillImpl ?? distillStyleRules;
    try {
      return { ok: true, data: await distillFn(dataDir) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (action === "absorb_samples") {
    const validated = validateSamples(params.samples);
    if (!validated.ok) return validated;

    const analyzeFn = deps.analyzeImpl ?? analyzeStyleSamples;
    try {
      return { ok: true, data: await analyzeFn(validated.samples, dataDir) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { ok: false, error: `未知 action：${action}。支持：distill | absorb_samples` };
}
