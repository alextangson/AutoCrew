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
