/**
 * 数据页「预测账本」（预测账本规格 §一）：汇总条 + 每条预测一行（新的在上），点开看完整预测与复盘记录。
 * 只读：预测不可改是规则本身，这里没有新建 / 修改 / 删除入口。读失败如实显示，不当成「没有预测」。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { platformLabel } from "../lib";
import { Card } from "../components/Card";
import { fmtViews } from "./data-lib";
import {
  EMPTY_LEDGER_TEXT, actualText, countsText, distributionText, hitRateText, isBadStatus, recordLine, statusText, summaryProblems,
  type Ledger, type LedgerRow,
} from "./ledger-lib";

function useLedger() {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void invoke("calibration:ledger").then((r) => {
      if (!r.ok) return setErr(r.error ?? "读取失败");
      setErr(null);
      setLedger((r as unknown as { data: Ledger }).data);
    });
  }, []);
  useEffect(() => {
    load();
    return subscribeEvents((e) => {
      if (e.kind === "reconnect") return load();
      if (e.kind === "engine" && (e.data as { kind?: string }).kind === "metrics_pull") load();
    });
  }, [load]);
  return { ledger, err };
}

function Summary({ s }: { s: Ledger["summary"] }) {
  const problems = summaryProblems(s);
  return (
    <div className="lg-summary">
      <div>评分表 {s.rubric_version ?? "—"} · 已对账样本 {s.samples} · 可信度 {s.confidence.label} · {hitRateText(s.hit_rate, platformLabel)}</div>
      <div className="muted">{countsText(s.counts)}</div>
      {s.alerts.map((a) => <div key={a} className="lg-alert">{a}</div>)}
      {problems.map((p) => <div key={p} className="lg-alert is-bad" role="alert">{p}</div>)}
    </div>
  );
}

function Detail({ row }: { row: LedgerRow }) {
  const d = row.detail;
  return (
    <div className="lg-detail">
      <div>理由：{d.reason}</div>
      <div>五档概率：{distributionText(row.distribution)}</div>
      <div>关键假设：{typeof d.hypothesis === "string" ? d.hypothesis : "—"}</div>
      <div>推理因素：</div>
      <pre className="lg-pre">{JSON.stringify(d.factors, null, 2)}</pre>
      <div>反事实：</div>
      <pre className="lg-pre">{JSON.stringify(d.counterfactuals, null, 2)}</pre>
      {row.d7 && <div>D+7 读数：{fmtViews(row.d7.views)}{row.d7.metric_date ? `（${row.d7.metric_date}）` : ""}</div>}
      <div>复盘记录：{d.records.length ? "" : "还没有"}</div>
      {d.records.map((r, i) => <div key={i} className="muted">{recordLine(r)}</div>)}
    </div>
  );
}

function Row({ row }: { row: LedgerRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="lg-row">
      <button className="lg-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="lg-title">{row.title}</span>
        <span className="muted">{platformLabel(row.platform)} · {row.predicted_at.slice(0, 10)}</span>
        <span className={"lg-status" + (isBadStatus(row.status) ? " is-bad" : "")}>{statusText(row)}</span>
      </button>
      <div className="muted">押「{row.bucket}」· 中枢 {fmtViews(row.center)} · {row.confidence ?? "可信度未记"} · 盲评分歧 {row.disagreements} 维</div>
      {row.actual && <div>{actualText(row.actual)}</div>}
      {open && <Detail row={row} />}
    </li>
  );
}

export function LedgerCard() {
  const { ledger, err } = useLedger();
  return (
    <Card className="data-ledger">
      <div className="dq-q">预测账本 · 盲预测和实际对得上吗（只读）</div>
      {err && <p className="data-err">账本读不出来：{err}</p>}
      {!err && !ledger && <p className="muted">载入中…</p>}
      {ledger && <Summary s={ledger.summary} />}
      {ledger && !ledger.rows.length && <p className="muted data-empty">{EMPTY_LEDGER_TEXT}</p>}
      {ledger && ledger.rows.length > 0 && <ul className="lg-list">{ledger.rows.map((r) => <Row key={r.id} row={r} />)}</ul>}
    </Card>
  );
}
