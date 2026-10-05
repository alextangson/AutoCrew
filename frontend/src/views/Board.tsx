/**
 * 看板（看板规格 2026-09-28 第一批）：首页。六列与访达「我的内容」同名：
 * 选题 / 写稿中 / 待录制 / 剪辑中 / 待发布 / 已发布。
 * 拖动规则见 board-columns.dropAction：开始写、认稿、打开工作台、标已发布、往回退（同「⋯」确认）。
 * 列归属、发布状态由服务端 /api/board 算好。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { confirmDialog, toast } from "../ui";
import { requestDockCollapsed } from "../chat/dock-prefs";
import { newIdea } from "../new-idea";
import { decide, loadBoard, loadCard, markPublished, reopenScript, startWriting } from "./board-api";
import { InboxHeader } from "./InboxHeader";
import { ReviewInbox } from "./review/ReviewInbox";
import { UpdateBanner } from "./update/UpdateBanner";
import { decideItem } from "./review/review-api";
import { BoardTrash } from "./BoardTrash";
import { OntologyBanner } from "./OntologyBanner";
import { ItemCard, TopicCard, confirmBackMove, runTransition } from "./BoardCards";
import {
  COLUMNS, COLUMN_HINT, EMPTY_NOTE, FINAL_NOTE, HANDOFF_NOTE, boardCards, dropAction, platformName, visibleCards,
  type BoardColumn, type BoardData, type BoardItem, type Card, type DropAction, type UndoMove,
} from "./board-columns";
import "./board.css";

const POLL_MS = 3000;

type Nav = { openTopic: (key: string) => void; openEditor: (id: string) => void; openData: () => void; inbox?: string; inboxTypes?: string[] };

/** 读看板 + 3 秒轮询；拖动中 / 菜单开着时暂停，结束后补一次（§7） */
function useBoardData() {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paused = useRef(0);
  const missed = useRef(false);
  const inflight = useRef(false);
  const reload = useCallback(async () => {
    if (inflight.current) { missed.current = true; return; }
    inflight.current = true;
    try {
      const r = await loadBoard();
      if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
    } finally { inflight.current = false; }
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

export function Board(props: Nav) {
  const { data, error, reload, pause } = useBoardData();
  const [trash, setTrash] = useState(false);
  const [expanded, setExpanded] = useState<Set<BoardColumn>>(new Set());
  const [starting, setStarting] = useState<string | null>(null);
  const [radarBusy, setRadarBusy] = useState(false);
  const drag = useRef<{ from: BoardColumn; id: string; item: BoardItem | null } | null>(null);
  const [moving, setMoving] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<BoardColumn | null>(null);
  const ontology = Boolean(data?.ontology?.enabled);
  const cards = useMemo(() => (data ? boardCards(data) : null), [data]);
  // 看板默认收起总编辑（§28），离开回到偏好
  useEffect(() => requestDockCollapsed(), []);

  const start = async (topicId: string) => {
    if (starting) return;
    setStarting(topicId);
    try { await runStart(topicId, props.openEditor); await reload(); } finally { setStarting(null); }
  };
  const trashTopic = async (id: string) => {
    const r = await invoke("topic:delete", { id });
    toast(r.ok ? "已移入回收站（可恢复）" : r.error ?? "删除失败");
    await reload();
  };
  const collectMore = async () => {
    setRadarBusy(true);
    try {
      const r = await invoke("radar:more", { limit: 5, refresh: true });
      const saved = ((r as Record<string, unknown>).data as { savedCount?: number } | undefined)?.savedCount ?? 0;
      toast(!r.ok ? r.error ?? "继续收集失败" : saved > 0 ? `新增 ${saved} 条选题` : "这一批没有新的合格选题");
      await reload();
    } finally { setRadarBusy(false); }
  };
  const onDrop = (to: BoardColumn) => {
    const d = drag.current;
    endDrag();
    if (!d || moving.has(d.id)) return;
    // 按单张卡的启用状态分流（Codex 审 seg3 P2）：启用时被排除的稿照旧走交接流程
    const act = dropAction(d.from, d.item, to, Boolean(d.item?.active));
    if (act.kind === "start") return void start(d.id);
    if (act.kind === "refuse") return toast(act.reason);
    if (d.item) void runDrop(act, d.item);
  };
  /** 同一张卡在途时再拖一律忽略（§双击），结束后解锁 */
  const runDrop = async (act: DropAction, item: BoardItem) => {
    setMoving((s) => new Set(s).add(item.id));
    try { await applyDrop(act, item, props.openEditor, reload); } finally {
      setMoving((s) => { const n = new Set(s); n.delete(item.id); return n; });
    }
  };
  const beginDrag = (from: BoardColumn, id: string, item: BoardItem | null) => { drag.current = { from, id, item }; pause(true); };
  const endDrag = () => { if (drag.current) pause(false); drag.current = null; setOver(null); };
  const verdict = (col: BoardColumn) => (drag.current ? dropAction(drag.current.from, drag.current.item, col, Boolean(drag.current.item?.active)) : null);

  if (trash) return <BoardTrash back={() => { setTrash(false); void reload(); }} />;
  if (!data && error) return <div className="board-fail" role="alert">看板读不出来：{error} <button onClick={() => void reload()}>重试</button></div>;

  const allEmpty = cards !== null && COLUMNS.every((c) => cards[c].length === 0);
  return <div className="board2 page-board">
    <UpdateBanner />
    <ReviewInbox {...(props.inbox ? { focusContent: props.inbox } : {})} {...(props.inboxTypes ? { focusTypes: props.inboxTypes } : {})} />
    <div className="board2-tools">
      {error && <span className="board2-stale" role="alert">刷新失败：{error} <button className="bcard-link" onClick={() => void reload()}>重试</button></span>}
      {data && <OntologyBanner ontology={data.ontology} reload={reload} />}
    </div>
    <div className="board2-cols" style={{ gridTemplateColumns: COLUMNS.map((c) => colWidth(c, cards)).join(" ") }}>
      {COLUMNS.map((col) => { const v = over === col ? verdict(col) : null; const refused = v?.kind === "refuse" ? v.reason : null;
        return <section key={col} aria-label={col} title={refused ?? undefined}
        className={"bcol" + (v && v.kind !== "none" ? (refused ? " bcol-no" : " bcol-ok") : "")}
        onDragOver={(e) => { if (!drag.current) return; e.preventDefault(); e.dataTransfer.dropEffect = verdict(col)?.kind === "refuse" ? "none" : "move"; setOver(col); }}
        onDrop={(e) => { e.preventDefault(); onDrop(col); }}>
        <header className="bcol-head">
          <h2>{col}{cards && <span className="bcol-count">{col === "已发布" ? "最近 5 条" : cards[col].length}</span>}
            {col === "选题" && <span className="bcol-tools">
              <button className="bcard-link" disabled={radarBusy} onClick={() => void collectMore()}>{radarBusy ? "找选题中…" : "再找 5 条"}</button>
              <button className="bcard-link" onClick={() => setTrash(true)}>回收站</button>
            </span>}</h2>
          <p title={COLUMN_HINT[col]}>{COLUMN_HINT[col]}</p>
          {refused && <p className="bcol-refuse" role="status">{refused}</p>}
          {col === "待录制" && ontology && <InboxHeader inbox={data?.ontology?.report?.inbox} targets={(cards?.["待录制"] ?? []).flatMap((c) => (c.kind === "item" ? [{ id: c.item.id, title: c.item.title }] : []))} reload={reload} />}
        </header>
        {cards === null ? <p className="bcol-note">读取中</p>
          : <ColumnBody col={col} cards={cards[col]} data={data!} expanded={expanded.has(col)} allEmpty={allEmpty} starting={starting}
            onExpand={() => setExpanded((s) => new Set(s).add(col))} nav={props} start={start} trashTopic={trashTopic}
            beginDrag={beginDrag} endDrag={endDrag} pause={pause} reload={reload} moving={moving} />}
      </section>; })}
    </div>
  </div>;
}

/** 空列窄，有卡的宽；待发布 / 已发布的卡带发布行，给得更宽（§3） */
function colWidth(col: BoardColumn, cards: Record<BoardColumn, Card[]> | null): string {
  if (!cards) return "minmax(0, 1fr)";
  if (cards[col].length === 0) return "minmax(132px, 0.6fr)";  // 12px 列说明（字号尺子）一行放得下
  return col === "待发布" || col === "已发布" ? "minmax(0, 1.5fr)" : "minmax(0, 1.1fr)";
}

function ColumnBody(p: {
  col: BoardColumn; cards: Card[]; data: BoardData; expanded: boolean; allEmpty: boolean; starting: string | null;
  onExpand: () => void; nav: Nav; start: (id: string) => Promise<void>; trashTopic: (id: string) => Promise<void>;
  beginDrag: (from: BoardColumn, id: string, item: BoardItem | null) => void; endDrag: () => void; pause: (on: boolean) => void; reload: () => Promise<void>;
  moving: Set<string>;
}) {
  if (p.cards.length === 0) {
    if (p.col === "选题" && p.allEmpty) return <div className="bcol-note"><button className="primary" onClick={() => void newIdea().then(p.reload)}>＋新想法</button></div>;
    return <p className="bcol-note">{EMPTY_NOTE[p.col]}</p>;
  }
  const { shown, hidden } = visibleCards(p.cards, p.expanded);
  const drag = { onDragStart: p.beginDrag, onDragEnd: p.endDrag };
  return <div className="bcol-body">
    {shown.map((c) => c.kind === "topic"
      ? <TopicCard key={c.topic.id} {...drag} topic={c.topic} busy={p.starting === c.topic.id}
        onStart={() => void p.start(c.topic.id)} onOpen={() => p.nav.openTopic(`t-${c.topic.id}`)} onTrash={() => void p.trashTopic(c.topic.id)} />
      : <ItemCard key={c.item.id} {...drag} item={c.item} wpm={p.data.wordsPerMinute} busy={p.moving.has(c.item.id)} onOpen={() => p.nav.openEditor(c.item.id)} onMenu={p.pause} reload={p.reload} />)}
    {hidden > 0 && <button className="bcol-more" onClick={p.onExpand}>还有 {hidden} 条 ▾</button>}
    {p.col === "选题" && <p className="bcol-tip">拖到「写稿中」或点「开始写」</p>}
    {p.col === "已发布" && <button className="bcol-more" onClick={p.nav.openData}>更早的在数据页 ›</button>}
  </div>;
}

/** 拖放落地：认稿 / 标已发布走状态流转（force 只越状态图形状、越不过阶段门）；交剪辑、成片只打开工作台 */
async function applyDrop(act: DropAction, item: BoardItem, openEditor: (id: string) => void, reload: () => Promise<void>): Promise<void> {
  switch (act.kind) {
    case "open": return openEditor(item.id);
    case "undo": return runUndo(act.undo, item, reload);
    case "approve": return approveDraft(item, reload);
    case "back": return confirmBackMove(item, act.move, reload);
    case "publish": {
      if (!item.platform) return toast("这条没定平台，在卡片上对应平台点「已经发出去了」");
      const yes = await confirmDialog({ title: "标记为已发布？", body: `记为你在${platformName(item.platform)}手动发了。不会推送到平台，只改状态。`, confirmLabel: "标记已发布" });
      if (!yes) return;
      try { const r = await markPublished(item.id, item.platform); toast(r.ok ? "已标记为已发布" : r.error); } finally { await reload(); }
      return;
    }
    case "open-handoff": toast(HANDOFF_NOTE); return openEditor(item.id);
    case "open-final": toast(FINAL_NOTE); return openEditor(item.id);
    default: return;
  }
}

/** 本体下往回拖（§10、E14）：先确认，再落对应的撤销决定 / 重开文稿 */
async function runUndo(undo: UndoMove, item: BoardItem, reload: () => Promise<void>): Promise<void> {
  const card = await loadCard(item.id);
  if (!card.ok) return toast(card.error);
  // 纠正发布：确认框里写明撤的是哪一条（最新那条），不让人猜
  const last = card.data.published?.[0];
  const which = undo.action === "correct_publish" && last ? `\n\n要撤的是：${platformName(last.platform ?? "")} · ${last.label}${last.url ? ` · ${last.url}` : ""}` : "";
  if (!(await confirmDialog({ title: undo.title, body: undo.body + which, confirmLabel: "确定", danger: true }))) return;
  try {
    if (undo.action === "unapprove") return await runTransition(item, "reviewing", "已撤回认稿", async () => undefined);
    if (undo.action === "reopen") { const r = await reopenScript(item.id, card.data.round ?? 1); toast(r.ok ? "已重开文稿" : r.error); return; }
    if (undo.action === "revoke_cut") {
      const id = card.data.approvals?.cut?.id;
      if (!id) return toast("这版成片没有有效的批准可撤");
      const r = await decide(item.id, "revoke_approval", { decision_id: id });
      return toast(r.ok ? "已撤销成片批准" : r.error);
    }
    if (!last) return toast("没有可纠正的发布记录");
    const r = await decide(item.id, "correct_publish", { target_id: last.id });
    toast(r.ok ? "已纠正发布记录" : r.error);
  } finally { await reload(); }
}

/** 「开始写」的收尾：已开写就打开那篇；打不开 Claude 就退回剪贴板，一行提示不静默（§9/§11/§12） */
async function runStart(topicId: string, openEditor: (id: string) => void): Promise<void> {
  const r = await startWriting(topicId);
  if (!r.ok) return toast(r.error);
  if (!r.data.created) {
    toast("这条已经开写了，打开那篇");
    return openEditor(r.data.content_id);
  }
  if (r.data.opened && r.data.needs_angle) return toast("已建稿，Claude 新会话已填好指令。这条还没定立意，按发送后先在 Claude 里调研、选立意卡，再开写");
  if (r.data.opened) return toast("已建稿，Claude 新会话已填好指令，按发送开始写");
  let copied = false;
  try { if (r.data.prompt) { await navigator.clipboard.writeText(r.data.prompt); copied = true; } } catch { /* 下面明说 */ }
  const why = r.data.open_error ?? "Claude 没打开";
  toast(copied ? `已建稿，但${why}。指令已复制，去 Claude 新会话粘贴发送` : `已建稿，但${why}。请把这句发给 Claude：${r.data.prompt ?? ""}`);
}

/**
 * 拖「写稿中 → 待录制」= 认稿：走「等你拍板」的单一入口，带看板载入时那一版稿的代次；
 * 别的会话改过正文就拒「稿子刚改过，重新看一眼」（整分支审 4 P1）
 */
export async function approveDraft(item: BoardItem, reload: () => Promise<void>): Promise<void> {
  try {
    if (!item.draftRef) { toast("稿子刚改过，重新看一眼"); return; }
    const r = await decideItem({ content_id: item.id, item_id: item.draftRef.item_id, gen: item.draftRef.gen, action: "approve_script" });
    toast(r.ok ? "已认稿" : r.error);
  } finally { await reload(); }
}
