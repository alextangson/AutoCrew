/**
 * 卡片「发现的候选」（1b 预演反馈）：第一行种类 + 文件名 + 来源；第二行一句原因；分数、前三名、完整路径收进「依据」。
 * 按钮：是这条 / 不是这条 / 在访达中显示（只显示这条候选自己的文件）。
 */
import { toast } from "../ui";
import { revealFact, type CandidateRowView } from "./board-api";

type Act = (action: string, params: Record<string, unknown>, done: string) => Promise<unknown>;

/** inbox：给了就不放「是这条 / 不是这条」，改成「去『等你拍板』处理」（等你拍板 2a：逐件的决定只在列表里做） */
export function CardCandidates(p: { contentId: string; rows: CandidateRowView[]; busy: boolean; act: Act; confirm: Act; inbox?: () => void }) {
  if (!p.rows.length) return null;
  const reveal = async (id: string) => { const r = await revealFact(p.contentId, id); if (!r.ok) toast(r.error); };
  return <section><h3>发现的候选</h3>{p.rows.map((c) => <div key={c.fact_id} className="card-panel-cand">
    <div className="card-panel-row"><strong title={c.path ?? undefined}>{c.name}</strong><span className="muted"> · {c.origin}</span></div>
    <p className="card-panel-note">{c.state === "pending_match" && c.started_at ? `${c.reason}（${new Date(c.started_at).toLocaleTimeString()} 开始）` : c.reason}</p>
    {c.detail && <details><summary className="card-panel-note">依据</summary><pre className="card-panel-detail">{c.detail}</pre></details>}
    <div className="card-panel-row">
      {/* 列表不列的候选（发布后导出、已发布、归了别条）在卡片上直接定，否则无处可定（整分支审 16 P2） */}
      {p.inbox && c.in_inbox ? (c.state === "candidate" && <button className="btn-ghost" onClick={p.inbox}>去『等你拍板』处理</button>) : (!p.inbox || c.state === "candidate") && <>
        <button disabled={p.busy} onClick={() => void p.confirm("confirm_candidate", { fact_id: c.fact_id, sha256: c.sha256 }, "已确认是这条")}>是这条</button>
        <button disabled={p.busy} onClick={() => void p.act("reject_candidate", { fact_id: c.fact_id, sha256: c.sha256 }, "记住了：不是这条")}>不是这条</button></>}
      {c.path && <button className="bcard-link" onClick={() => void reveal(c.fact_id)}>在访达中显示</button>}
    </div>
  </div>)}</section>;
}
