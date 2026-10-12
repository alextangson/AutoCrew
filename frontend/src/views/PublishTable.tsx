/**
 * 发布台「各平台」表（发布台 spec §3 / 吸收 14）：每个目标平台一行——平台 | 状态 | 活动 | 数据 | 动作。
 * 每行最多一个显眼的动作，纠正 / 补链接 / 标已发收进行尾「更多」；行可展开看这个平台的标题、文案、标签 + 复制。
 * 所有动作走同一个防重复执行器（点下变灰，失败原因常驻 + 重试），都带平台和轮次。
 */
import { useState } from "react";
import { confirmDialog, openDialog, toast } from "../ui";
import { decide } from "./board-api";
import { useGuardedAction, type ActionResult } from "./guarded-action";
import { publishAsk, type PublishTarget } from "./publish-targets";
import { copyText, dataSub, dataText } from "./desk-model";
import type { Desk, DeskRow, MoreAction } from "./desk-api";

const OK: ActionResult = { ok: true };
const res = (r: { ok: boolean; error?: string }): ActionResult => (r.ok ? OK : { ok: false, error: r.error ?? "没成功，刷新再试" });
const MORE_LABEL: Record<MoreAction, string> = { i_published: "标已发", add_work_url: "补作品链接", record_metrics: "手填数据", correct_publish: "纠正：其实没发" };

export interface TableProps { contentId: string; title: string; desk: Desk; refresh: () => Promise<void>; reload: () => Promise<void> }

const asTarget = (r: DeskRow): PublishTarget => ({ platform: r.platform, state: r.state, actions: [], ...(r.reason ? { reason: r.reason } : {}) });

/** 行的主动作：让 Codex 发 / 重新提交 = 复制一句话给发布对话；确认发了 = 带 fact_id 的决定 */
async function rowAction(p: TableProps, r: DeskRow): Promise<ActionResult> {
  const a = r.action!;
  if (a.kind === "prepare_publish" || a.kind === "resubmit") {
    try { await navigator.clipboard.writeText(publishAsk(p.contentId, p.title, asTarget(r), a.kind)); } catch { return { ok: false, error: "复制没成功：浏览器不让写剪贴板" }; }
    toast("已复制，贴给发布对话（Codex / Claude）");
    return OK;
  }
  return res(await decide(p.contentId, "confirm_receipt", { platform: r.platform, round: p.desk.round, fact_id: a.fact_id }));
}

export async function moreAction(p: Pick<TableProps, "contentId" | "desk">, r: DeskRow, m: MoreAction): Promise<ActionResult> {
  const base = { platform: r.platform, round: p.desk.round };
  if (m === "correct_publish") {
    if (!(await confirmDialog({ title: `纠正${r.label}的发布记录？`, body: `记成${r.label}这一轮其实没发；只动${r.label}这一个平台。`, danger: true, confirmLabel: "纠正" }))) return OK;
    return res(await decide(p.contentId, "correct_publish", { ...base, ...(r.slot_id ? { target_id: r.slot_id } : {}) }));
  }
  if (m === "add_work_url") {
    const v = await openDialog({ title: `补${r.label}的作品链接`, body: "只补链接，不改发布状态和时间。要作品页链接，不是主页或后台。", fields: [{ key: "url", label: "作品链接", placeholder: "https://…" }], confirmLabel: "补上" });
    if (!v?.url.trim()) return OK;
    return res(await decide(p.contentId, "add_work_url", { ...base, url: v.url.trim() }));
  }
  if (m === "record_metrics") return recordMetrics(p, r);
  const v = await openDialog({ title: `在${r.label}发了？`, body: "记成你标的已发布。点错了可以在「更多」里纠正。", fields: [{ key: "url", label: "作品链接（选填）", placeholder: "https://…" }], confirmLabel: "记下" });
  if (!v) return OK;
  return res(await decide(p.contentId, "i_published", { ...base, ...(v.url.trim() ? { url: v.url.trim() } : {}) }));
}

async function recordMetrics(p: Pick<TableProps, "contentId" | "desk">, r: DeskRow): Promise<ActionResult> {
  const today = new Date().toISOString().slice(0, 10);
  const v = await openDialog({ title: `手填${r.label}的数据`, body: `${r.backflow.text}。数据记在这一轮的这件作品上。`, confirmLabel: "记下", fields: [
    { key: "metric_date", label: "数据日期", placeholder: "YYYY-MM-DD", initial: today }, { key: "views", label: "播放" }, { key: "likes", label: "点赞（选填）" }, { key: "comments", label: "评论（选填）" }] });
  if (!v) return OK;
  const metrics = Object.fromEntries((["views", "likes", "comments"] as const).filter((k) => v[k].trim()).map((k) => [k, Number(v[k])]));
  return res(await decide(p.contentId, "record_metrics", { platform: r.platform, round: p.desk.round, metric_date: v.metric_date.trim(), metrics, expected_work_id: r.work_id ?? "" }));
}

