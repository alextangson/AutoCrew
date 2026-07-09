/**
 * 数据回流(C 期迁移,轻版):作品数/均值/基线洞察——flywheel:report 单通道。
 * V5.6:+复盘报告区(周/月,markdown 渲染)。
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { invoke } from "../transport";
import { toast } from "../ui";

interface Report {
  works?: { total: number };
  avgMetrics?: Record<string, number>;
  baselineInsights?: string[];
}

export function ReportView() {
  const [d, setD] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retros, setRetros] = useState<Array<{ file: string; mode: string; date: string }>>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [retroMd, setRetroMd] = useState("");

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
  const metrics: Array<[string, string]> = [
    ["作品数", String(d.works?.total ?? 0)],
    ["平均播放/阅读", avg.views !== undefined ? Math.round(avg.views).toLocaleString("zh-CN") : "—"],
    ["平均完播率", avg.completionRate !== undefined ? avg.completionRate + "%" : "—"],
    ["平均点赞", avg.likes !== undefined ? String(Math.round(avg.likes)) : "—"],
  ];

  return (
    <div>
      <h2 className="serif">数据回流</h2>
      <div className="pipe" style={{ maxWidth: 560, margin: "12px 0" }}>
        {metrics.map(([label, value]) => (
          <div key={label} className="pipe-cell">
            <div className="pipe-n serif">{value}</div>
            <div className="muted mono">{label}</div>
          </div>
        ))}
      </div>
      {(d.baselineInsights ?? []).length > 0 && (
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="card-title">基线洞察</div>
          {(d.baselineInsights ?? []).map((ins, i) => (
            <p key={i} className="muted">· {ins}</p>
          ))}
        </div>
      )}
      <div className="card" style={{ maxWidth: 720, marginTop: 12 }}>
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
