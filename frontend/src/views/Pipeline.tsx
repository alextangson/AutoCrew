/**
 * 内容管线（管线重规划 §2、§8，第 2 期）：一个主题一张卡。列：选题 → 写稿 → 录制 → 剪辑 → 待发布 → 发布中 → 全部发完。
 * 分组、列、去向状态都由服务端 /api/pipeline 算好；拖动 = 真动作，规则仍是旧看板的 dropAction（新列落到对应的旧列）。
 * 视觉照 home-mock-v2/pipeline.html。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { toast } from "../ui";
import { newIdea } from "../new-idea";
import { requestDockCollapsed } from "../chat/dock-prefs";
import { loadPipeline } from "./board-api";
import { applyDrop, runStart } from "./Board";
import { BoardTrash } from "./BoardTrash";
import { useWriters } from "./hand-off";
import type { HostId } from "./onboarding/connect-api";
import { dropAction, type BoardColumn, type BoardItem } from "./board-columns";
import { StagePie } from "./pipeline-glyphs";
import { ThemeCardView, TopicCardView } from "./PipelineCard";
import {
  COLUMN_PROGRESS, DEST_LABEL, DROP_TARGET, PIPELINE_COLUMNS, PIPELINE_VISIBLE, collapsedColumns, columnCards,
  type PipelineColumn, type PipelineData, type ThemeCard, type ThemeColumn,
} from "./pipeline-model";
import "./pipeline.css";

const POLL_MS = 3000;

/** 读管线 + 3 秒轮询；拖动中 / 菜单开着时暂停，结束后补一次（与看板同一套） */
function usePipeline() {
  const [data, setData] = useState<PipelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paused = useRef(0), missed = useRef(false), inflight = useRef(false);
  const reload = useCallback(async () => {
    if (inflight.current) { missed.current = true; return; }
    inflight.current = true;
    try { const r = await loadPipeline(); if (r.ok) { setData(r.data); setError(null); } else setError(r.error); }
    finally { inflight.current = false; }
  }, []);
  const tick = useCallback(() => {
    if (paused.current > 0 || document.hidden) { missed.current = true; return; }
    void reload();
  }, [reload]);
  const pause = useCallback((on: boolean) => {
    paused.current = Math.max(0, paused.current + (on ? 1 : -1));
    if (paused.current === 0 && missed.current) { missed.current = false; void reload(); }
  }, [reload]);
  useEffect(() => {
    void reload();
    const poll = window.setInterval(tick, POLL_MS);
    const off = subscribeEvents((e) => { if (e.kind === "reconnect" || e.kind === "engine") tick(); });
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(poll); window.removeEventListener("focus", tick); off(); };
  }, [reload, tick]);
  return { data, error, reload, pause };
}

/** 「只看等我的」：卡上有要你定 / 没发成的去向，或稿子等你认 */
const waitsOnMe = (t: ThemeCard) => t.item.status === "draft_ready" || t.destinations.some((d) => (d.state === "待你定" || d.state === "没发成") && (d.required || d.content_id)) || Boolean(t.reshoot?.to_cancel.length);

