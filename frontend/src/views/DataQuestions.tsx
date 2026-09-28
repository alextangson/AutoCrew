/**
 * 数据页前三张问答卡（数据页规格 §H.49–51）：灰色问题 → 一句结论 → 证据 → 说明。
 * 句子和数字都来自 data-answers 的纯函数；这里只排版。第四张（写法实验）在 DataExperiments。
 */
import type { ReactNode } from "react";
import { platformLabel } from "../lib";
import { Card } from "../components/Card";
import { DataCover } from "./DataCover";
import {
  baselines, bestWorst, daysAfter, declineStreak, fmtX, latestAnswer, latestVideo, monthCompare, nextAnswer,
  platformLines, prevMonth, ratioText, trendAnswer, type Part, type PlatformLine, type Pick,
} from "./data-answers";
import { dayLabel, fmtViews, type DataPageData, type Upcoming } from "./data-lib";

export function QCard(props: { q: string; answer: Part[] | string; children?: ReactNode; note?: ReactNode }) {
  const parts = typeof props.answer === "string" ? [{ text: props.answer }] : props.answer;
  return (
    <Card className="dq">
      <div className="dq-q">{props.q}</div>
      <div className="dq-a">{parts.map((p, i) => (p.hot ? <em key={i}>{p.text}</em> : <span key={i}>{p.text}</span>))}</div>
      {props.children}
      {props.note && <div className="dq-note">{props.note}</div>}
    </Card>
  );
}

/** 短条：满格 = 平时的 3 倍，红线 = 平时 */
function Bar({ line }: { line: Extract<PlatformLine, { kind: "data" }> }) {
  if (line.ratio === null) return <span className="dq-bar is-none" />;
  const pct = Math.min(line.ratio / 3, 1) * 100;
  return <span className="dq-bar"><i className={line.ratio > 1.05 ? "is-up" : ""} style={{ width: `${pct}%` }} /><b /></span>;
}

function LineRow({ line }: { line: PlatformLine }) {
  const name = <span className="dq-name">{platformLabel(line.platform)}</span>;
  if (line.kind === "pending") return <div className="dq-line">{name}<span className="dq-v is-muted">—</span><span /><span className="dq-w is-muted">数据还没回来</span></div>;
  const t = line.ratio === null ? { text: "平时样本太少", hot: false } : ratioText(line.ratio);
  return <div className="dq-line">{name}<span className="dq-v">{fmtViews(line.views)}</span><Bar line={line} /><span className={"dq-w" + (t.hot ? " is-hot" : "")}>{t.text}</span></div>;
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
function whenLabel(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${WEEK[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const UPCOMING_STATE: Record<string, string> = { scheduled: "定时", overdue: "到点了还没确认公开", reviewing: "审核中" };

function UpcomingNote({ up }: { up: Upcoming | null }) {
  if (!up) return <>下一条：还没有定时或待公开的视频</>;
  const when = up.time ? `${whenLabel(up.time)} ` : "";
  return <>下一条：{up.title} · {when}{UPCOMING_STATE[up.state] ?? up.state}，公开后第 1、3、7 天自动对比</>;
}

type CardProps = { data: DataPageData; now: number; onChanged: () => void };

export function LatestCard({ data, now, onChanged }: CardProps) {
  const row = latestVideo(data.rows);
  const q = "刚发的那条怎么样";
  if (!row) return <QCard q={q} answer="还没有任何平台数据" note={<UpcomingNote up={data.upcoming} />} />;
  const lines = platformLines(row, data.columns, baselines(data.rows), now);
  const after = daysAfter(row);
  return (
    <QCard q={q} answer={latestAnswer(row, lines)} note={<UpcomingNote up={data.upcoming} />}>
      <div className="dq-latest">
        <DataCover rowId={row.id} cover={data.covers[row.id] ?? null} size="md" onChanged={onChanged} />
        <div><div className="dq-title">{row.title}</div><div className="dq-meta">{dayLabel(row.day)}发{after !== null ? ` · 数据截至发布后第 ${after} 天` : ""}</div></div>
      </div>
      {lines.map((l) => <LineRow key={l.platform} line={l} />)}
    </QCard>
  );
}

export function TrendCard({ data, month }: { data: DataPageData; month: string | null }) {
  const q = "账号整体在变好还是变差";
  if (!month) return <QCard q={q} answer="还没有数据" />;
  const lines = monthCompare(data.rows, data.columns, month);
  const streak = declineStreak(data.rows, data.columns);
  const m = (s: string) => `${Number(s.slice(5, 7))} 月`;
  return (
    <QCard q={q} answer={trendAnswer(lines, month)}
      note={streak && <>{platformLabel(streak.platform)} {streak.from.slice(5)} 之后连续 {streak.values.length - 1} 条走低：{streak.values.map(fmtViews).join(" → ")}</>}>
      <div className="dq-line dq-line-head"><span /><span className="dq-v">{m(prevMonth(month))} → {m(month)}</span><span /></div>
      {lines.map((l) => (
        <div key={l.platform} className="dq-line dq-line-trend">
          <span className="dq-name">{platformLabel(l.platform)}</span>
          {l.kind === "thin"
            ? <><span className="dq-v is-muted">—</span><span className="dq-w is-muted">样本太少，暂不比较</span></>
            : <><span className="dq-v">{fmtViews(l.prev)} → {fmtViews(l.cur)}</span><span className={"dq-w" + (l.pct < -10 ? " is-hot" : "")}>{l.pct < 0 ? "↓" : l.pct > 0 ? "↑" : "持平"} {l.pct ? `${Math.abs(l.pct)}%` : ""}</span></>}
        </div>
      ))}
    </QCard>
  );
}

function PickRow({ p, data, onChanged, bad }: { p: Pick; data: DataPageData; onChanged: () => void; bad?: boolean }) {
  return (
    <div className="dq-pick">
      <DataCover rowId={p.row.id} cover={data.covers[p.row.id] ?? null} onChanged={onChanged} />
      <div className="dq-pick-t"><div className="dq-title">{p.row.title}</div><div className="dq-meta">{p.row.day?.slice(5) ?? "日期不明"} · {p.note}</div></div>
      <span className={"dq-x" + (bad ? " is-hot" : "")}>{fmtX(p.x)}</span>
    </div>
  );
}

export function NextCard({ data, onChanged, openRetro }: CardProps & { openRetro: () => void }) {
  const b = bestWorst(data.rows, baselines(data.rows));
  return (
    <QCard q="下一条该写什么" answer={nextAnswer(b)}
      note={<>× = 是平时的几倍（各平台分别比，取中间值）。它们为什么好，<button className="data-link" onClick={openRetro}>看复盘</button></>}>
      {b.good.length > 0 && <div className="dq-group">比平时好</div>}
      {b.good.map((p) => <PickRow key={p.row.id} p={p} data={data} onChanged={onChanged} />)}
      {b.bad.length > 0 && <div className="dq-group">比平时差</div>}
      {b.bad.map((p) => <PickRow key={p.row.id} p={p} data={data} onChanged={onChanged} bad />)}
    </QCard>
  );
}
