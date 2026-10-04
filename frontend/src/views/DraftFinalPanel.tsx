/**
 * 抖音口播薄路径（autocrew_draft）的定稿区：Codex 审稿意见（只是提示）+ 出处清单 + 「定了」。
 * 「定了」只有创始人在这里点得到（服务端只认浏览器会话），点下去进「等 A-roll」。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { Button } from "../components/Button";
import { finalizeBlock, VERDICT_LABEL, type DraftPanelData, type DraftReview } from "./draft-final-lib";

function ReviewBlock(p: { review: DraftReview; rerun: () => void }) {
  const r = p.review;
  if (r.status === "none") return null;
  return <div className="draft-final-review">
    <strong>Codex 审稿（只是参考）</strong> <span className="muted">{r.note ?? ""}</span>
    {(r.status === "queued" || r.status === "running") && <p className="muted">{r.status === "queued" ? "排队中…" : "审稿中…"}</p>}
    {r.status === "failed" && r.error && <p>没审成：{r.error.message}{r.error.detail ? <><br /><code>{r.error.detail}</code></> : null}</p>}
    {r.result && <ul>
      {(["main_line", "payoff", "opening"] as const).map((k) => <li key={k}>
        {VERDICT_LABEL[k]}：{r.result![k].verdict === "pass" ? "过" : "不过"} · {r.result![k].reason}
        {r.result![k].quotes.map((q) => <blockquote key={q}>{q}</blockquote>)}
      </li>)}
      {r.result.advisories.map((a, i) => <li key={`a${i}`}>建议：{a.text}{a.quote ? <blockquote>{a.quote}</blockquote> : null}</li>)}
    </ul>}
    {r.status !== "queued" && r.status !== "running" && <Button variant="quiet" size="sm" onClick={p.rerun}>再审</Button>}
  </div>;
}

export function DraftFinalPanel(p: { contentId: string; refreshKey: string; dirty: boolean; reload: () => Promise<void> }) {
  const [d, setD] = useState<DraftPanelData | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await invoke("draft:final_get", { id: p.contentId });
    const data = r.ok ? r.data as DraftPanelData | null | undefined : null;
    // 只认这条通道的形状：别的稿（不走 autocrew_draft）回 data:null，面板不出现
    setD(data && typeof data.draft_hash === "string" && data.review && typeof data.review === "object" ? data : null);
  }, [p.contentId]);
  useEffect(() => { void load(); }, [load, p.refreshKey]);
  if (!d) return null;
  const rerun = async () => { const r = await invoke("draft:review_rerun", { id: p.contentId }); if (!r.ok) toast(r.error ?? "没排上"); await load(); };
  const finalize = async () => {
    setBusy(true);
    const r = await invoke("draft:finalize", { id: p.contentId, draft_hash: d.draft_hash, keep: [...keep] });
    setBusy(false);
    if (!r.ok) { toast(r.error ?? "没定上"); await load(); return; }
    toast("定了：进入等 A-roll");
    await p.reload();
  };
  const block = finalizeBlock(d, keep, p.dirty);
  const toggle = (id: string) => setKeep((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return <section className="draft-final card" aria-label="定稿">
    <ReviewBlock review={d.review} rerun={() => void rerun()} />
    {d.status === "draft_ready" && d.checklist && <div className="draft-final-checklist">
      <strong>出处清单</strong>
      <ul>{d.checklist.items.map((i) => <li key={i.id}>
        {i.status === "sourced" ? "有出处" : "没出处"} · {i.text}
        {i.status === "sourced" ? <span className="muted"> （{i.evidence_ids.join("、")}）</span> : <>
          <span className="muted"> {i.reason}</span>{" "}
          <label><input type="checkbox" checked={keep.has(i.id)} onChange={() => toggle(i.id)} /> 保留（记为未核验）</label>
        </>}
      </li>)}</ul>
    </div>}
    {d.status === "draft_ready" && (block ? <p className="muted">{block}</p> : <Button variant="primary" disabled={busy} onClick={() => void finalize()}>{busy ? "定稿中…" : "定了，去录 A-roll"}</Button>)}
  </section>;
}
