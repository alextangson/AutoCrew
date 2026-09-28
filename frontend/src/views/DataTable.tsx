/**
 * 数据页表格（数据页规格 §F.34–36 / §G.39–41 / §G.46）：一行一条视频，平台一列；按月分组，
 * 组内未关联的单独成组。点一行展开：各次快照 + 打开稿件 + 关联 / 合并 / 拆开 / 撤销。
 */
import { Fragment, useState, type CSSProperties } from "react";
import { platformLabel } from "../lib";
import { toast } from "../ui";
import { Button } from "../components/Button";
import { Tag } from "../components/Tag";
import { linkWorks, undoLink } from "./board-api";
import { DataCover } from "./DataCover";
import {
  cellOf, dayLabel, fmtRate, fmtViews, groupByMonth, monthLabel, sourceLabel,
  type DataPageData, type DataRow, type RowCover,
} from "./data-lib";

export interface TableProps {
  rows: DataRow[];
  columns: string[];
  thresholds: Map<string, number>;
  contents: DataPageData["contents"];
  covers: Record<string, RowCover>;
  onChanged: () => void;
  openEditor: (id: string) => void;
}

function CellView({ row, platform, thresholds }: { row: DataRow; platform: string; thresholds: Map<string, number> }) {
  const c = cellOf(row, platform, thresholds);
  if (c.kind === "none") return <span className="data-num muted" title="这个平台没发">—</span>;
  if (c.kind === "missing") return <span className="data-num data-missing" title="发了，数据还没回来">未回流</span>;
  return (
    <span className={"data-num" + (c.bold ? " is-bold" : "")}>
      <span>{c.views === null ? "—" : fmtViews(c.views)}</span>
      {c.rate !== null && <span className="data-rate">{fmtRate(c.rate)}</span>}
    </span>
  );
}

const LINK_TAG: Record<DataRow["link"], string> = { manual: "手动关联", auto: "自动关联", none: "未关联" };

async function act(p: Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: string, onChanged: () => void) {
  const r = await p;
  if (!r.ok) return toast(`没改成：${r.error}`);
  toast(done);
  onChanged();
}

function LinkPicker(props: { row: DataRow; contents: TableProps["contents"]; onChanged: () => void; onClose: () => void }) {
  const [pick, setPick] = useState("");
  const keys = props.row.works.map((w) => w.key);
  const near = [...props.contents].sort((a, b) => distance(a.day, props.row.day) - distance(b.day, props.row.day));
  return (
    <span className="data-picker">
      <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="关联到哪条稿件">
        <option value="">选一条稿件（按日期远近）</option>
        {near.map((c) => <option key={c.id} value={c.id}>{c.day ? `${c.day.slice(5)} · ` : ""}{c.title}</option>)}
      </select>
      <Button size="sm" variant="primary" disabled={!pick} onClick={() => void act(linkWorks({ op: "link", works: keys, content_id: pick }), "已关联", props.onChanged).then(props.onClose)}>关联</Button>
      <Button size="sm" variant="ghost" onClick={props.onClose}>取消</Button>
    </span>
  );
}

function distance(a: string | null, b: string | null): number {
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  return Math.abs(Date.parse(a) - Date.parse(b));
}

function RowActions(props: { row: DataRow; prev: DataRow | null; contents: TableProps["contents"]; onChanged: () => void; openEditor: (id: string) => void }) {
  const { row, prev } = props;
  const [picking, setPicking] = useState(false);
  const keys = row.works.map((w) => w.key);
  const mergePrev = () => {
    if (!prev) return;
    const payload = prev.contentId
      ? { op: "link" as const, works: keys, content_id: prev.contentId }
      : { op: "merge" as const, works: keys, target: prev.works[0].key };
    void act(linkWorks(payload), "已并到上一行", props.onChanged);
  };
  if (picking) return <LinkPicker row={row} contents={props.contents} onChanged={props.onChanged} onClose={() => setPicking(false)} />;
  return (
    <span className="data-actions">
      {row.contentId && <Button size="sm" onClick={() => props.openEditor(row.contentId!)}>打开稿件</Button>}
      {keys.length > 0 && <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>关联到…</Button>}
      {keys.length > 0 && prev && (prev.contentId || prev.works.length > 0) && <Button size="sm" variant="ghost" onClick={mergePrev}>和上一行是同一条</Button>}
      {(keys.length > 1 || (row.contentId && keys.length > 0)) && (
        <Button size="sm" variant="ghost" onClick={() => void act(linkWorks({ op: "split", works: keys }), "已拆开", props.onChanged)}>拆开</Button>
      )}
      {row.decisionId && <Button size="sm" variant="ghost" onClick={() => void act(undoLink(row.decisionId!), "已撤销上一次手动操作", props.onChanged)}>撤销手动操作</Button>}
    </span>
  );
}

