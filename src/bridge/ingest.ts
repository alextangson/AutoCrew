/**
 * Bridge ingest layer: rows → CSV text → importPerformanceCsv。
 * 所有导入逻辑（校验/打标/对账/幂等/needsReview）由 importPerformanceCsv 继承，无新数据路径。
 */
import { importPerformanceCsv, PLATFORM_MAPPINGS } from "../modules/flywheel/csv-import.js";
import { localDateStamp } from "../modules/analytics/quality-baseline.js";
import type { BridgeMessage, BridgeResponse } from "./protocol.js";

/** CSV 字段序列化：含逗号/双引号/换行的值包在双引号内，双引号转义为 "" */
function escapeField(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * rows → CSV 文本（表头=首行键集）。
 * 语义与 parseCsv 对称——可往返读回原值。
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
