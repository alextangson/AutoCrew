/**
 * 合成的一行（2a 真实数据验收）：同一条稿的同种候选（「找到 3 张封面，看看是不是这条的」）、几篇写好的稿子（「9 篇稿子写好了」）。
 * 只是显示上合在一起：每件照旧按自己的 item_id + gen 决定。
 */
import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Actions, CandidatePreview, DraftBody } from "./ReviewPanel";
import type { InboxAction, InboxItem, Row } from "./review-model";

type ItemAct = (item: InboxItem, a: InboxAction, extra?: Record<string, unknown>) => Promise<void>;

export function GroupPanel(p: { row: Row; gone: boolean; onClose: () => void; act: ItemAct; rejectAll: (items: InboxItem[]) => Promise<void> }) {
  const drafts = p.row.items[0].type === "draft";
  return <aside className="ri-peek" role="dialog" aria-label={p.row.title}>
    <div className="ri-peek-top"><Button variant="quiet" onClick={p.onClose}>关闭</Button></div>
    <h2>{p.row.title}</h2>
    {p.gone ? <p className="ri-note" role="status">已在别处处理</p> : drafts ? <DraftSteps row={p.row} act={p.act} /> : <CandidateList row={p.row} act={p.act} rejectAll={p.rejectAll} />}
  </aside>;
}

function CandidateList(p: { row: Row; act: ItemAct; rejectAll: (items: InboxItem[]) => Promise<void> }) {
  return <>
    <p className="ri-note">稿子：{p.row.items[0].title}</p>
    <ul className="ri-check">{p.row.items.map((i) => <li key={i.item_id} className="ri-cand">
      <div className="ri-sub">{String(i.detail.name ?? "")} · {String(i.detail.reason ?? "")}</div>
      <CandidatePreview item={i} />
      <Actions item={i} act={(a, extra) => p.act(i, a, extra)} noEnter />
    </li>)}</ul>
    <div className="ri-actions"><span className="ri-quiet-slot"><Button variant="quiet" onClick={() => void p.rejectAll(p.row.items)}>都不是</Button></span></div>
  </>;
}

/** 几篇稿子：一篇一篇过，「下一篇」跳过这篇先看别的 */
function DraftSteps(p: { row: Row; act: ItemAct }) {
  const [idx, setIdx] = useState(0);
  const items = p.row.items;
  useEffect(() => { if (idx >= items.length) setIdx(0); }, [idx, items.length]);
  const cur = items[Math.min(idx, items.length - 1)];
  return <>
    <p className="ri-note">第 {Math.min(idx, items.length - 1) + 1} 篇，共 {items.length} 篇：{cur.title}</p>
    <DraftBody key={`${cur.item_id}:${cur.gen}`} item={cur} act={(a, extra) => p.act(cur, a, extra)} />
    {items.length > 1 && <div className="ri-actions"><span className="ri-quiet-slot"><Button variant="quiet" onClick={() => setIdx((idx + 1) % items.length)}>下一篇</Button></span></div>}
  </>;
}
