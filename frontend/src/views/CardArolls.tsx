/**
 * 卡片上本轮已挂的原片（1b §4.1 / §7）：
 * - 系统自动挂上的 →「不是这条」（挪回原处、回待录制）；推导回不去 / 被 ChatCut 用着 → 不给按钮，给原因。
 * - 挂载核对说「这段原片听起来更像《X》」→「改挂到《X》」/「就是这条」；已经在剪 → 换成说明。
 */
import { confirmDialog } from "../ui";
import type { ArollRow } from "./board-api";

type Act = (action: string, params: Record<string, unknown>, done: string) => Promise<unknown>;

export function CardArolls(p: { rows: ArollRow[]; busy: boolean; act: Act }) {
  if (!p.rows.length) return null;
  const undo = async (r: ArollRow) => {
    const back = r.source_path ?? "原来的文件夹";
    if (!(await confirmDialog({ title: "不是这条？", body: `这段原片会挪回 ${back}（原名被占就加 -2），这条回到待录制。`, confirmLabel: "挪回去", danger: true }))) return;
    await p.act("undo_auto_attach", { fact_id: r.fact_id, sha256: r.sha256 }, "已撤下，原片挪回原处");
  };
  return <section><h3>已挂的原片</h3>{p.rows.map((r) => <div key={r.fact_id} className="card-panel-aroll">
    <div className="card-panel-row"><span>{r.path}</span>
      {r.auto_attached && !r.undo_blocked && <button disabled={p.busy} onClick={() => void undo(r)}>不是这条</button>}
    </div>
    {r.auto_attached && r.undo_blocked && <p className="card-panel-note">{r.undo_blocked}</p>}
    {r.check?.status === "checking" && <p className="card-panel-note">正在核对内容</p>}
    {(r.check?.status === "not_ready" || r.check?.status === "failed") && <p className="card-panel-note">{r.check.reason}</p>}
    {r.check?.status === "suggest" && <div className="card-panel-alert" role="status">
      <p>这段原片听起来更像《{r.check.other_title}》</p>
      <div className="card-panel-row">
        {r.reassign_blocked ? <span className="card-panel-note">{r.reassign_blocked}</span>
          : <button disabled={p.busy} onClick={() => void p.act("reassign_aroll", { fact_id: r.fact_id, sha256: r.sha256, to: r.check!.other_id }, `已改挂到《${r.check!.other_title}》`)}>改挂到《{r.check.other_title}》</button>}
        <button disabled={p.busy} onClick={() => void p.act("keep_attach", { fact_id: r.fact_id, sha256: r.sha256 }, "记住了：就是这条")}>就是这条</button>
      </div>
    </div>}
  </div>)}</section>;
}
