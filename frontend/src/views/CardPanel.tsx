/**
 * 卡片面板（spec 2026-09-29 §10 一期最小面板）：阶段、还差什么、候选（是这条 / 不是这条）、A-roll 挂载（贴路径）、
 * 待核的发布回执、我发了 / 纠正、登记核对清单、重开文稿。成片 / 封面的通过仍在工作台（二期搬进来）。
 * 每个按钮都是创始人决定，走浏览器会话的 /api/board/decision。
 */
import { useCallback, useEffect, useState } from "react";
import { confirmDialog, toast } from "../ui";
import { decide, loadCard, reopenScript, type CardPanelData } from "./board-api";
import { UNDO } from "./board-columns";
import { platformName } from "./board-columns";

type Props = { contentId: string; onClose: () => void; openEditor: (id: string) => void; reload: () => Promise<void> };

export function CardPanel(p: Props) {
  const [data, setData] = useState<CardPanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [arollPath, setArollPath] = useState("");
  const refresh = useCallback(async () => {
    const r = await loadCard(p.contentId);
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  }, [p.contentId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (action: string, params: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const r = await decide(p.contentId, action, params);
      toast(r.ok ? done : r.error);
      await Promise.all([refresh(), p.reload()]);
      return r;
    } finally { setBusy(false); }
  };
  const attach = async () => {
    const r = await act("attach_aroll", { path: arollPath.trim() }, "A-roll 已挂上、挪进项目");
    if (!r.ok && r.error.includes("更像《")) {
      if (await confirmDialog({ title: "确定挂到这条？", body: r.error, confirmLabel: "挂到这条" })) await act("attach_aroll", { path: arollPath.trim(), confirm_other: true }, "A-roll 已挂上、挪进项目");
    }
  };
  const reopen = async () => {
    if (!(await confirmDialog({ title: UNDO.reopen.title, body: UNDO.reopen.body, confirmLabel: "重开文稿", danger: true }))) return;
    const r = await reopenScript(p.contentId);
    toast(r.ok ? "已重开文稿" : r.error);
    await Promise.all([refresh(), p.reload()]);
  };

  return <div className="card-panel-mask" role="dialog" aria-label="卡片详情" onClick={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
    <div className="card-panel">
      <header><h2>{data?.title ?? "读取中"}</h2><button className="bcard-link" onClick={p.onClose}>关闭</button></header>
      {error && <p className="board2-stale" role="alert">{error}</p>}
      {data && <PanelBody data={data} busy={busy} act={act} arollPath={arollPath} setArollPath={setArollPath} attach={attach} reopen={reopen} openEditor={() => p.openEditor(p.contentId)} />}
    </div>
  </div>;
}

function PanelBody(p: {
  data: CardPanelData; busy: boolean; act: (a: string, params: Record<string, unknown>, done: string) => Promise<unknown>;
  arollPath: string; setArollPath: (v: string) => void; attach: () => Promise<void>; reopen: () => Promise<void>; openEditor: () => void;
}) {
  const d = p.data;
  return <>
    <p className="card-panel-stage">{d.stage ?? d.column ?? "—"}{d.missing.length ? ` · 还差：${d.missing.join("、")}` : ""}</p>
    {d.badges.map((b) => <p key={b} className="card-panel-badge">{b}</p>)}
    {!d.active && <p className="bcol-note">这条还按旧流程走（本体没启用或被排除），只看不改。</p>}
    {d.active && d.candidates.length > 0 && <section><h3>发现的候选</h3>{d.candidates.map((c) => <div key={c.fact_id} className="card-panel-row">
      <span>{c.kind} · {c.path ?? ""}{c.evidence ? `（${c.evidence}）` : ""}</span>
      <button disabled={p.busy} onClick={() => void p.act("confirm_candidate", { fact_id: c.fact_id, sha256: c.sha256 }, "已确认是这条")}>是这条</button>
      <button disabled={p.busy} onClick={() => void p.act("reject_candidate", { fact_id: c.fact_id, sha256: c.sha256 }, "记住了：不是这条")}>不是这条</button>
    </div>)}</section>}
    {d.active && (d.column === "待录制" || d.missing.includes("A-roll")) && <section><h3>挂 A-roll</h3>
      <p className="bcol-note">把原片的完整路径贴进来（访达里选中文件按 ⌥⌘C 复制路径）。浏览器拿不到拖进来的文件路径，所以这里只收路径。</p>
      <input value={p.arollPath} onChange={(e) => p.setArollPath(e.target.value)} placeholder="/Users/…/原片.mov" />
      <button disabled={p.busy || !p.arollPath.trim()} onClick={() => void p.attach()}>挂到这条</button>
    </section>}
    {d.active && (d.pending_receipts ?? []).length > 0 && <section><h3>待你确认的发布</h3>{d.pending_receipts!.map((r) => <div key={r.fact_id} className="card-panel-row">
      <span>{r.host} 说已发到 {platformName(r.platform ?? "")}{r.url ? `：${r.url}` : ""}，是吗？</span>
      <button disabled={p.busy} onClick={() => void p.act("confirm_receipt", { fact_id: r.fact_id }, "已确认发布")}>是的</button>
      <button disabled={p.busy} onClick={() => void p.act("correct_publish", { target_id: r.fact_id }, "已记为没发")}>没发</button>
    </div>)}</section>}
    {d.active && <PublishedSection d={d} busy={p.busy} act={p.act} />}
    {d.active && d.checklist && <p className="bcol-note">实拍版核对清单：项目里的 {d.checklist}</p>}
    <footer className="card-panel-actions">
      <button onClick={p.openEditor}>打开稿件 / 工作台（成片、封面在那里通过）</button>
      {d.active && d.can_reopen && <button className="danger" disabled={p.busy} onClick={() => void p.reopen()}>重开文稿</button>}
    </footer>
  </>;
}

function PublishedSection(p: { d: CardPanelData; busy: boolean; act: (a: string, params: Record<string, unknown>, done: string) => Promise<unknown> }) {
  const [url, setUrl] = useState("");
  const d = p.d;
  const correct = async (id: string) => {
    if (await confirmDialog({ title: UNDO.correct_publish.title, body: UNDO.correct_publish.body, confirmLabel: "纠正", danger: true })) await p.act("correct_publish", { target_id: id }, "已纠正发布记录");
  };
  if (d.column !== "待发布" && d.column !== "已发布") return null;
  return <section><h3>发布</h3>
    {(d.published ?? []).map((x) => <div key={x.id} className="card-panel-row"><span>{platformName(x.platform ?? "")} · {x.label}{x.url ? ` · ${x.url}` : ""}</span>
      <button disabled={p.busy} onClick={() => void correct(x.id)}>纠正</button></div>)}
    <div className="card-panel-row">
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="作品链接（可不填）" />
      <button disabled={p.busy} onClick={() => void p.act("i_published", { platform: d.platform, ...(url.trim() ? { url: url.trim() } : {}) }, "已记为你发了")}>我发了</button>
    </div>
  </section>;
}
