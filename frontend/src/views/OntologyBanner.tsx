/**
 * 看板顶部的本体提示（spec 2026-09-29 §4.1）：未启用时列出「要挪」的卡与依据，创始人确认后原子启用；
 * 对账失败逐条可见（§4 逐条隔离）。启用后只剩失败提示。
 */
import { useState } from "react";
import { confirmDialog, toast } from "../ui";
import { enableOntology } from "./board-api";
import { ontologyNotice, type OntologyState } from "./board-columns";

export function OntologyBanner(props: { ontology: OntologyState | undefined; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const notice = ontologyNotice(props.ontology);
  if (!notice) return null;
  const enable = async () => {
    const ok = await confirmDialog({ title: "按新规则重新归列？", body: `${notice.moves.length} 张卡会挪到新的列（清单里每张都写了依据）。之后阶段由盘上的产物和你的决定推出来。`, confirmLabel: "确认启用" });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await enableOntology();
      toast(r.ok ? "已按新规则归列" : r.error);
      await props.reload();
    } finally { setBusy(false); }
  };
  const errors = props.ontology?.report?.errors ?? [];
  return <div className="board2-ontology" role="status">
    <button className="bcard-link" onClick={() => setOpen((v) => !v)}>{notice.text}</button>
    {open && <div className="board2-ontology-list">
      {notice.moves.map((m) => <p key={m.id}>《{m.title}》{m.from ?? "（不在列里）"} → {m.to ?? "（不在列里）"}{m.rule ? `（${m.rule}）` : ""}：{m.evidence.join("；")}</p>)}
      {errors.map((e) => <p key={e.id} className="board2-stale">《{e.title}》对账失败：{e.error}</p>)}
      {notice.moves.length > 0 && <button disabled={busy} onClick={() => void enable()}>{busy ? "启用中…" : "确认启用"}</button>}
    </div>}
  </div>;
}
