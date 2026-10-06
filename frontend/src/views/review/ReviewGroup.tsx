/**
 * 合成的一行（2a 真实数据验收）：同一条稿的同种候选（「找到 3 张封面，看看是不是这条的」）。
 * 只是显示上合在一起：每件照旧按自己的 item_id + gen 决定。
 */
import { Button } from "../../components/Button";
import { Actions, CandidatePreview } from "./ReviewPanel";
import type { InboxAction, InboxItem, Row } from "./review-model";

type ItemAct = (item: InboxItem, a: InboxAction, extra?: Record<string, unknown>) => Promise<void>;

export function GroupPanel(p: { row: Row; gone: boolean; onClose: () => void; act: ItemAct; rejectAll: (items: InboxItem[]) => Promise<void> }) {
  return <aside className="ri-peek" role="dialog" aria-label={p.row.title}>
    <div className="ri-peek-top"><Button variant="quiet" onClick={p.onClose}>关闭</Button></div>
    <h2>{p.row.title}</h2>
    {p.gone ? <p className="ri-note" role="status">已在别处处理</p> : <CandidateList row={p.row} act={p.act} rejectAll={p.rejectAll} />}
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
