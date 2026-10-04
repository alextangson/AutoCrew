/**
 * 预测账本的纯计算（预测账本规格 §一）：形状与后端 calibration:ledger（src/modules/calibration/ledger.ts）一一对应。
 * 只读：这里只有排版用的文字，没有任何改写预测的入口。
 */
import { fmtViews } from "./data-lib";

export type LedgerStatus = "pending" | "awaiting_data" | "reconciled" | "interpreted" | "reconstructed" | "integrity_warning";
export interface LedgerActual { views: number; landed_bucket: string; deviation_pct: number | null; hit: boolean; metric_date: string | null; source: string; by: "auto" | "manual" }
export interface LedgerRow {
  id: string; content_id: string; title: string; platform: string; predicted_at: string;
  bucket: string; distribution: Record<string, number>; center: number; confidence: string | null; disagreements: number;
  status: LedgerStatus; due_date: string | null; actual: LedgerActual | null; d7: { views: number; metric_date: string | null } | null;
  detail: { reason: string; factors: unknown; counterfactuals: unknown; hypothesis: unknown; records: Array<Record<string, unknown>> };
}
export interface ReconcileStatus { at: string; ok: boolean; code?: string; error?: string }
export interface LedgerSummary {
  rubric_version: string | null; samples: number; confidence: { label: string; meaning: string };
  hit_rate: Array<{ platform: string; n: number; hits: number }>; alerts: string[];
  counts: { pending: number; due: number; awaiting_data: number; awaiting_interpretation: number };
  reconcile: ReconcileStatus | null; integrity_problems: string[];
}
export interface Ledger { summary: LedgerSummary; rows: LedgerRow[] }

export const EMPTY_LEDGER_TEXT = "还没有预测。下一条视频出发布包时会做第一次盲预测";

const md = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.getMonth() + 1}/${d.getDate()}`;
};

export function statusText(r: Pick<LedgerRow, "status" | "due_date">): string {
  switch (r.status) {
    case "pending": return r.due_date ? `待复盘 · ${md(r.due_date)} 到期` : "待复盘 · 还没发布";
    case "awaiting_data": return "等数据";
    case "reconciled": return "已对账 · 待解读";
    case "interpreted": return "已解读";
    case "reconstructed": return "事后补记（不进校准）";
    case "integrity_warning": return "完整性警告（不进校准）";
  }
}

export function isBadStatus(s: LedgerStatus): boolean {
  return s === "integrity_warning" || s === "awaiting_data";
}

/** 「命中 40%」这类五档概率，按后端给的顺序 */
export function distributionText(d: Record<string, number>): string {
  return Object.entries(d).map(([k, v]) => `${k} ${v}%`).join(" · ");
}

export function deviationText(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "中枢为 0，无法算偏差";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

export function actualText(a: LedgerActual): string {
  const by = a.by === "auto" ? "自动对账" : "手动复盘";
  return `实际 ${fmtViews(a.views)} · 落在「${a.landed_bucket}」· 相对中枢 ${deviationText(a.deviation_pct)} · ${a.hit ? "命中" : "没中"} · ${by}${a.metric_date ? ` · 数据 ${a.metric_date}` : ""}`;
}

export function hitRateText(h: LedgerSummary["hit_rate"], label: (p: string) => string): string {
  if (!h.length) return "命中率：还没有已对账样本";
  return "命中率：" + h.map((x) => `${label(x.platform)} ${x.hits}/${x.n}`).join("，");
}

/** 汇总条下面的提醒行：对账出错 / 日志完整性 / 偏差与清算提醒 */
export function summaryProblems(s: LedgerSummary): string[] {
  const out: string[] = [];
  if (s.reconcile && !s.reconcile.ok) out.push(`自动对账没写成：${s.reconcile.error ?? "原因不明"}`);
  for (const p of s.integrity_problems) out.push(`日志完整性：${p}`);
  return out;
}

export function countsText(c: LedgerSummary["counts"]): string {
  return `待复盘 ${c.pending}（已到期 ${c.due}）· 等数据 ${c.awaiting_data} · 待解读 ${c.awaiting_interpretation}`;
}

/** 复盘记录的一行说明（详情里按时间列出） */
export function recordLine(r: Record<string, unknown>): string {
  const at = typeof r.at === "string" ? md(r.at) : "";
  if (r.type === "retro") return `${at} 数字对账${r.numeric_by === "auto" ? "（自动）" : ""}${typeof r.hypothesis_conclusion === "string" ? ` · 结论：${r.hypothesis_conclusion}` : ""}${interpretationTail(r)}`;
  if (r.type === "interpretation") return `${at} 解读：${String(r.hypothesis_conclusion ?? "")}${interpretationTail(r)}`;
  if (r.type === "reading") {
    const v = (r.actual as { views?: unknown } | undefined)?.views;
    return `${at} D+${String(r.day)} 读数 ${typeof v === "number" ? fmtViews(v) : "—"}`;
  }
  if (r.type === "correction") return `${at} 修正：${String(r.text ?? "")}`;
  if (r.type === "integrity_warning") return `${at} 完整性警告：${String(r.detail ?? "")}`;
  return `${at} ${String(r.type)}`;
}

/** 解读部分的尾巴：哪些判断被验证 / 推翻（带说明）、新观察 */
function interpretationTail(r: Record<string, unknown>): string {
  const vf = Array.isArray(r.verified_factors) ? (r.verified_factors as Array<{ factor?: unknown; verdict?: unknown; note?: unknown }>) : [];
  const obs = Array.isArray(r.observations) ? r.observations.filter((x): x is string => typeof x === "string") : [];
  const parts = vf.map((f) => `${String(f.factor ?? "")}：${String(f.verdict ?? "")}${f.note ? `（${String(f.note)}）` : ""}`);
  return (parts.length ? ` · 因素：${parts.join("；")}` : "") + (obs.length ? ` · 观察：${obs.join("；")}` : "");
}
