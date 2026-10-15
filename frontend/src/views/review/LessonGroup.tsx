/**
 * 「《稿名》改稿攒下 N 条经验」那一组（spec 2026-10-15 §A）：逐条「要 / 不要」。
 * 每条写出要判断的问题（服务端 detail.question，与对话 brief 同一句）和原话（detail.words_text：选项代号已补全）。
 * 同一本手册、同一个底版本的几条意见是同一份改动：逐段可勾，一次批成一个新版本。
 * 批过 / 不要的条目当场消失（刷新列表）；生效规则满了，「要」变「要，替换第 X 条」。
 */
import { useRef, useState } from "react";
import { Button } from "../../components/Button";
import { decidePlaybook, decideRule, type Reply } from "./review-api";
import type { InboxItem, Row } from "./review-model";

type Json = Record<string, unknown>;
type Run = (key: string, fn: (eventId: string) => Promise<Reply<Json>>) => Promise<void>;

export const STALE_NOTE = "手册已经改过，这几条要按新版重提";

/** 同一条、同一个决定的 eventId 固定（双击 / 重试走服务端去重）；换决定换号 */
function useEventIds() {
  const ids = useRef(new Map<string, string>());
  return (key: string) => {
    if (!ids.current.has(key)) ids.current.set(key, `web-${crypto.randomUUID()}`);
    return ids.current.get(key)!;
  };
}

function Said(p: { item: InboxItem }) {
  const d = p.item.detail;
  return <>
    <p className="ri-question">{String(d.question ?? "")}</p>
    {d.words_text ? <p className="ri-note">你当时说：{String(d.words_text)}</p> : null}
  </>;
}

function RuleCard(p: { item: InboxItem; run: Run }) {
  const d = p.item.detail;
  const active = (d.active_rules as Array<{ id: string | null; rule: string }> | undefined) ?? [];
  const full = Number(d.active_rule_count ?? 0) >= Number(d.rule_cap ?? 12);
  const [pick, setPick] = useState(0);
  const conflict = d.conflicts_with as { rule: string } | null;
  const base = { ruleId: String(d.rule_id), revision: Number(d.revision) };
  const target = active[pick]?.id ?? undefined;
  return <li className="ri-lesson">
    <div className="ri-lesson-text">{String(d.rule ?? p.item.summary)}</div>
    <Said item={p.item} />
    {conflict && <p className="ri-note">和这条已有规则矛盾：「{conflict.rule}」</p>}
    {full && <label className="ri-note">规则已经有 {String(d.active_rule_count)} 条（上限 {String(d.rule_cap)}），要这条就换掉一条：
      <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>{active.map((r, i) => <option key={r.id ?? i} value={i}>第 {i + 1} 条：{r.rule}</option>)}</select></label>}
    <div className="ri-actions">
      <Button variant="primary" onClick={() => void p.run(`${p.item.item_id}:${full ? `replace:${target}` : "active"}`, (eventId) => decideRule({ ...base, decision: "active", eventId, ...(full && target ? { replaces: target } : {}) }))}>
        {full ? `要，替换第 ${pick + 1} 条` : "要"}</Button>
      <Button variant="secondary" onClick={() => void p.run(`${p.item.item_id}:rejected`, (eventId) => decideRule({ ...base, decision: "rejected", eventId }))}>不要</Button>
    </div>
  </li>;
}

/** 单条手册提案（整本修订，或这份改动只剩一条） */
function PlaybookCard(p: { item: InboxItem; run: Run }) {
  const d = p.item.detail;
  const one = (op: "approve" | "reject") => p.run(`${p.item.item_id}:${op}`, (event_id) => decidePlaybook({ op, id: d.playbook, proposal_id: d.proposal_id, gen: p.item.gen, event_id }));
  return <li className="ri-lesson">
    <div className="ri-lesson-text">《{String(d.playbook_name)}》：{p.item.summary}</div>
    <Said item={p.item} />
    <div className="ri-actions"><Button variant="primary" onClick={() => void one("approve")}>要</Button><Button variant="secondary" onClick={() => void one("reject")}>不要</Button></div>
  </li>;
}

