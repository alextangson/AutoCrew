/**
 * 「等你拍板」（review-inbox §2、§3、§4）：看板最上方。没事时收成一行「没有等你拍板的事」，有事自动展开。
 * 一行一件事（缩略图、说人话的标题、稿名 + 谁在等、多久以前；有 agent 在等的行首小蓝点）。点开 = 右侧面板。
 * 做完：底部深色小提示「结果 · 撤回 · 还有 N 件」（10 秒），自动打开下一件；↓ / ↑ 切换，回车 = 主按钮。
 * 列表 5 秒轮询；面板开着的那件在别处处理掉了就提示「已在别处处理」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { relativeLabel } from "../../time-format";
import { artifactUrl } from "../board-parts";
import { decideItem, INBOX_OPEN_EVENT, loadInbox, undoDecision, type InboxOpenDetail } from "./review-api";
import { DONE_TEXT, nextAfter, plainWords, secondLine, sortItems, step, thumbKind, undoFor, type InboxAction, type InboxItem } from "./review-model";
import { ReviewPanel } from "./ReviewPanel";
import { useInboxNotify } from "./review-notify";
import "./review.css";

export const POLL_MS = 5000;
export const UNDO_MS = 10_000;

interface Toast { text: string; undo: (() => Promise<void>) | null; left: number }

function Thumb(p: { item: InboxItem }) {
  const k = thumbKind(p.item.type), cid = p.item.content_id, d = p.item.detail;
  if (k === "cover" && cid) {
    const g = (d.groups as Array<{ "3:4": { path?: string; sha256: string } | null }> | undefined)?.[0]?.["3:4"];
    if (g?.path) return <span className="ri-thumb"><img alt="" src={artifactUrl(cid, { path: g.path, sha256: g.sha256 })} /></span>;
  }
  if (k === "video" && cid) {
    const v = (d.versions as Array<{ path?: string; sha256: string }> | undefined)?.[0];
    if (v?.path) return <span className="ri-thumb"><video muted preload="metadata" src={`${artifactUrl(cid, { path: v.path, sha256: v.sha256 })}#t=0.5`} /></span>;
    return <span className="ri-thumb">片</span>;
  }
  return <span className="ri-thumb">{k === "cover" ? "图" : "稿"}</span>;
}

/** focusContent：从工作台 / 稿件页「去『等你拍板』处理」进来时，打开这条稿的第一件事 */
export function ReviewInbox(props: { focusContent?: string } = {}) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [held, setHeld] = useState<InboxItem | null>(null);
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const busy = useRef(false);
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
  const open = useCallback((id: string | null) => { setOpenId(id); setHeld(id ? list.find((i) => i.item_id === id) ?? null : null); }, [list]);
  const notify = useInboxNotify(items, (id) => { setCollapsed(false); open(id); });
  // 卡片 / 工作台的「去『等你拍板』处理」：打开这条稿的那件事
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<InboxOpenDetail>).detail;
      const hit = list.find((i) => i.content_id === d.content_id && (!d.types || d.types.includes(i.type)));
      if (hit) { setCollapsed(false); open(hit.item_id); }
    };
    window.addEventListener(INBOX_OPEN_EVENT, on);
    return () => window.removeEventListener(INBOX_OPEN_EVENT, on);
  }, [list, open]);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !props.focusContent || !items) return;
    focused.current = true;
    const hit = items.find((i) => i.content_id === props.focusContent);
    if (hit) { setCollapsed(false); open(hit.item_id); }
  }, [items, props.focusContent, open]);
  const current = list.find((i) => i.item_id === openId) ?? null;
  const shown = current ?? held;

  const showToast = (t: Toast) => {
    setToast(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), UNDO_MS);
  };

  const act = async (item: InboxItem, a: InboxAction, extra: Record<string, unknown> = {}) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await decideItem({ content_id: item.content_id ?? undefined, item_id: item.item_id, gen: item.gen, action: a.action, ...(a.params ?? {}), ...extra });
      const before = list;
      const fresh = (await reload()) ?? before;
      if (!r.ok) { showToast({ text: r.error, undo: null, left: fresh.length }); return; }
      const u = item.content_id ? undoFor(item, a.action, r.data) : null;
      const cid = item.content_id!;
      const next = nextAfter(fresh, item.item_id, before);
      showToast({ text: DONE_TEXT[a.action] ?? "记下了", left: fresh.length,
        undo: u ? async () => { const x = await undoDecision(cid, u.action, u.params); setToast(null); showToast({ text: x.ok ? "撤回了" : x.error, undo: null, left: (await reload())?.length ?? 0 }); } : null });
      setOpenId(next?.item_id ?? null); setHeld(next);
    } finally { busy.current = false; }
  };

  // ↓ / ↑ 切换；回车 = 主按钮；Esc 关面板。输入框里不接管
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (!list.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = step(list, openId, e.key === "ArrowDown" ? 1 : -1); if (n) open(n.item_id); }
      else if (e.key === "Enter" && current && !current.blocked_reason) {
        const primary = current.actions.find((a) => a.role === "primary" && a.note !== "required");
        if (primary) { e.preventDefault(); void act(current, primary); }
      } else if (e.key === "Escape" && openId) open(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const expanded = collapsed === null ? list.length > 0 : !collapsed;
  return <section className="ri" aria-label="等你拍板">
    <div className="ri-head">
      {list.length === 0 ? <span className="ri-empty">{error ? `「等你拍板」读不出来：${error}` : items === null ? "等你拍板 · 读取中" : "没有等你拍板的事"}</span>
        : <><strong>等你拍板</strong><span className="ri-count">{list.length} 件</span>
          <span className="ri-toggle">{notify.canAsk && <Button variant="quiet" onClick={notify.ask}>打开提醒</Button>}
            <Button variant="quiet" onClick={() => setCollapsed(expanded)}>{expanded ? "收起" : "展开"}</Button></span></>}
    </div>
    {expanded && list.length > 0 && <ul className="ri-list">{list.map((i) => <li key={i.item_id} tabIndex={0} className={"ri-row" + (i.item_id === openId ? " ri-on" : "")}
      aria-label={plainWords(i.summary)} onClick={() => open(i.item_id)}>
      {i.agent_waiting ? <span className="ri-dot" aria-label="有 agent 在等" /> : <span />}
      <Thumb item={i} />
      <span className="ri-text"><div className="ri-title">{plainWords(i.summary)}</div><div className="ri-sub">{secondLine(i)}</div></span>
      <span className="ri-time">{relativeLabel(i.since)}</span>
    </li>)}</ul>}
    {shown && <ReviewPanel item={shown} gone={!current} onClose={() => open(null)} act={(a, extra) => act(shown, a, extra)} />}
    {toast && <div className="ri-toast" role="status"><span>{toast.text}</span>
      {toast.undo && <button onClick={() => void toast.undo!()}>撤回</button>}
      <span className="ri-left">{toast.left > 0 ? `还有 ${toast.left} 件` : "都处理完了"}</span></div>}
  </section>;
}
