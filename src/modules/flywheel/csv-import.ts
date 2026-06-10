/**
 * CSV 导入 — 三大平台创作者中心导出文件 → PerformanceOutcome。
 *
 * 列名映射是数据不是代码：PLATFORM_MAPPINGS 按已知后台字段名写默认值，
 * 首次 dogfood 用真实导出文件校准（见 docs/dogfood-runbook.md）。
 */

/** 极简 CSV 解析：BOM/CRLF/引号字段/转义引号。平台导出不含换行内嵌字段，不支持也不需要。 */
export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields.map((f) => f.trim());
  };

  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = fields[i] ?? "";
    });
    return row;
  });
}

/** "1.2万"→12000, "3.4w"→34000, "12.3%"→12.3, "1,234"→1234, ""/"-"→undefined */
export function parseMetricNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/,/g, "");
  if (!s || s === "-") return undefined;
  const wan = /^([\d.]+)\s*[万w]$/i.exec(s);
  if (wan) return Math.round(parseFloat(wan[1]) * 10000);
  const pct = /^([\d.]+)\s*%$/.exec(s);
  if (pct) return parseFloat(pct[1]);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}
