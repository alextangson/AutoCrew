/**
 * CSV 导入 — 三大平台创作者中心导出文件 → TypedRow → importPerformanceRows。
 *
 * 本文件是**薄 adapter**：只管解析文本与列名映射，校验/匹配/幂等/批内语义/落盘
 * 全在 row-import.ts 的统一漏斗里（spec §4.1，三通道一条入口）。
 * 列名映射是数据不是代码：PLATFORM_MAPPINGS 按已知后台字段名写默认值，
 * 首次 dogfood 用真实导出文件校准（见 docs/dogfood-runbook.md）。
 */
import { importPerformanceRows, type ImportReport } from "./row-import.js";
import type { OutcomeMetrics, OutcomeSource } from "./outcome-schema.js";
import type { TypedRow } from "../../adapters/browser/pull-types.js";

export type { ImportReport } from "./row-import.js";

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
  /** 曝光/展现量——与播放分列，绝不混进 views 别名（codex #4） */
  impressions?: string[];
  completionRate?: string[];
  completion5s?: string[];
  /** 平台把这些指标导出为 0-1 小数比例时声明（实战确认后），导入按 ×100 转换；>1 视为已是百分比 */
  ratioMetrics?: Array<"completionRate" | "completion5s">;
  likes?: string[];
  comments?: string[];
  shares?: string[];
  favorites?: string[];
  follows?: string[];
}

export const PLATFORM_MAPPINGS: Record<string, CsvColumnMapping> = {
  douyin: {
    // TODO(P1b)：抖音导出若含 item_id 类列，映射到 TypedRow.platformItemId（自动抓取先落这个字段）
    title: ["作品名称", "作品标题", "标题"],
    publishedAt: ["发布时间"],
    metricDate: ["数据日期", "统计日期"],
    views: ["播放量", "播放次数"],
    completionRate: ["完播率"],
    completion5s: ["5s完播率"],
    // 2026-06-10 实战确认：抖音"作品列表"导出的完播率与 5s完播率都是 0-1 小数比例
    ratioMetrics: ["completionRate", "completion5s"],
    likes: ["点赞量", "点赞数"],
    comments: ["评论量", "评论数"],
    shares: ["分享量", "转发量"],
    favorites: ["收藏量", "收藏数"],
    follows: ["粉丝增量", "涨粉量"],
  },
  wechat_video: {
    // 2026-06-10 按"视频号助手 → 动态数据明细"真实导出校准
    // TODO(P1b)：视频号导出若含 objectId 类列，映射到 TypedRow.platformItemId
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
  // 公众号「内容分析」后台导出。datacube 数据接口需微信认证(2026-07-12 实测 48001 无权限),
  // CSV 导出是兜底主路。列名未经真实导出文件校准——首个真实文件对不上时,改这里的别名数组即可。
  wechat_mp: {
    title: ["标题", "图文标题", "内容标题", "文章标题"],
    publishedAt: ["发表时间", "发布时间", "群发时间"],
    metricDate: ["数据日期", "统计日期", "日期"],
    views: ["图文页阅读次数", "阅读次数", "阅读量", "总阅读次数"],
    likes: ["点赞次数", "点赞数", "喜欢次数", "在看次数"],
    comments: ["留言次数", "留言数", "评论次数"],
    shares: ["分享次数", "转发次数", "分享转发次数"],
    favorites: ["收藏次数", "收藏数"],
    follows: ["新增关注人数", "净增关注人数"],
  },
  xiaohongshu: {
    title: ["笔记标题", "标题"],
    publishedAt: ["发布时间", "首次发布时间"],
    metricDate: ["数据日期", "统计日期"],
    // 曝光量从 views 别名里摘出来归 impressions：曝光（被推荐看到）和播放不是一个指标
    views: ["观看量", "浏览量"],
    impressions: ["曝光量"],
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

function applyRatioConversion(metrics: OutcomeMetrics, ratioMetrics: Array<"completionRate" | "completion5s"> | undefined): void {
  if (!ratioMetrics) return;
  for (const key of ratioMetrics) {
    const v = metrics[key];
    // 平台声明为小数比例时 ×100；>1 的值视为已是百分比（如 "32.5%" 解析结果），不重复转换
    if (v !== undefined && v <= 1) {
      metrics[key] = Math.round(v * 10000) / 100;
    }
  }
}

/** CSV 行 → TypedRow（标题缺失就是空标题，不再伪造"(无标题)"——空标题由漏斗行级拒收） */
function rowToTypedRow(
  row: Record<string, string>,
  mapping: CsvColumnMapping,
  defaultMetricDate: string,
): TypedRow {
  const metrics: OutcomeMetrics = {
    views: parseMetricNumber(pick(row, mapping.views)),
    impressions: parseMetricNumber(pick(row, mapping.impressions)),
    completionRate: parseMetricNumber(pick(row, mapping.completionRate)),
    completion5s: parseMetricNumber(pick(row, mapping.completion5s)),
    likes: parseMetricNumber(pick(row, mapping.likes)),
    comments: parseMetricNumber(pick(row, mapping.comments)),
    shares: parseMetricNumber(pick(row, mapping.shares)),
    favorites: parseMetricNumber(pick(row, mapping.favorites)),
    follows: parseMetricNumber(pick(row, mapping.follows)),
  };
  applyRatioConversion(metrics, mapping.ratioMetrics);
  return {
    title: pick(row, mapping.title) || "",
    publishedAt: parsePublishTime(pick(row, mapping.publishedAt)),
    metricDate: normalizeMetricDate(pick(row, mapping.metricDate), defaultMetricDate),
    metrics,
  };
}

/**
 * CSV 文本 → 入库。source 默认 "csv"；扩展桥/自动通道复用本 adapter 时传自己的来源。
 * rejected 的 row 号沿用「文件行号」口径（表头占第 1 行，首条数据行 = 2）。
 */
export async function importPerformanceCsv(
  platform: string,
  csvText: string,
  defaultMetricDate: string,
  dataDir?: string,
  source: OutcomeSource = "csv",
): Promise<ImportReport> {
  const mapping = PLATFORM_MAPPINGS[platform];
  if (!mapping) {
    throw new Error(`平台 ${platform} 没有 CSV 列名映射（已支持：${Object.keys(PLATFORM_MAPPINGS).join("/")}）`);
  }

  const rows = parseCsv(csvText).map((row) => rowToTypedRow(row, mapping, defaultMetricDate));
  return importPerformanceRows(platform, rows, {
    source,
    metricDate: defaultMetricDate,
    dataDir,
    rowNumberBase: 2,
  });
}