function Snapshots({ row }: { row: DataRow }) {
  if (!row.works.length) return <p className="muted">发了，但还没有任何平台数据回来。</p>;
  return (
    <div className="data-snaps">
      {row.works.map((w) => (
        <div key={w.key} className="data-snap">
          <div className="data-snap-head"><b>{platformLabel(w.platform)}</b> <span className="muted">{w.title} · {dayLabel(w.day)} 发布</span></div>
          {[...w.snapshots].reverse().map((s, i) => (
            <div key={i} className="data-snap-row muted">
              <span>{s.metricDate.slice(5)}</span>
              <span>播放 {typeof s.metrics.views === "number" ? fmtViews(s.metrics.views) : "—"}</span>
              <span>完播 {typeof s.metrics.completionRate === "number" ? fmtRate(s.metrics.completionRate) : "—"}</span>
              <span>赞 {s.metrics.likes ?? "—"} · 藏 {s.metrics.favorites ?? "—"} · 评 {s.metrics.comments ?? "—"}</span>
              <span>{sourceLabel(s.source)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Row(props: TableProps & { row: DataRow; prev: DataRow | null; open: boolean; onToggle: () => void }) {
  const { row } = props;
  return (
    <>
      <div className={"data-row" + (props.open ? " is-open" : "")} role="button" tabIndex={0} onClick={props.onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onToggle(); } }}>
        <span className="data-title">
          <DataCover rowId={row.id} cover={props.covers[row.id] ?? null} onChanged={props.onChanged} />
          <span className="data-title-body">
            <span className="data-title-text" title={row.title}>{row.title}</span>
            <span className="data-sub">{dayLabel(row.day)} {row.link !== "none" && <Tag>{LINK_TAG[row.link]}</Tag>}</span>
          </span>
        </span>
        {props.columns.map((p) => <CellView key={p} row={row} platform={p} thresholds={props.thresholds} />)}
      </div>
      {props.open && (
        <div className="data-detail">
          <RowActions row={row} prev={props.prev} contents={props.contents} onChanged={props.onChanged} openEditor={props.openEditor} />
          <Snapshots row={row} />
        </div>
      )}
    </>
  );
}

export function DataTable(props: TableProps) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = groupByMonth(props.rows);
  const flat = groups.flatMap((g) => [...g.linked, ...g.unlinked]);
  const prevOf = (r: DataRow) => flat[flat.indexOf(r) - 1] ?? null;
  const cols = { "--data-cols": props.columns.length } as CSSProperties;
  const render = (r: DataRow) => (
    <Row key={r.id} {...props} row={r} prev={prevOf(r)} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
  );
  return (
    <div className="card data-table" style={cols}>
      <div className="data-head">
        <span>作品（按发布时间，一行一条视频）</span>
        {props.columns.map((p) => <span key={p} className="data-num">{platformLabel(p)}</span>)}
      </div>
      {groups.map((g) => (
        <Fragment key={g.month}>
          <div className="data-group">{monthLabel(g.month)} · {g.linked.length + g.unlinked.length} 条</div>
          {g.linked.map(render)}
          {g.unlinked.length > 0 && <div className="data-group data-group-sub">未关联稿件 · {g.unlinked.length} 条 <span className="muted">点开一行可以关联到稿件、并到上一行或拆开</span></div>}
          {g.unlinked.map(render)}
        </Fragment>
      ))}
    </div>
  );
}