/** 同一份改动的几条：逐段可勾，「要勾上的」= 勾上的批、没勾的不要，一次一个新版本 */
function MergedPlaybook(p: { items: InboxItem[]; run: Run }) {
  const d = p.items[0].detail;
  const [on, setOn] = useState<Record<string, boolean>>({});
  const checked = (i: InboxItem) => on[i.item_id] !== false;
  const send = (all: boolean | null) => {
    const items = p.items.map((i) => ({ proposal_id: String(i.detail.proposal_id), gen: i.gen, decision: all === false ? "reject" : checked(i) ? "approve" : "reject" }));
    const key = `${String(d.merge_key)}:${items.map((x) => `${x.proposal_id}=${x.decision}`).join(",")}`;
    return p.run(key, (event_id) => decidePlaybook({ op: "batch", id: d.playbook, based_on: d.based_on, items, event_id }));
  };
  return <li className="ri-lesson">
    <div className="ri-lesson-text">《{String(d.playbook_name)}》手册：这 {p.items.length} 条一起改成一个新版本</div>
    <p className="ri-question">{String(d.question ?? "")}</p>
    <ul className="ri-check">{p.items.map((i) => <li key={i.item_id}>
      <label><input type="checkbox" checked={checked(i)} onChange={(e) => setOn({ ...on, [i.item_id]: e.target.checked })} /> {String(i.detail.lesson ?? i.summary)}</label>
      {i.detail.words_text ? <div className="ri-note">你当时说：{String(i.detail.words_text)}</div> : null}
    </li>)}</ul>
    <div className="ri-actions">
      <Button variant="primary" disabled={!p.items.some(checked)} onClick={() => void send(null)}>要勾上的</Button>
      <Button variant="secondary" onClick={() => void send(false)}>都不要</Button>
    </div>
  </li>;
}

/** 组里的条目按显示块分：规则一条一块；手册按 merge_key 合并（没有 merge_key 的单列） */
export function lessonBlocks(items: InboxItem[]): Array<{ kind: "rule" | "playbook" | "merged"; items: InboxItem[] }> {
  const out: Array<{ kind: "rule" | "playbook" | "merged"; items: InboxItem[] }> = [];
  for (const i of items) {
    if (i.type === "writing_rule") { out.push({ kind: "rule", items: [i] }); continue; }
    const key = i.detail.merge_key;
    const block = key ? out.find((b) => b.kind !== "rule" && b.items[0].detail.merge_key === key) : undefined;
    if (block) { block.items.push(i); block.kind = "merged"; } else out.push({ kind: "playbook", items: [i] });
  }
  return out;
}

export function LessonPanel(p: { row: Row; gone: boolean; onClose: () => void; reload: () => Promise<unknown> }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const eventId = useEventIds();
  const run: Run = async (key, fn) => {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const r = await fn(eventId(key));
      if (!r.ok) setNote(r.body?.code === "stale" ? STALE_NOTE : r.error);
      await p.reload();
    } finally { setBusy(false); }
  };
  return <aside className="ri-peek" role="dialog" aria-label={p.row.title}>
    <div className="ri-peek-top"><Button variant="quiet" onClick={p.onClose}>关闭</Button></div>
    <h2>{p.row.title}</h2>
    {note && <p className="ri-warn" role="alert">{note}</p>}
    {p.gone ? (!note && <p className="ri-note" role="status">这一组都处理完了</p>)
      : <ul className="ri-check" aria-busy={busy}>{lessonBlocks(p.row.items).map((b) => b.kind === "rule" ? <RuleCard key={b.items[0].item_id} item={b.items[0]} run={run} />
        : b.kind === "merged" ? <MergedPlaybook key={String(b.items[0].detail.merge_key)} items={b.items} run={run} /> : <PlaybookCard key={b.items[0].item_id} item={b.items[0]} run={run} />)}</ul>}
  </aside>;
}
