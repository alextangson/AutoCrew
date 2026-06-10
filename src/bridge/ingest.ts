/**
 * Bridge ingest layer: rows → CSV text → importPerformanceCsv。
 * 所有导入逻辑（校验/打标/对账/幂等/needsReview）由 importPerformanceCsv 继承，无新数据路径。
 */
import { importPerformanceCsv, PLATFORM_MAPPINGS } from "../modules/flywheel/csv-import.js";
import { localDateStamp } from "../modules/analytics/quality-baseline.js";
import type { BridgeMessage, BridgeResponse } from "./protocol.js";

/**
 * CSV 字段序列化：换行清洗为单空格 + 含逗号/双引号的值包双引号（"" 转义）。
 * 换行必须清洗而非引号包裹：parseCsv 不支持换行内嵌字段——首列换行撕裂行
 * → 误导性 rejected（指向选择器校准），非首列 → 表头错位静默腐蚀 journal。
 * DOM innerText 实测会带换行（含裸 \r），来源处一律清洗。
 */
function escapeField(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (clean.includes('"') || clean.includes(",")) {
    return `"${clean.replace(/"/g, '""')}"`;
  }
  return clean;
}

/**
 * rows → CSV 文本（表头=首行键集）。
 * 语义与 parseCsv 对称——可往返读回原值（换行被清洗为空格，见 escapeField）。
 * 空数组返回空字符串。
 */
export function rowsToCsvText(rows: Array<Record<string, string>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const headerLine = headers.map(escapeField).join(",");
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeField(row[h] ?? "")).join(","),
  );
  return [headerLine, ...dataLines].join("\n");
}

/**
 * 处理一条 BridgeMessage：
 * - ping → {ok, type:"pong"}
 * - ingest_rows → rowsToCsvText → importPerformanceCsv → {ok, type:"ingest_result", data: ImportReport}
 * - 未知平台 / 空 rows → {ok:false, error}
 * - importPerformanceCsv 抛错 → {ok:false, error 透传}
 */
export async function handleBridgeMessage(
  msg: BridgeMessage,
  dataDir?: string,
): Promise<BridgeResponse> {
  if (msg.type === "ping") {
    return { ok: true, type: "pong" };
  }

  const { platform, rows } = msg;

  if (rows.length === 0) {
    return { ok: false, type: "ingest_result", error: "rows 为空，无可导入数据" };
  }

  if (!PLATFORM_MAPPINGS[platform]) {
    const valid = Object.keys(PLATFORM_MAPPINGS).join(" / ");
    return {
      ok: false,
      type: "ingest_result",
      error: `未知平台 ${platform}（已支持：${valid}）`,
    };
  }

  const csvText = rowsToCsvText(rows);

  try {
    const report = await importPerformanceCsv(platform, csvText, localDateStamp(), dataDir);
    return { ok: true, type: "ingest_result", data: report };
  } catch (e) {
    return { ok: false, type: "ingest_result", error: String(e) };
  }
}
