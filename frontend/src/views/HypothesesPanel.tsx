/**
 * 假设区（回流 spec §5.3）——open 与已裁决两组。
 * 裁决是确定性代码算的**观察性结论**，模型只解释；所以这里每条裁决都带证据摘要
 * （样本数/对照值/差值）与那句口径注记，不给「因果」留误读空间。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { platformLabel } from "../lib";
import {
  HYPOTHESIS_STATUS_LABELS,
  METRIC_FOCUS_LABELS,
  evidenceSummary,
  type HypothesisView,
} from "../pull-lib";

function focusLine(h: HypothesisView): string {
  const metric = METRIC_FOCUS_LABELS[h.metricFocus] ?? h.metricFocus;
  const arrow = h.direction === "up" ? "↑ 高于基线" : "↓ 低于基线";
  const scope = h.scope.platform ? ` · ${platformLabel(h.scope.platform)}` : "";
  return `${metric} ${arrow}${scope}`;
}

function HypothesisRow({ h }: { h: HypothesisView }) {
  const evidence = evidenceSummary(h.evidence);
  return (
    <div style={{ padding: "6px 0", borderBottom: "1px dashed var(--border)" }}>
      <div className="row" style={{ cursor: "default", borderBottom: "none" }}>
        <span className="mono pri">{HYPOTHESIS_STATUS_LABELS[h.status] ?? h.status}</span>
        <span className="row-title" title={h.statement}>{h.statement}</span>
        <span className="muted mono">{focusLine(h)}</span>
      </div>
      {evidence && <p className="muted pull-note">证据：{evidence}</p>}
      {h.evidence?.reason && <p className="muted pull-note">判据：{h.evidence.reason}</p>}
      {h.evidence?.note && <p className="muted pull-note">口径：{h.evidence.note}</p>}
      {h.status === "open" && h.nextAction && <p className="muted pull-note">下一步：{h.nextAction}</p>}
    </div>
  );
}

export function HypothesesPanel() {
  const [data, setData] = useState<{ open: HypothesisView[]; judged: HypothesisView[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void invoke("flywheel:hypotheses_list").then((r) => {
      if (!r.ok) return setErr(r.error ?? "假设台账读取失败");
      setData((r as unknown as { data: { open: HypothesisView[]; judged: HypothesisView[] } }).data);
    });
  }, []);

  const open = data?.open ?? [];
  const judged = data?.judged ?? [];

  return (
    <div className="card report-card">
      <div className="card-head">
        <span className="card-title">假设</span>
        <span className="mono muted">复盘提出 · 代码裁决 · 观察性结论</span>
      </div>
      {err && <p className="pull-banner">假设台账不可用：{err}</p>}
      {!err && data === null && <p className="muted">载入中…</p>}
      {data && open.length === 0 && judged.length === 0 && (
        <p className="muted">
          还没有假设——跑一次周复盘（工作台「目标」卡），分析师会基于回流数据提出假设，之后每期自动裁决。
        </p>
      )}
      {open.length > 0 && (
        <>
          <p className="muted mono">待验证 {open.length} 条</p>
          {open.map((h) => (
            <HypothesisRow key={h.id} h={h} />
          ))}
        </>
      )}
      {judged.length > 0 && (
        <>
          <p className="muted mono" style={{ marginTop: 8 }}>已裁决 {judged.length} 条</p>
          {judged.map((h) => (
            <HypothesisRow key={h.id} h={h} />
          ))}
        </>
      )}
    </div>
  );
}
