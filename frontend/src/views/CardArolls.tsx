/**
 * 卡片上本轮已挂的原片（1b §4.1 / §7，验收修订）：
 * - 每行：文件名、怎么来的（收件箱自动挂上 / 你从监视文件夹「…」确认的 / agent 报的 / 你挂的）、时长、什么时候到的、
 *   「在访达中显示」「不是」。能撤就给「不是」（挪回原处、回待录制）；撤不了给原因。
 * - 两段以上：先说清剪辑时都会用到，多余的点「不是」。
 * - 挂载核对说「这段原片听起来更像《X》」→「改挂到《X》」/「就是这条」；已经在剪 → 换成说明。
 */
import { confirmDialog, toast } from "../ui";
import { revealFact, type ArollRow } from "./board-api";

type Act = (action: string, params: Record<string, unknown>, done: string) => Promise<unknown>;

export function duration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}

export function CardArolls(p: { contentId: string; rows: ArollRow[]; busy: boolean; act: Act }) {
  if (!p.rows.length) return null;
  const undo = async (r: ArollRow) => {
    const back = r.source_path ?? "原来的文件夹";
    if (!(await confirmDialog({ title: "不是这条的原片？", body: `这段原片会挪回 ${back}（原名被占就加 -2）。这条稿要是因此没有原片了，会回到待录制。`, confirmLabel: "挪回去", danger: true }))) return;
    await p.act("undo_auto_attach", { fact_id: r.fact_id, sha256: r.sha256 }, "已撤下，原片挪回原处");
  };
  const reveal = async (r: ArollRow) => { const x = await revealFact(p.contentId, r.fact_id); if (!x.ok) toast(x.error); };
  return <section><h3>已挂的原片</h3>
    {p.rows.length > 1 && <p className="card-panel-note">这条有 {p.rows.length} 段原片，剪辑时都会用到；多余的点「不是」</p>}
    {p.rows.map((r) => <div key={r.fact_id} className="card-panel-aroll">
      <div className="card-panel-row">
        <strong title={r.path}>{r.name || r.path}</strong>
        <span className="muted"> · {[r.origin, duration(r.duration_ms), r.at ? new Date(r.at).toLocaleString() : ""].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="card-panel-row">
        <button className="bcard-link" onClick={() => void reveal(r)}>在访达中显示</button>
        {!r.undo_blocked && <button disabled={p.busy} onClick={() => void undo(r)}>不是</button>}
      </div>
      {r.undo_blocked && <p className="card-panel-note">{r.undo_blocked}</p>}
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
    </div>)}
  </section>;
}
