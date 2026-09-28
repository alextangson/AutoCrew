/**
 * 数据页（数据页规格 §G）：按月看，一行一条视频；右上一行写数据截至 / 来源 / 自动回流，导入与开关在设置页。
 * 数据同源 GET /api/data（每条作品全部快照 + 与稿件的关联），月份、中位数、加粗都在 data-lib 纯算。
 */
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { invoke, subscribeEvents } from "../transport";
import { platformLabel } from "../lib";
import { PageShell } from "../components/PageShell";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { loadDataPage } from "./board-api";
import { DataTable } from "./DataTable";
import { HypothesesList, RetroPanel } from "./DataAside";
import {
  boldThresholds, fmtViews, monthLabel, pickMonth, platformCards, pullLine, rowsInPeriod, sourceLabel,
  type DataPageData, type Period,
} from "./data-lib";
import type { PullPlatformStatus } from "../pull-lib";
import "./data.css";

function usePullStatus() {
  const [rows, setRows] = useState<PullPlatformStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void invoke("flywheel:pull_status").then((r) => {
      if (!r.ok) { setErr(r.error ?? "读取失败"); setRows(null); return; }
      setErr(null);
      setRows((r as unknown as { data: { platforms: PullPlatformStatus[] } }).data.platforms);
    });
  }, []);
  useEffect(() => {
    load();
    return subscribeEvents((e) => {
      if (e.kind === "reconnect") return load();
      if (e.kind === "engine" && (e.data as { kind?: string }).kind === "metrics_pull") load();
    });
  }, [load]);
  return pullLine(rows, err);
}

function StatusLine(props: { data: DataPageData; openSettings: () => void }) {
  const pull = usePullStatus();
  const asOf = props.data.asOf ? `数据截至 ${props.data.asOf.slice(5)}` : "还没有数据";
  const src = props.data.sources.map(sourceLabel).join(" + ");
  const settings = <button className="data-link" onClick={props.openSettings}>去设置</button>;
  if (pull.problem) return <p className="data-status is-bad" role="alert">{pull.problem} · {settings}</p>;
  return <p className="data-status">{asOf}{src ? ` · ${src}` : ""} · {pull.state} · {settings}</p>;
}

function RetroView({ file, onClose }: { file: string; onClose: () => void }) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setMd(null);
    void invoke("retro:get", { file }).then((r) => {
      if (!r.ok) return setErr(r.error ?? "读不出来");
      setMd((r as unknown as { data: { markdown: string } }).data.markdown);
    });
  }, [file]);
  return (
    <Card className="data-retro">
      <div className="data-retro-head"><span className="muted">复盘 · {file}</span><Button size="sm" variant="ghost" onClick={onClose}>收起</Button></div>
      {err && <p className="data-err">复盘读不出来：{err}</p>}
      {!err && md === null && <p className="muted">载入中…</p>}
      {md !== null && <div className="md-preview md-preview-inline"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{md}</ReactMarkdown></div>}
    </Card>
  );
}

function Cards({ data, rows }: { data: DataPageData; rows: DataPageData["rows"] }) {
  const cards = platformCards(rows, data.columns);
  if (!cards.length) return null;
  return (
    <div className="data-cards">
      {cards.map((c) => (
        <Card key={c.platform} className="data-card">
          <div className="muted">{platformLabel(c.platform)} · 播放中位数</div>
          <div className={"data-card-n" + (c.median === null ? " is-thin" : "")}>{c.median === null ? "样本太少" : fmtViews(c.median)}</div>
          <div className="muted">{c.count} 条</div>
        </Card>
      ))}
    </div>
  );
}

export function ReportView(props: { openEditor: (id: string) => void; openSettings: () => void }) {
  const [data, setData] = useState<DataPageData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("month");
  const [retro, setRetro] = useState<string | null>(null);
  const load = useCallback(() => {
    void loadDataPage().then((r) => (r.ok ? (setData(r.data), setErr(null)) : setErr(r.error)));
  }, []);
  useEffect(load, [load]);

  if (err && !data) return <PageShell kind="data"><p className="data-err">数据页加载失败：{err}</p></PageShell>;
  if (!data) return <PageShell kind="data"><p className="muted">载入中…</p></PageShell>;

  const { month, fallback } = pickMonth(data.rows, Date.now());
  const rows = rowsInPeriod(data.rows, period, month);
  return (
    <PageShell kind="data" className="data-page">
      <div className="data-bar">
        <h1 className="page-title">数据</h1>
        <div className="data-seg" role="tablist">
          {(["month", "all"] as const).map((p) => (
            <button key={p} role="tab" aria-selected={period === p} className={period === p ? "is-on" : ""} onClick={() => setPeriod(p)}>{p === "month" ? "本月" : "全部"}</button>
          ))}
        </div>
        <StatusLine data={data} openSettings={props.openSettings} />
      </div>
      {err && <p className="data-err">刷新失败：{err}</p>}
      <div className="data-grid">
        <div className="data-main">
          {period === "month" && fallback && month && <p className="data-note">本月还没有数据，下面是最近有数据的 {monthLabel(month)}。</p>}
          {retro && <RetroView file={retro} onClose={() => setRetro(null)} />}
          <Cards data={data} rows={rows} />
          {rows.length === 0
            ? <Card className="data-empty"><p className="muted">还没有任何平台数据。去设置页导入 CSV 或打开自动回流。</p></Card>
            : <DataTable rows={rows} columns={data.columns} thresholds={boldThresholds(data.rows)} contents={data.contents} onChanged={load} openEditor={props.openEditor} />}
          <p className="muted data-foot">粗体 = 高于这个平台全部历史的播放中位数。「—」= 这个平台没发；「未回流」= 发了，数据还没回来。点一行看各次快照。</p>
        </div>
        <aside className="data-side">
          <RetroPanel open={retro} onOpen={setRetro} />
          <HypothesesList />
        </aside>
      </div>
    </PageShell>
  );
}
