/**
 * 抓取结果契约(spec §4.1)—— 三平台抓取器与入库漏斗之间唯一的数据形状。
 *
 * 抓取器产出 TypedRow(结构化行),不再绕 `rows → CSV 文本 → 再 parse` 的有损弯路;
 * 状态是 7 值结构化码,不是 `error + 一句人话`——调用方要按状态分流(扫码/退避/风控)。
 */
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";

export type PullStatus =
  | "ok"
  | "needs_login"
  | "risk_control"
  | "browser_unreachable"
  | "schema_changed"
  | "timeout"
  | "error";

export interface TypedRow {
  title: string;
  /** 平台发布时间 ISO;拿不到就是 null(不猜) */
  publishedAt: string | null;
  /** 抖音 item_id / 视频号 objectId / xhs note_id。**属性,不进幂等键**(codex #5) */
  platformItemId?: string;
  /** 行自带数据日期 YYYY-MM-DD(CSV 的「数据日期」列);缺省用批次默认值 */
  metricDate?: string;
  metrics: Partial<OutcomeMetrics>;
}

export interface PullResult {
  status: PullStatus;
  /** 仅 status="ok" 时非空 */
  rows: TypedRow[];
  /** 脱敏错误码:HTTP 状态 / schema 缺失字段名。**永不含响应原文**(codex #22) */
  errorCode?: string;
  /** 达到分页上限:"至少还有更多",不谎报精确丢弃数(codex #23) */
  hasMore?: boolean;
}
