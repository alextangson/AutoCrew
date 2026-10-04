/**
 * 抖音口播薄路径（autocrew_draft）的定稿区：agent 附的 Codex 审稿意见（只是提示）+ 出处清单 + 「定了」。
 * 「定了」只有创始人在这里点得到（服务端只认浏览器会话），点下去进「等 A-roll」。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Button } from "../components/Button";
import { finalizeBlock, reviewVersionLabel, splitChecklist, structuredReview, VERDICT_LABEL, type DraftItem, type DraftPanelData, type DraftReviewNote } from "./draft-final-lib";

/** agent 附的 Codex 审稿意见：认得出三项结论就分项摆，否则原文照摆（调不通时就是原因） */
export function ReviewNotes(p: { notes: DraftReviewNote[]; version: number }) {
  const last = p.notes.at(-1);
  if (!last) return null;
  const r = structuredReview(last.notes);
  return <div className="draft-final-review">
    <strong>Codex 审稿（只是参考）</strong> <span className="muted">{reviewVersionLabel(last.version, p.version)}</span>
    {r ? <ul>
      {(["main_line", "payoff", "opening"] as const).map((k) => <li key={k}>
        {VERDICT_LABEL[k]}：{r[k].verdict === "pass" ? "过" : "不过"} · {r[k].reason}
        {(r[k].quotes ?? []).map((q) => <blockquote key={q}>{q}</blockquote>)}
      </li>)}
      {(r.advisories ?? []).map((x, i) => <li key={`a${i}`}>建议：{x.text}{x.quote ? <blockquote>{x.quote}</blockquote> : null}</li>)}
    </ul> : <pre className="draft-final-notes">{typeof last.notes === "string" ? last.notes : JSON.stringify(last.notes, null, 2)}</pre>}
  </div>;
}

/** 清单一行：没出处的给「保留」勾选；有没有出处都把要人看的模糊数字摆出来 */
export function ChecklistRow(p: { item: DraftItem; kept: boolean; toggle: () => void }) {
  const i = p.item;
  return <li>
    {i.status === "sourced" ? "有出处" : "没出处"} · {i.text}
    {i.status === "sourced" ? <span className="muted"> （{i.evidence_ids.join("、")}）</span> : <>
      <span className="muted"> {i.reason}</span>{" "}
      <label><input type="checkbox" checked={p.kept} onChange={p.toggle} /> 保留（记为未核验）</label>
    </>}
    {i.needs_human?.length ? <span className="muted"> · 要你看一眼的数字：{i.needs_human.join("、")}</span> : null}
  </li>;
}

export function DraftFinalPanel(p: { contentId: string; refreshKey: string; dirty: boolean; reload: () => Promise<void> }) {
  const [d, setD] = useState<DraftPanelData | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await invoke("draft:final_get", { id: p.contentId });
    // 读失败要看得见、能重试；别把失败当成「这篇不走 autocrew_draft」把面板藏掉
    if (!r.ok) { setLoadError(r.error ?? "定稿清单读取失败"); return; }
    setLoadError(null);
    const data = r.data as DraftPanelData | null | undefined;
    // 只认这条通道的形状：别的稿（不走 autocrew_draft）回 data:null，面板不出现
    setD(data && typeof data.draft_hash === "string" && Array.isArray(data.review_notes) ? data : null);
  }, [p.contentId]);
  useEffect(() => { void load(); }, [load, p.refreshKey]);
  if (loadError) return <section className="draft-final card" aria-label="定稿">
    <p className="muted">定稿清单没读出来：{loadError}</p>
    <Button onClick={() => void load()}>重试</Button>
  </section>;
  if (!d) return null;
  const finalize = async () => {
    setBusy(true);
    const r = await invoke("draft:finalize", { id: p.contentId, draft_hash: d.draft_hash, keep: [...keep] });
    setBusy(false);
    if (!r.ok) { toast(r.error ?? "没定上"); await load(); return; }
    toast("定了：进入等 A-roll");
    await p.reload();
  };
  const block = finalizeBlock(d, keep, p.dirty);
  const groups = d.checklist ? splitChecklist(d.checklist.items) : null;
  const toggle = (id: string) => setKeep((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return <section className="draft-final card" aria-label="定稿">
    <ReviewNotes notes={d.review_notes} version={d.version} />
    {d.status === "draft_ready" && d.checklist && <div className="draft-final-checklist">
      <strong>出处清单</strong>
      <ul>{groups!.listed.map((i) => <ChecklistRow key={i.id} item={i} kept={keep.has(i.id)} toggle={() => toggle(i.id)} />)}</ul>
      {groups!.exempt.length > 0 && <details>
        <summary>示意/判断，不需要出处（{groups!.exempt.length}）</summary>
        <ul>{groups!.exempt.map((i) => <li key={i.id}>{i.kind === "judgment" ? "判断" : "示意"} · {i.text}</li>)}</ul>
      </details>}
    </div>}
    {d.status === "draft_ready" && (block ? <p className="muted">{block}</p> : <Button variant="primary" disabled={busy} onClick={() => void finalize()}>{busy ? "定稿中…" : "定了，去录 A-roll"}</Button>)}
  </section>;
}
