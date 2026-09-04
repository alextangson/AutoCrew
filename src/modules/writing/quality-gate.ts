/**
 * Quality Gate — 生成稿的确定性硬门禁（PRD-v4 §4.3 / P0 附录 0-2，
 * 移植自 muse-social article-derivation 的 5 项硬检查中可判定的 4 项）。
 * 纯函数、零 I/O：FAIL 项由 generate-script 经 submit_script 工具反馈给模型修复。
 */
import type { QualityGateSpec, TrackPack } from "../packs/pack-schema.js";
import type { ClipboardPlatform } from "../publish/clipboard-publisher.js";
import { formatFormatGateFeedback } from "./format-gate.js";
import type { FormatMarkerHit } from "./format-gate.js";
import { formatNumberGateFeedback } from "./number-gate.js";
import type { NumberVerdict } from "./number-gate.js";

export interface GateInput {
  hook: string;
  body: string;
  cta: string;
}

/**
 * `format_markers` / `unverified_numbers` 是**硬门**（P1 §4.4）：包级 QualityGateSpec 之外，
 * 由调用方按稿件形态显式打开；修复轮耗尽后不接受该稿（见 script-payload 的 blocked 状态），
 * 与其余「接受最后一稿并透出未过项」的软项不同。
 */
export interface GateFailure {
  check:
    | "min_chars"
    | "max_chars"
    | "min_data_points"
    | "min_image_tags"
    | "banned_hook"
    | "format_markers"
    | "unverified_numbers";
  detail: string;
}

export const HARD_GATE_CHECKS = new Set<GateFailure["check"]>(["format_markers", "unverified_numbers"]);

/** 镜头/字幕标注 → GateFailure（detail 即模型侧打回文案，写稿与修订两侧同一把尺） */
export function formatMarkerFailure(hits: FormatMarkerHit[]): GateFailure | null {
  if (hits.length === 0) return null;
  return { check: "format_markers", detail: formatFormatGateFeedback(hits) };
}

/** 无据数字 → GateFailure。needsHuman 只是 advisory，单独出现不构成 FAIL。 */
export function unverifiedNumberFailure(verdict: NumberVerdict): GateFailure | null {
  if (verdict.unverified.length === 0) return null;
  return { check: "unverified_numbers", detail: formatNumberGateFeedback(verdict) };
}

/**
 * 有效门禁 = 包级 qualityGate + 平台 maxChars 覆盖（平台上限比包默认更具体）。
 * 两者皆无 → undefined，不跑 gate。
 */
export function resolveQualityGate(
  pack: TrackPack,
  platform: ClipboardPlatform,
): QualityGateSpec | undefined {
  const platformMax = pack.platformAdjustments[platform]?.maxChars;
  if (platformMax === undefined) return pack.qualityGate;
  return { ...pack.qualityGate, maxChars: platformMax };
}

const CJK_RE = /[一-鿿]/g;
/** 数据引用口径：数字 + 量纲/百分比。裸数字不计（无量纲的数据引用本身不合格） */
const DATA_POINT_RE =
  /\d+(?:\.\d+)?\s*(?:%|％|亿|万|千|倍|年|个月|月|天|小时|分钟|元|美元|块|人|次|家|款|条|篇|台|种)/g;
const IMAGE_TAG_RE = /\[IMAGE:[^\]]+\]/g;

export function runQualityGate(spec: QualityGateSpec, input: GateInput): GateFailure[] {
  const failures: GateFailure[] = [];
  const fullText = `${input.hook}\n${input.body}\n${input.cta}`;

  if (spec.minChars !== undefined) {
    const chars = (fullText.match(CJK_RE) ?? []).length;
    if (chars < spec.minChars) {
      failures.push({
        check: "min_chars",
        detail: `中文字符 ${chars} < ${spec.minChars}：补充案例、数据、行业对比或方法论框架，不要注水`,
      });
    }
  }

  if (spec.maxChars !== undefined) {
    const chars = (fullText.match(CJK_RE) ?? []).length;
    if (chars > spec.maxChars) {
      failures.push({
        check: "max_chars",
        detail: `中文字符 ${chars} > ${spec.maxChars}：压缩到上限内——删次要案例与重复论证，保住核心论点和结构`,
      });
    }
  }

  if (spec.minDataPoints !== undefined) {
    const n = (fullText.match(DATA_POINT_RE) ?? []).length;
    if (n < spec.minDataPoints) {
      failures.push({
        check: "min_data_points",
        detail: `数据引用 ${n} 处 < ${spec.minDataPoints}：补入具体数字、百分比、时间点或金额`,
      });
    }
  }

  if (spec.minImageTags !== undefined) {
    const n = (input.body.match(IMAGE_TAG_RE) ?? []).length;
    if (n < spec.minImageTags) {
      failures.push({
        check: "min_image_tags",
        detail: `[IMAGE: prompt] 标记 ${n} 个 < ${spec.minImageTags}：在数据对比、流程说明、概念示意、案例处插入`,
      });
    }
  }

  if (spec.bannedHookPatterns?.length) {
    const hookStart = input.hook.trim();
    for (const src of spec.bannedHookPatterns) {
      if (new RegExp(src).test(hookStart)) {
        failures.push({
          check: "banned_hook",
          detail: `开头命中反模式 /${src}/：用反常识判断、数据震撼或场景代入重写开头`,
        });
        break;
      }
    }
  }

  return failures;
}

export function formatGateFeedback(failures: GateFailure[]): string {
  const lines = failures.map((f) => `- ${f.detail}`);
  return `QUALITY GATE 未通过：\n${lines.join("\n")}\n逐项修复后重新调用 submit_script 提交完整成稿（全文重交，不是只交修改段）。`;
}
