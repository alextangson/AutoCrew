/**
 * summary_table（spec §2、E8）：平台 → 账号 → 封面文件 → 比例 → 用途槽 → 是否符合 → 例外 → 其他提醒。
 * agent 必须原样贴进给创始人的一次确认汇总；例外逐字写「按你原话例外：『…』」。
 */
import path from "node:path";
import type { CoverFact } from "./deterministic.js";
import { platformLabel } from "./platforms.js";
import type { CheckItem, SummaryRow, Verdict } from "./types.js";

const VERDICT_LABEL: Record<Verdict, string> = { pass: "符合", warn: "有提醒", block: "被拦（不得提交）", override: "按原话例外" };

export interface PlatformSummaryInput { platform: string; account: string | null; verdict: Verdict; covers: CoverFact[]; items: CheckItem[] }

function exceptions(items: CheckItem[]): string {
  const quotes = [...new Set(items.filter((i) => i.result === "override" && i.override_quote).map((i) => i.override_quote!))];
  return quotes.length ? quotes.map((q) => `按你原话例外：『${q}』`).join("；") : "—";
}

function reminders(items: CheckItem[]): string {
  const lines = items.filter((i) => ["block", "warn", "unchecked", "not_run", "info"].includes(i.result))
    .map((i) => `${i.result === "block" ? "拦：" : i.result === "info" ? "要做：" : i.result === "warn" ? "提醒：" : "未查：" }${i.basis}`);
  return lines.length ? [...new Set(lines)].join("；") : "—";
}

export function summaryRows(input: PlatformSummaryInput): SummaryRow[] {
  const base = { 平台: platformLabel(input.platform), 账号: input.account ?? "（计划没写）", 是否符合: VERDICT_LABEL[input.verdict], 例外: exceptions(input.items), 其他提醒: reminders(input.items) };
  if (!input.covers.length) return [{ ...base, 封面文件: "（没有）", 比例: "—", 用途槽: "—" }];
  return input.covers.map((c, i) => ({
    ...base,
    封面文件: path.basename(c.path),
    比例: c.pixel_ratio ?? "读不出",
    用途槽: c.slot ? `${c.slot} 上传槽${c.usage ? `（${c.usage}）` : ""}` : "规则外",
    ...(i > 0 ? { 例外: "同上", 其他提醒: "同上" } : {}),
  }));
}

const COLS: Array<keyof SummaryRow> = ["平台", "账号", "封面文件", "比例", "用途槽", "是否符合", "例外", "其他提醒"];
const cell = (s: string) => s.replace(/\|/g, "｜").replace(/\n/g, " ");

export function summaryMarkdown(rows: SummaryRow[]): string {
  return [`| ${COLS.join(" | ")} |`, `|${COLS.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${COLS.map((c) => cell(r[c])).join(" | ")} |`)].join("\n");
}
