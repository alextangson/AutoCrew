/**
 * 数据回流(C 期迁移,轻版):作品数/均值/基线洞察——flywheel:report 单通道。
 * 单稿复盘细节在编辑器回填区;完整 records 复盘页随回流数据成熟再深化。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";

interface Report {
  works?: { total: number };
  avgMetrics?: Record<string, number>;
  baselineInsights?: string[];
}

export function ReportView() {
  const [d, setD] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void invoke("flywheel:report").then((r) => {
      if (!r.ok) setErr(r.error ?? "加载失败");
      else setD((r as unknown as { data: Report }).data);
    });
  }, []);

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
      <p className="muted" style={{ marginTop: 10 }}>
        回填入口在编辑器(已发布稿)——数据回来,选题评分与基线才会越来越准。
      </p>
    </div>
  );
}
