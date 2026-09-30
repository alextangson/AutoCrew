/**
 * 「等你拍板」（review-inbox §2、§3、§4）：看板最上方。没事时收成一行「没有等你拍板的事」，有事自动展开。
 * 一行一件事（缩略图、说人话的标题、稿名 + 谁在等、多久以前；有 agent 在等的行首小蓝点）。点开 = 右侧面板。
 * 同一条稿的同种候选合成一行、稿子合成一行（只是显示；每件照旧按自己的 item_id + gen 决定）。
 * 做完：底部深色小提示「结果 · 撤回 · 还有 N 件」（10 秒），自动打开下一件；↓ / ↑ 切换，回车 = 主按钮。
 * 列表 5 秒轮询；面板开着的那件在别处处理掉了就提示「已在别处处理」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { relativeLabel } from "../../time-format";
import { decideItem, INBOX_OPEN_EVENT, loadInbox, mediaUrl, undoDecision, type InboxOpenDetail } from "./review-api";
import { DONE_TEXT, groupRows, nextRowAfter, previewFact, sortItems, stepRow, thumbKind, undoFor, type InboxAction, type InboxItem, type Row } from "./review-model";
import { PrimaryContext, ReviewPanel } from "./ReviewPanel";
import { GroupPanel } from "./ReviewGroup";
import { useInboxNotify } from "./review-notify";
import "./review.css";

export const POLL_MS = 5000;
const INTERACTIVE = "button, a, input, textarea, select, [role=button], [role=tab], [contenteditable=''], [contenteditable=true]";
export const UNDO_MS = 10_000;

interface Toast { text: string; undo: (() => Promise<void>) | null; left: number }

/** 行首缩略图：封面 / 候选封面是图，成片 / 候选成片是视频帧；只有稿子类是「稿」 */
export function Thumb(p: { item: InboxItem }) {
  const k = thumbKind(p.item), cid = p.item.content_id, fid = previewFact(p.item);
  if (k === "cover" && cid && fid) return <span className="ri-thumb"><img alt="" src={mediaUrl(cid, fid)} /></span>;
  if (k === "video" && cid && fid) return <span className="ri-thumb"><video muted preload="metadata" src={`${mediaUrl(cid, fid)}#t=0.5`} /></span>;
  return <span className="ri-thumb">{k === "cover" ? "图" : k === "video" ? "片" : k === "srt" ? "字" : "稿"}</span>;
}