export function Pipeline(props: { openEditor: (id: string) => void; openTopic: (key: string) => void }) {
  const { data, error, reload, pause } = usePipeline();
  const [open, setOpen] = useState<string | null>(null);
  const [trash, setTrash] = useState(false);
  const [dest, setDest] = useState<string>("");
  const [mine, setMine] = useState(false);
  const [more, setMore] = useState<Set<PipelineColumn>>(new Set());
  const [starting, setStarting] = useState<string | null>(null);
  const [moving, setMoving] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<PipelineColumn | null>(null);
  const drag = useRef<{ from: BoardColumn; id: string; item: BoardItem | null } | null>(null);
  const writers = useWriters();
  const others = (writers?.writers ?? []).filter((h) => h !== writers?.defaultHost);
  useEffect(() => requestDockCollapsed(), []);

  const themes = useMemo(() => (data?.themes ?? []).filter((t) => (!dest || t.destinations.some((d) => d.platform === dest) || t.plan.required.includes(dest)) && (!mine || waitsOnMe(t))), [data, dest, mine]);
  const collapsed = useMemo(() => collapsedColumns(themes), [themes]);

  const start = async (topicId: string, host?: HostId) => {
    if (starting) return;
    setStarting(topicId);
    try { await runStart(topicId, props.openEditor, host); await reload(); } finally { setStarting(null); }
  };
  const trashTopic = async (id: string) => {
    const r = await invoke("topic:delete", { id });
    toast(r.ok ? "已移入回收站（可恢复）" : r.error ?? "删除失败");
    await reload();
  };
  const verdict = (col: PipelineColumn) => (drag.current ? dropAction(drag.current.from, drag.current.item, DROP_TARGET[col], Boolean(drag.current.item?.active)) : null);
  const beginDrag = (from: BoardColumn, id: string, item: BoardItem | null) => { drag.current = { from, id, item }; pause(true); };
  const endDrag = () => { if (drag.current) pause(false); drag.current = null; setOver(null); };
  const onDrop = async (col: PipelineColumn) => {
    const d = drag.current;
    endDrag();
    if (!d || moving.has(d.id)) return;
    const act = dropAction(d.from, d.item, DROP_TARGET[col], Boolean(d.item?.active));
    if (act.kind === "start") return void start(d.id);
    if (act.kind === "refuse") return toast(act.reason);
    if (!d.item) return;
    const item = d.item;
    setMoving((s) => new Set(s).add(item.id));
    try { await applyDrop(act, item, props.openEditor, reload); } finally { setMoving((s) => { const n = new Set(s); n.delete(item.id); return n; }); }
  };

  if (trash) return <BoardTrash back={() => { setTrash(false); void reload(); }} />;
  if (!data && error) return <div className="board-fail" role="alert">内容管线读不出来：{error} <button onClick={() => void reload()}>重试</button></div>;

  const count = (data?.themes.length ?? 0);
  const template = PIPELINE_COLUMNS.map((c) => (c !== "选题" && collapsed.has(c) ? "40px" : "minmax(0, 1fr)")).join(" ");
  return <div className="pl">
    <div className="pl-ph"><h1>内容管线</h1><span className="sub">{data ? `${count} 个主题 · 一个主题一张卡，公众号和英文版挂在卡上` : "读取中"}</span></div>
    <div className="pl-tools">
      <label className={"pl-chip" + (dest ? " on" : "")}>去向
        <select aria-label="按去向筛选" value={dest} onChange={(e) => setDest(e.target.value)}>
          <option value="">全部</option>
          {Object.entries(DEST_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
      <button className={"pl-chip" + (mine ? " on" : "")} aria-pressed={mine} onClick={() => setMine((m) => !m)}>只看 <b>等我的</b></button>
      {error && <span className="pl-stale" role="alert">刷新失败：{error} <button className="pl-link" onClick={() => void reload()}>重试</button></span>}
      {data?.planErrors.length ? <span className="pl-stale" role="alert">{data.planErrors.length} 条的去向计划读不出来，卡上标了</span> : null}
      <div className="pl-legend">
        <span>去向</span>
        <span><i className="pl-sw" style={{ background: "#16150F" }} />已发</span>
        <span><i className="pl-sw" style={{ background: "#8B877B" }} />已定时</span>
        <span><i className="pl-sw" style={{ background: "#B26A00" }} />待核</span>
        <span><i className="pl-sw" style={{ background: "#D3CFC3" }} />在做</span>
        <span><i className="pl-sw" style={{ background: "#C63D00" }} />待你定 / 没发成</span>
        <span><i className="pl-sw" style={{ boxShadow: "inset 0 0 0 1px #C9C5B9" }} />没开始</span>
      </div>
    </div>
    <div className="pl-board" style={{ gridTemplateColumns: template }}>
      {PIPELINE_COLUMNS.map((col) => {
        const v = over === col ? verdict(col) : null;
        const refused = v?.kind === "refuse" ? v.reason : null;
        const dnd = {
          onDragOver: (e: React.DragEvent) => { if (!drag.current) return; e.preventDefault(); e.dataTransfer.dropEffect = verdict(col)?.kind === "refuse" ? "none" : "move"; setOver(col); },
          onDrop: (e: React.DragEvent) => { e.preventDefault(); void onDrop(col); },
        };
        if (col !== "选题" && collapsed.has(col)) {
          return <section key={col} aria-label={col} className={"pl-collapsed" + (v && v.kind !== "none" ? (refused ? " drop-no" : " drop-ok") : "")} title={refused ?? undefined} {...dnd}>
            <StagePie f={COLUMN_PROGRESS[col]} /><span className="v">{col}</span><span className="n">0</span>
          </section>;
        }
        return <section key={col} aria-label={col} className={"pl-col" + (v && v.kind !== "none" ? (refused ? " drop-no" : " drop-ok") : "")} {...dnd}>
          <ColumnHead col={col} n={col === "选题" ? data?.topics.length ?? 0 : themes.filter((t) => t.column === col).length} onTrash={() => setTrash(true)} reload={reload} />
          {refused && <p className="pl-refuse" role="status">{refused}</p>}
          {!data ? <p className="pl-empty">读取中</p> : col === "选题"
            ? <Shown items={data.topics} expanded={more.has(col)} onMore={() => setMore((s) => new Set(s).add(col))} render={(t) =>
              <TopicCardView key={t.id} topic={t} busy={starting === t.id} others={others} onStart={(h) => void start(t.id, h)} onOpen={() => props.openTopic(`t-${t.id}`)}
                onTrash={() => void trashTopic(t.id)} onDragStart={() => beginDrag("选题", t.id, null)} onDragEnd={endDrag} />} />
            : <Shown items={columnCards(themes, col as ThemeColumn)} expanded={more.has(col)} onMore={() => setMore((s) => new Set(s).add(col))} render={(t) =>
              <ThemeCardView key={t.id} card={t} expanded={open === t.id} busy={moving.has(t.item.id)} toggle={() => setOpen((o) => (o === t.id ? null : t.id))}
                open={props.openEditor} reload={reload} onMenu={pause} onDragStart={(item) => beginDrag(item.column, item.id, item)} onDragEnd={endDrag} />} />}
        </section>;
      })}
    </div>
  </div>;
}

function ColumnHead(p: { col: PipelineColumn; n: number; onTrash: () => void; reload: () => Promise<void> }) {
  const [radar, setRadar] = useState(false);
  // 旧看板「再找 5 条」搬到这里（第 3 期旧看板退役）：找不到 / 失败都照实说
  const collectMore = async () => {
    setRadar(true);
    try {
      const r = await invoke("radar:more", { limit: 5, refresh: true });
      const saved = ((r as Record<string, unknown>).data as { savedCount?: number } | undefined)?.savedCount ?? 0;
      toast(!r.ok ? r.error ?? "继续收集失败" : saved > 0 ? `新增 ${saved} 条选题` : "这一批没有新的合格选题");
      await p.reload();
    } finally { setRadar(false); }
  };
  return <div className="pl-col-h"><StagePie f={COLUMN_PROGRESS[p.col]} />{p.col} <span className="n">{p.n}</span>
    {p.col === "选题" && <><button className="tool" style={{ marginLeft: "auto" }} disabled={radar} onClick={() => void collectMore()}>{radar ? "找选题中…" : "再找 5 条"}</button>
      <button className="tool" style={{ marginLeft: 8 }} onClick={p.onTrash}>回收站</button>
      <button className="plus" style={{ marginLeft: 8 }} title="新想法" onClick={() => void newIdea().then(p.reload)}>＋</button></>}
  </div>;
}

function Shown<T>(p: { items: T[]; expanded: boolean; onMore: () => void; render: (t: T) => React.ReactNode }) {
  const shown = p.expanded ? p.items : p.items.slice(0, PIPELINE_VISIBLE);
  const hidden = p.items.length - shown.length;
  return <>
    {shown.map(p.render)}
    {hidden > 0 && <button className="pl-more" onClick={p.onMore}>还有 {hidden} 条</button>}
  </>;
}

