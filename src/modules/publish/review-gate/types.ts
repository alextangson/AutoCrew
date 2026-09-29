/** 发布前把关（spec 2026-09-29-publish-review-gate）的结果形状 */

/**
 * 单项结论：
 * - block：确定性拦截（`overridable` 为 true 时可被 §7 例外改判 override）；
 * - warn：提醒（Jev 一律 warn）；
 * - unchecked / not_run：没检查 / 没跑成——单列，不算通过；
 * - info：必须做但不是判定的事（如 B站 16:9 裁切核对），不影响平台结论。
 */
export type ItemResult = "pass" | "warn" | "block" | "override" | "unchecked" | "not_run" | "info";

export interface CheckItem {
  check: string;
  result: ItemResult;
  /** 依据：规则原文 / 原话 / 登记记录——代码拼，不让 Jev 编解释（E5） */
  basis: string;
  /** 计划字段（或 Jev B 里约束的字段） */
  field?: string;
  plan_value?: unknown;
  /** 可例外的确定性规则名（overrides[].rule 用它） */
  rule?: string;
  overridable?: boolean;
  /** 被例外改判时的原话 */
  override_quote?: string;
  jev?: { question: string; answer: string | number; probability: number };
}

export type Verdict = "pass" | "warn" | "block" | "override";

export interface Override { platform: string; rule: string; founder_quote: string }

/** summary_table 一行（spec §2：平台 → 账号 → 封面文件 → 比例 → 用途槽 → 是否符合 → 例外 → 其他提醒） */
export interface SummaryRow {
  平台: string;
  账号: string;
  封面文件: string;
  比例: string;
  用途槽: string;
  是否符合: string;
  例外: string;
  其他提醒: string;
}

/** 不能被例外的规则（spec §7：没法发） */
export const NON_OVERRIDABLE = new Set(["plan_shape", "file_missing"]);

export function platformVerdict(items: CheckItem[]): Verdict {
  if (items.some((i) => i.result === "block")) return "block";
  if (items.some((i) => i.result === "override")) return "override";
  if (items.some((i) => i.result === "warn" || i.result === "unchecked" || i.result === "not_run")) return "warn";
  return "pass";
}
