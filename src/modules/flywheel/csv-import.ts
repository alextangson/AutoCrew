/**
 * CSV 导入 — 三大平台创作者中心导出文件 → PerformanceOutcome。
 *
 * 列名映射是数据不是代码：PLATFORM_MAPPINGS 按已知后台字段名写默认值，
 * 首次 dogfood 用真实导出文件校准（见 docs/dogfood-runbook.md）。
 */
import { recordOutcome, matchDraft } from "./outcome-store.js";
import type { OutcomeMetrics, PerformanceOutcome } from "./outcome-schema.js";

/** 极简 CSV 解析：BOM/CRLF/引号字段/转义引号。平台导出不含换行内嵌字段，不支持也不需要。 */
export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^\uFEFF/, "");
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

/** "1.2万"→12000, "3.4w"→34000, "1.2亿"→120000000, "12.3%"→12.3, "1,234"→1234；非完整数字 token → undefined */
export function parseMetricNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/,/g, "");
  if (!s || s === "-") return undefined;
  const yi = /^(-?\d+(?:\.\d+)?)\s*亿$/.exec(s);
  if (yi) return Math.round(parseFloat(yi[1]) * 100000000);
  const wan = /^(-?\d+(?:\.\d+)?)\s*[万w]$/i.exec(s);
  if (wan) return Math.round(parseFloat(wan[1]) * 10000);
  const pct = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pct) return parseFloat(pct[1]);
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

/** 每个指标列出已知的列名别名；首个命中的别名生效。校准 = 编辑这里的数组。 */
export interface CsvColumnMapping {
  title: string[];
  publishedAt: string[];
  metricDate?: string[];
  views: string[];
  completionRate?: string[];
  /** 平台把完播率导出为 0-1 小数比例（如抖音作品列表 0.0245 = 2.45%）时声明，导入按 ×100 转换 */
  completionRateAsRatio?: boolean;
  likes?: string[];
  comments?: string[];
  shares?: string[];
  favorites?: string[];
  follows?: string[];
}

export const PLATFORM_MAPPINGS: Record<string, CsvColumnMapping> = {
  douyin: {
    title: ["作品名称", "作品标题", "标题"],
    publishedAt: ["发布时间"],
    metricDate: ["数据日期", "统计日期"],
    views: ["播放量", "播放次数"],
    completionRate: ["完播率"],
    // 2026-06-10 实战确认：抖音"作品列表"导出的完播率是 0-1 小数比例
    completionRateAsRatio: true,
    likes: ["点赞量", "点赞数"],
    comments: ["评论量", "评论数"],
    shares: ["分享量", "转发量"],
    favorites: ["收藏量", "收藏数"],
    follows: ["粉丝增量", "涨粉量"],
  },
  wechat_video: {
    // 2026-06-10 按"视频号助手 → 动态数据明细"真实导出校准
    title: ["视频描述", "内容", "标题", "动态内容"],
    publishedAt: ["发布时间"],
    metricDate: ["数据日期", "统计日期"],
    views: ["播放量", "播放次数"],
    completionRate: ["完播率"],
    likes: ["喜欢", "喜欢数", "点赞数"],
    comments: ["评论量", "评论数"],
    shares: ["分享量", "分享数", "转发数"],
    favorites: ["收藏数"],
    follows: ["关注量", "新增关注数", "净增关注"],
  },
  xiaohongshu: {
    title: ["笔记标题", "标题"],
    publishedAt: ["发布时间", "首次发布时间"],
    metricDate: ["数据日期", "统计日期"],
    views: ["观看量", "浏览量", "曝光量"],
    completionRate: ["完播率"],
    likes: ["点赞", "点赞数"],
    comments: ["评论", "评论数"],
    shares: ["分享", "分享数"],
    favorites: ["收藏", "收藏数"],
    follows: ["涨粉", "新增关注"],
  },
};

function pick(row: Record<string, string>, aliases: string[] | undefined): string | undefined {
  if (!aliases) return undefined;
  for (const a of aliases) {
    if (row[a] !== undefined && row[a] !== "") return row[a];
  }
  return undefined;
}

/** "2026-06-01 10:00" / "2026/6/1" → ISO；解析失败返回 null */
function parsePublishTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.replace(/\//g, "-"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** "2026/6/8"、"2026-06-08 12:00" → "2026-06-08"；缺失或解析失败用 defaultDate（schema 强制 YYYY-MM-DD）。
 *  不经 Date 往返——本地时区（Asia/Shanghai）会把 "2026-6-8" 偏成前一天（评审实证）。 */
function normalizeMetricDate(raw: string | undefined, defaultDate: string): string {
  if (!raw) return defaultDate;
  const d = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(raw.trim());
  if (!d) return defaultDate;
  return `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}`;
}

function rowToOutcomeInput(
  row: Record<string, string>,
  mapping: CsvColumnMapping,
  defaultMetricDate: string,
): { title: string; publishedAt: string | null; metricDate: string; metrics: OutcomeMetrics } {
  let completionRate = parseMetricNumber(pick(row, mapping.completionRate));
  // 平台声明为小数比例时 ×100；>1 的值视为已是百分比（如 "32.5%" 解析结果），不重复转换
  if (mapping.completionRateAsRatio && completionRate !== undefined && completionRate <= 1) {
    completionRate = Math.round(completionRate * 10000) / 100;
  }
  return {
    title: pick(row, mapping.title) || "(无标题)",
    publishedAt: parsePublishTime(pick(row, mapping.publishedAt)),
    metricDate: normalizeMetricDate(pick(row, mapping.metricDate), defaultMetricDate),
    metrics: {
      views: parseMetricNumber(pick(row, mapping.views)),
      completionRate,
      likes: parseMetricNumber(pick(row, mapping.likes)),
      comments: parseMetricNumber(pick(row, mapping.comments)),
      shares: parseMetricNumber(pick(row, mapping.shares)),
      favorites: parseMetricNumber(pick(row, mapping.favorites)),
      follows: parseMetricNumber(pick(row, mapping.follows)),
    },
  };
}

export interface ImportReport {
  total: number;
  imported: number;
  replaced: number;
  matched: number;
  historical: number;
  needsReview: PerformanceOutcome[];
  rejected: Array<{ row: number; title: string; error: string }>;
}

export async function importPerformanceCsv(
  platform: string,
  csvText: string,
  defaultMetricDate: string,
  dataDir?: string,
): Promise<ImportReport> {
  const mapping = PLATFORM_MAPPINGS[platform];
  if (!mapping) {
    throw new Error(`平台 ${platform} 没有 CSV 列名映射（已支持：${Object.keys(PLATFORM_MAPPINGS).join("/")}）`);
  }

  const rows = parseCsv(csvText);
  const report: ImportReport = {
    total: rows.length,
    imported: 0,
    replaced: 0,
    matched: 0,
    historical: 0,
    needsReview: [],
    rejected: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const { title, publishedAt, metricDate, metrics } = rowToOutcomeInput(
      rows[i],
      mapping,
      defaultMetricDate,
    );

    const draft = await matchDraft(platform, title, publishedAt, dataDir);
    const result = await recordOutcome(
      { contentId: draft?.id ?? null, platform, platformTitle: title, publishedAt, metricDate, metrics, source: "csv" },
      dataDir,
    );

    if (!result.ok) {
      report.rejected.push({ row: i + 2, title, error: result.error || "未知错误" });
      continue;
    }
    report.imported++;
    if (result.replaced) report.replaced++;
    if (draft) report.matched++;
    else report.historical++;
    if (result.outcome?.needsReview) report.needsReview.push(result.outcome);
  }

  return report;
}
