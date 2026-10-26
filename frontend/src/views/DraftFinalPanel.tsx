/**
 * 抖音口播薄路径（autocrew_draft）的定稿区（挂在正文下面：先读稿、再看反馈）：观众试读（旧稿是 Codex 审稿意见，只是提示）+ 出处清单。
 * 拍板在顶栏「定稿」（FinalizeButton）：没出处的项定稿时一律记成未核验，这里只摆出来给你看。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "../transport";
import { Button } from "../components/Button";
import { reviewVersionLabel, splitChecklist, structuredReview, testReadCounts, testReadLabel, VERDICT_LABEL, type DraftItem, type DraftPanelData, type DraftReviewNote, type DraftTestRead } from "./draft-final-lib";

/** 观众试读：小林只拿正文读一遍，标出会划走 / 没听懂 / 会转发的地方；默认收成一行摘要，点开原文照摆 */
export function TestRead(p: { reads: DraftTestRead[] }) {
  const last = p.reads.at(-1);
  if (!last) return null;
  const counts = last.status === "ok" ? testReadCounts(last.notes) : "";
  return <details className="draft-final-review draft-final-testread">
    <summary><strong>观众试读</strong> <span className="muted">{[testReadLabel(last), counts].filter(Boolean).join(" · ")}</span></summary>
    <pre className="draft-final-notes">{last.notes}</pre>
  </details>;
}

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

/** 清单一行：没出处的说明定稿时记成未核验；有没有出处都把要人看的模糊数字摆出来 */
export function ChecklistRow(p: { item: DraftItem }) {
  const i = p.item;
  return <li>
    {i.status === "sourced" ? "有出处" : "没出处"} · {i.text}
    {i.status === "sourced" ? <span className="muted"> （{i.evidence_ids.join("、")}）</span> : <>
      <span className="muted"> {i.reason} · 定稿时记为未核验</span>
    </>}
    {i.needs_human?.length ? <span className="muted"> · 要你看一眼的数字：{i.needs_human.join("、")}</span> : null}
  </li>;
}

export function DraftFinalPanel(p: { contentId: string; refreshKey: string }) {
  const [d, setD] = useState<DraftPanelData | null>(null);
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
  const groups = d.checklist ? splitChecklist(d.checklist.items) : null;
  return <section className="draft-final card" aria-label="定稿">
    {d.test_reads?.length ? <TestRead reads={d.test_reads} /> : <ReviewNotes notes={d.review_notes} version={d.version} />}
    {d.checklist && !d.finalized?.current && <div className="draft-final-checklist">
      <strong>出处清单</strong>{!d.checklist.current && <span className="muted"> （是改稿前出的，让 agent 重新出）</span>}
      <ul>{groups!.listed.map((i) => <ChecklistRow key={i.id} item={i} />)}</ul>
      {groups!.exempt.length > 0 && <details>
        <summary>示意/判断，不需要出处（{groups!.exempt.length}）</summary>
        <ul>{groups!.exempt.map((i) => <li key={i.id}>{i.kind === "judgment" ? "判断" : "示意"} · {i.text}</li>)}</ul>
      </details>}
    </div>}
  </section>;
}