export function PublishTable(p: TableProps) {
  const g = useGuardedAction();
  const run = (label: string, fn: () => Promise<ActionResult>) => void g.run(label, async () => {
    const r = await fn();
    if (r.ok) await Promise.all([p.refresh(), p.reload()]);
    return r;
  });
  return <section className="desk-table" aria-label="各平台">
    <h3>各平台</h3>
    {p.desk.plan_error && <p className="desk-error" role="alert">发布计划读不到：{p.desk.plan_error} <button className="bcard-link" onClick={() => void p.refresh()}>重试</button></p>}
    {p.desk.rows.map((r) => <Row key={r.platform} r={r} busy={g.busy} run={run} p={p} />)}
    {g.error && <p className="desk-error" role="alert">没做成：{g.error} <button className="bcard-link" disabled={g.busy} onClick={() => void g.retry()}>重试</button></p>}
    {p.desk.past.length > 0 && <details className="desk-past">
      <summary>以前的发布 · {p.desk.past.length} 条</summary>
      {p.desk.past.map((x) => <p key={`${x.round}:${x.platform}`} className="muted">{x.label}{x.url ? <> · <a href={x.url} target="_blank" rel="noreferrer">作品链接</a></> : null}</p>)}
    </details>}
  </section>;
}

function Row({ r, busy, run, p }: { r: DeskRow; busy: boolean; run: (label: string, fn: () => Promise<ActionResult>) => void; p: TableProps }) {
  const [open, setOpen] = useState(false);
  return <div className={`desk-row is-${r.tone}${open ? " is-open" : ""}`}>
    <div className="desk-row-main">
      <button className="desk-row-platform" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{r.label}<span aria-hidden>{open ? "▾" : "▸"}</span></button>
      <span className="desk-row-status">{r.url && r.state === "已公开" ? <a href={r.url} target="_blank" rel="noreferrer">{r.status}</a> : r.status}{r.when && <small>{r.when}</small>}</span>
      <span className="desk-row-campaign">{r.campaigns.join("、")}</span>
      <span className={`desk-row-data${r.data.kind === "note" ? " is-note" : ""}`}>{dataText(r)}{r.data.kind === "metrics" && <small className={`is-${r.data.compare.tone}`}>{r.data.compare.text}</small>}{dataSub(r).map((t, i) => <small key={t} className={i ? "is-down" : undefined}>{t}</small>)}</span>
      <span className="desk-row-act">
        {r.action && <button className="primary" disabled={busy} onClick={() => run(`${r.action!.kind}:${r.platform}`, () => rowAction(p, r))}>{r.action.label}</button>}
        {r.more.length > 0 && <details className="stage-card-more"><summary aria-label={`${r.label}更多操作`}>更多</summary>
          <div className="stage-card-menu">{r.more.map((m) => <button key={m} disabled={busy} onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); run(`${m}:${r.platform}`, () => moreAction(p, r, m)); }}>{MORE_LABEL[m]}</button>)}</div>
        </details>}
      </span>
    </div>
    {open && <CopyPanel r={r} />}
  </div>;
}

/** 展开区：这个平台的标题 / 文案 / 标签 + 复制；复制失败写原因，文案留在框里手动选（边界 10） */
export function CopyPanel({ r }: { r: DeskRow }) {
  const [err, setErr] = useState<string | null>(null);
  const text = copyText(r.copy);
  if (!text || r.copy.kind !== "ready") return <div className="desk-copy"><p className="muted">{r.copy.kind === "ready" ? "没有文案" : r.copy.text}</p></div>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setErr(null); toast(`已复制${r.label}的文案`); }
    catch (e) { setErr(`复制没成功（${e instanceof Error ? e.message : "浏览器不让写剪贴板"}）：在下面框里选中手动复制`); }
  };
  return <div className="desk-copy">
    <p className="muted">{r.copy.source === "实发" ? "实发文案（发布计划里的）" : "拟发文案（发布包）"}</p>
    <textarea readOnly className="desk-copy-text" value={text} rows={Math.min(10, text.split("\n").length + 1)} onFocus={(e) => e.currentTarget.select()} />
    <div className="row-actions"><button onClick={() => void copy()}>复制文案</button>{err && <span className="desk-error" role="alert">{err}</span>}</div>
  </div>;
}
