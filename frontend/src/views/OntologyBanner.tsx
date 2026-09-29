/**
 * 看板顶部的本体提示（spec 2026-09-29 §4.1）：未启用时列出「要挪」的卡与依据，创始人确认后启用；
 * 对账失败逐条可见（§4 逐条隔离）。启用失败时列出失败的稿，创始人可以明确排除它们再启用（留在旧行为、卡上标出）。
 */
import { useState } from "react";
import { confirmDialog, toast } from "../ui";
import { enableOntology, type EnableFailure } from "./board-api";
import { ontologyNotice, type OntologyState } from "./board-columns";

export function OntologyBanner(props: { ontology: OntologyState | undefined; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<EnableFailure[]>([]);
  const notice = ontologyNotice(props.ontology);
  if (!notice && !failures.length) return null;
  const enable = async (exclude: string[]) => {
    const body = exclude.length
      ? `这 ${exclude.length} 条会被排除，留在旧规则、卡上标「未纳入本体」；其余按新规则归列。`
      : `${notice?.moves.length ?? 0} 张卡会挪到新的列（清单里每张都写了依据）。之后阶段由盘上的产物和你的决定推出来。`;
    if (!(await confirmDialog({ title: "按新规则重新归列？", body, confirmLabel: "确认启用" }))) return;
    setBusy(true);
    try {
      const r = await enableOntology(exclude);
      setFailures(r.ok ? [] : r.failures);
      toast(r.ok ? "已按新规则归列" : r.failures.length ? `有 ${r.failures.length} 条没过，没有启用` : r.error ?? "启用失败");
      await props.reload();
    } finally { setBusy(false); }
  };
  const errors = props.ontology?.report?.errors ?? [];
  return <div className="board2-ontology" role="status">
    {notice && <button className="bcard-link" onClick={() => setOpen((v) => !v)}>{notice.text}</button>}
    {open && notice && <div className="board2-ontology-list">
      {notice.moves.map((m) => <p key={m.id}>《{m.title}》{m.from ?? "（不在列里）"} → {m.to ?? "（不在列里）"}：{m.evidence.join("；")}</p>)}
      {errors.map((e) => <p key={e.id} className="board2-stale">《{e.title}》对账失败：{e.error}</p>)}
      {notice.warnings.map((w) => <p key={w} className="board2-stale">{w}</p>)}
      {notice.moves.length > 0 && <button disabled={busy} onClick={() => void enable([])}>{busy ? "启用中…" : "确认启用"}</button>}
    </div>}
    {failures.length > 0 && <div className="board2-ontology-list">
      {failures.map((f) => <p key={`${f.id}-${f.step}`} className="board2-stale">《{f.title}》{f.step}失败：{f.error}</p>)}
      <button disabled={busy} onClick={() => void enable([...new Set(failures.map((f) => f.id))])}>排除这 {new Set(failures.map((f) => f.id)).size} 条后启用</button>
    </div>}
  </div>;
}