export function ReviewInbox(props: { focusContent?: string } = {}) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [held, setHeld] = useState<Row | null>(null);
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const busy = useRef(false);
  const primaryRef = useRef<(() => void) | null>(null);
  const setPrimary = useCallback((fn: (() => void) | null) => { primaryRef.current = fn; }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reload = useCallback(async (): Promise<InboxItem[] | null> => {
    const r = await loadInbox();
    if (!r.ok) { setError(r.error); return null; }
    const sorted = sortItems(r.data.items);
    setItems(sorted); setError(null);
    return sorted;
  }, []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => { if (!document.hidden) void reload(); }, POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  const list = items ?? [];
  const rows = groupRows(list);
  const rowOfItem = (id: string) => rows.find((r) => r.items.some((i) => i.item_id === id)) ?? null;
  const open = useCallback((row: Row | null) => { setOpenKey(row?.key ?? null); setHeld(row); }, []);
  // 件数 = 创始人看到的行数（合成的行算一件），列表头和标签页标题用同一个数
  const notify = useInboxNotify(items, (id) => { setCollapsed(false); open(rowOfItem(id)); }, rows.length);
  // 卡片 / 工作台的「去『等你拍板』处理」：打开这条稿的那件事
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<InboxOpenDetail>).detail;
      const hit = list.find((i) => i.content_id === d.content_id && (!d.types || d.types.includes(i.type)));
      if (hit) { setCollapsed(false); open(rowOfItem(hit.item_id)); }
    };
    window.addEventListener(INBOX_OPEN_EVENT, on);
    return () => window.removeEventListener(INBOX_OPEN_EVENT, on);
  });
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !props.focusContent || !items) return;
    focused.current = true;
    const hit = items.find((i) => i.content_id === props.focusContent);
    if (hit) { setCollapsed(false); open(rowOfItem(hit.item_id)); }
  });
  const current = rows.find((r) => r.key === openKey) ?? null;
  const shown = current ?? held;

  const showToast = (t: Toast) => {
    setToast(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), UNDO_MS);
  };

  const act = async (item: InboxItem, a: InboxAction, extra: Record<string, unknown> = {}, quiet = false) => {
    if (busy.current) return false;
    busy.current = true;
    try {
      const r = await decideItem({ content_id: item.content_id ?? undefined, item_id: item.item_id, gen: item.gen, action: a.action, ...(a.params ?? {}), ...extra });
      const before = rows;
      const fresh = (await reload()) ?? list;
      if (!r.ok) { showToast({ text: r.error, undo: null, left: fresh.length }); return false; }
      if (quiet) return true;
      const u = item.content_id ? undoFor(item, a.action, r.data) : null;
      const cid = item.content_id!;
      const doneKey = before.find((row) => row.items.some((i) => i.item_id === item.item_id))?.key ?? item.item_id;
      const next = nextRowAfter(groupRows(fresh), doneKey, before);
      showToast({ text: DONE_TEXT[a.action] ?? "记下了", left: fresh.length,
        undo: u ? async () => { const x = await undoDecision(cid, u.action, u.params); setToast(null); showToast({ text: x.ok ? "撤回了" : x.error, undo: null, left: (await reload())?.length ?? 0 }); } : null });
      open(next);
      return true;
    } finally { busy.current = false; }
  };

  /** 合成行里的「都不是」：逐件按各自的代次否掉 */
  const rejectAll = async (group: InboxItem[]) => {
    let n = 0;
    for (const i of group) {
      const a = i.actions.find((x) => x.action === "reject_candidate");
      if (a && await act(i, a, {}, true)) n++;
    }
    const fresh = (await reload()) ?? list;
    showToast({ text: `记下了，${n} 件都不是`, undo: null, left: fresh.length });
    open(nextRowAfter(groupRows(fresh), shown?.key ?? "", rows));
  };

  // ↓ / ↑ 切换；回车 = 主按钮（只对单件的行）；Esc 关面板。输入框里不接管
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在任何可操作的控件上（按钮、链接、输入框、选项、版本切换…）时不接管：回车应该按那个控件自己（整分支审 P1）
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest(INTERACTIVE)) return;
      if (!rows.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(stepRow(rows, openKey, e.key === "ArrowDown" ? 1 : -1)); }
      else if (e.key === "Enter" && current && primaryRef.current) { e.preventDefault(); primaryRef.current(); }
      else if (e.key === "Escape" && openKey) open(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const expanded = collapsed === null ? list.length > 0 : !collapsed;
  return <section className="ri" aria-label="等你拍板">
    <div className="ri-head">
      {list.length === 0 ? <span className="ri-empty">{error ? `「等你拍板」读不出来：${error}` : items === null ? "等你拍板 · 读取中" : "没有等你拍板的事"}</span>
        : <><strong>等你拍板</strong><span className="ri-count">{rows.length} 件</span>
          <span className="ri-toggle">{notify.canAsk && <Button variant="quiet" onClick={notify.ask}>打开提醒</Button>}
            <Button variant="quiet" onClick={() => setCollapsed(expanded)}>{expanded ? "收起" : "展开"}</Button></span></>}
    </div>
    {expanded && rows.length > 0 && <ul className="ri-list">{rows.map((r) => <li key={r.key} tabIndex={0} className={"ri-row" + (r.key === openKey ? " ri-on" : "")}
      aria-label={r.title} onClick={() => open(r)}>
      {r.agent_waiting ? <span className="ri-dot" aria-label="有 agent 在等" /> : <span />}
      <Thumb item={r.items[0]} />
      <span className="ri-text"><div className="ri-title">{r.title}</div><div className="ri-sub">{r.sub}</div></span>
      <span className="ri-time">{relativeLabel(r.since)}</span>
    </li>)}</ul>}
    <PrimaryContext.Provider value={setPrimary}>
    {shown && (shown.items.length === 1
      ? <ReviewPanel item={shown.items[0]} gone={!current} onClose={() => open(null)} act={async (a, extra) => { await act(shown.items[0], a, extra); }} />
      : <GroupPanel row={current ?? shown} gone={!current} onClose={() => open(null)} act={async (i, a, extra) => { await act(i, a, extra); }} rejectAll={rejectAll} />)}
    </PrimaryContext.Provider>
    {toast && <div className="ri-toast" role="status"><span>{toast.text}</span>
      {toast.undo && <button onClick={() => void toast.undo!()}>撤回</button>}
      <span className="ri-left">{toast.left > 0 ? `还有 ${toast.left} 件` : "都处理完了"}</span></div>}
  </section>;
}
