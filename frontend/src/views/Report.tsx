/**
 * 数据回流(V5.6.2 修缮):全量均值 tile 墙 + 作品表现明细 + 基线洞察 + 复盘报告。
 * 数据同源 flywheel:report(works.items = 每作品最新快照);复盘 markdown 渲染与编辑器同栈。
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { invoke } from "../transport";
import { toast } from "../ui";
import { platformLabel } from "../lib";

interface WorkItem {
  title: string;
  platform: string;
  metricDate: string;
  metrics: Record<string, number>;
}

interface Report {
  works?: { total: number; matched?: number; historical?: number; items?: WorkItem[] };
  avgMetrics?: Record<string, number>;
  baselineInsights?: string[];
  baselineSampleSize?: number;
}

/** 均值指标全量上墙(与 outcome-schema 对齐);率值带 %,量值取整千分位 */
const METRIC_TILES: Array<[string, string, boolean]> = [
  ["views", "平均播放/阅读", false],
  ["completionRate", "平均完播率", true],
  ["completion5s", "平均5s完播", true],
  ["likes", "平均点赞", false],
  ["comments", "平均评论", false],
  ["shares", "平均分享", false],
  ["favorites", "平均收藏", false],
  ["follows", "平均涨粉", false],
];

const ROW_METRICS: Array<[string, string, boolean]> = [
  ["views", "播放", false],
  ["likes", "赞", false],
  ["favorites", "藏", false],
  ["comments", "评", false],
  ["completionRate", "完播", true],
];

const fmtNum = (v: number): string => Math.round(v).toLocaleString("zh-CN");

function metricsLine(m: Record<string, number>): string {
  return ROW_METRICS.flatMap(([key, label, rate]) =>
    typeof m[key] === "number" ? [`${label} ${rate ? `${m[key]}%` : fmtNum(m[key])}`] : [],
  ).join(" · ");
}

export function ReportView() {
  const [d, setD] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retros, setRetros] = useState<Array<{ file: string; mode: string; date: string }>>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [retroMd, setRetroMd] = useState("");
  const [impPlatform, setImpPlatform] = useState("wechat_mp");
  const [importing, setImporting] = useState(false);

  // 创作者中心导出 CSV → flywheel 导入管线(csv_text 直传;校验/对账/幂等在后端)
  const importCsvFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    const text = await file.text();
    const r = await invoke("flywheel:import_csv", { platform: impPlatform, csv_text: text });
    setImporting(false);
    if (!r.ok) return toast(r.error ?? "导入失败");
    const rep = (r as unknown as { data: { imported: number; matched: number; historical: number; needsReview: unknown[]; rejected: unknown[] } }).data;
    toast(`导入 ${rep.imported} 条:匹配稿件 ${rep.matched} · 历史 ${rep.historical} · 待复核 ${rep.needsReview.length}${rep.rejected.length ? ` · 拒绝 ${rep.rejected.length}` : ""}`);
    void invoke("flywheel:report").then((rr) => {
      if (rr.ok) setD((rr as unknown as { data: Report }).data);
    });
  };

  useEffect(() => {
    void invoke("flywheel:report").then((r) => {
      if (!r.ok) setErr(r.error ?? "加载失败");
      else setD((r as unknown as { data: Report }).data);
    });
    void invoke("retro:list").then((r) => {
      if (r.ok) setRetros((r as unknown as { data: { retros: typeof retros } }).data.retros);
    });
  }, []);

  const openRetro = async (file: string) => {
    if (openFile === file) return setOpenFile(null);
    const r = await invoke("retro:get", { file });
    if (!r.ok) return toast(r.error ?? "读取失败");
    setRetroMd((r as unknown as { data: { markdown: string } }).data.markdown);
    setOpenFile(file);
  };

  if (err) return <p className="muted pad">回流报告加载失败：{err}</p>;
  if (!d) return <p className="muted pad">载入中…</p>;

  const avg = d.avgMetrics ?? {};
  const items = d.works?.items ?? [];
  const tiles: Array<[string, string]> = [
    ["作品数", String(d.works?.total ?? 0)],
    ...METRIC_TILES.flatMap(([key, label, rate]): Array<[string, string]> =>
      typeof avg[key] === "number" ? [[label, rate ? `${avg[key]}%` : fmtNum(avg[key])]] : [],
    ),
  ];

  return (
    <div className="report">
      <div className="board-bar">
        <h2 className="serif board-title" style={{ margin: 0 }}>数据回流</h2>
        <span className="muted">发布后回填数据——选题评分、基线与复盘都以它为准</span>
        <span style={{ marginLeft: "auto" }} className="row-actions">
          <select value={impPlatform} onChange={(e) => setImpPlatform(e.target.value)}>
            <option value="wechat_mp">公众号</option>
            <option value="douyin">抖音</option>
            <option value="xiaohongshu">小红书</option>
            <option value="wechat_video">视频号</option>
          </select>
          <label className="chip" style={{ cursor: importing ? "wait" : "pointer" }}>
            {importing ? "导入中…" : "导入创作者中心 CSV"}
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              disabled={importing}
              onChange={(e) => {
                void importCsvFile(e.target.files?.[0]);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </span>
      </div>

      <div className="stat-grid">
        {tiles.map(([label, value]) => (
          <div key={label} className="stat-tile">
            <div className="pipe-n serif">{value}</div>
            <div className="muted mono">{label}</div>
          </div>
        ))}
      </div>

      {items.length > 0 && (
        <div className="card report-card">
          <div className="card-head">
            <span className="card-title">作品表现</span>
            <span className="mono muted">每篇取最新快照 · 近 {items.length} 篇</span>
          </div>
          {items.map((it, i) => (
            <div key={i} className="row" style={{ cursor: "default" }}>
              <span className="mono pri">{platformLabel(it.platform)}</span>
              <span className="row-title" title={it.title}>{it.title}</span>
              <span className="muted mono work-metrics">{metricsLine(it.metrics)}</span>
              <span className="muted mono">{it.metricDate.slice(5)}</span>
            </div>
          ))}
        </div>
      )}

      {(d.baselineInsights ?? []).length > 0 && (
        <div className="card report-card">
          <div className="card-title">基线洞察</div>
          {(d.baselineInsights ?? []).map((ins, i) => (
            <p key={i} className="muted">· {ins}</p>
          ))}
        </div>
      )}

      <div className="card report-card">
        <div className="card-title">复盘报告</div>
        {retros.length === 0 && <p className="muted">还没有复盘——工作台「目标」卡一键生成周复盘/月度深盘。</p>}
        {retros.map((r) => (
          <div key={r.file}>
            <div className="row" onClick={() => void openRetro(r.file)}>
              <span className="mono pri">{r.mode === "weekly" ? "周" : "月"}</span>
              <span className="row-title">{r.date} {r.mode === "weekly" ? "周复盘" : "月度深盘"}</span>
              <span className="muted mono">{openFile === r.file ? "收起" : "展开"}</span>
            </div>
            {openFile === r.file && (
              <div className="md-preview" style={{ minHeight: "auto", margin: "6px 0" }}>
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{retroMd}</ReactMarkdown>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="muted" style={{ marginTop: 10 }}>
        回填入口在编辑器(已发布稿)——数据回来,选题评分与基线才会越来越准。
      </p>
    </div>
  );
}
