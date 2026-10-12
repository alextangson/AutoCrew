/**
 * 进度栏下半截（发布台 spec 补做 A / B）：「在访达打开这一条」+ 折叠的「交接详情」。
 * 打开的是「我的内容」里这条的文件夹；视图里没有就写原因，另给一个明说的「打开项目文件夹」，不偷偷换文件夹。
 */
import { useState } from "react";
import { authedFetch } from "../transport";
import { when } from "./board-parts";
import type { CardPanelData } from "./board-api";
import type { Desk } from "./desk-api";

type Reply = { ok?: boolean; code?: string; error?: string; opened?: boolean; path?: string };

async function post(url: string, body: Record<string, string>): Promise<Reply> {
  try {
    const r = await authedFetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null) as Reply | null;
    return j ?? { ok: false, error: `没打开（HTTP ${r.status}）` };
  } catch (e) { return { ok: false, error: `没打开：${e instanceof Error ? e.message : String(e)}` }; }
}

export function RevealThis({ contentId }: { contentId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const [rootErr, setRootErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setRootErr(null);
    const r = await post("/api/my-content-reveal", { content_id: contentId });
    setErr(r.ok ? null : r.error ?? "没打开");
    setFallback(!r.ok && r.code === "not_in_view");
    setBusy(false);
  };
  const openRoot = async () => {
    const r = await post("/api/project-reveal", { content_id: contentId, target: "project_root" });
    setRootErr(!r.ok ? r.error ?? "没打开" : r.opened ? null : `这台机器打不开访达，路径：${r.path}`);
  };
  return <div className="desk-reveal">
    <button className="bcard-link" disabled={busy} onClick={() => void go()}>在访达打开这一条</button>
    {err && <p className="desk-error" role="alert">{err}</p>}
    {fallback && <button className="bcard-link" onClick={() => void openRoot()}>打开项目文件夹</button>}
    {rootErr && <p className="desk-error" role="alert">{rootErr}</p>}
  </div>;
}

function claimText(c: CardPanelData["claim"]): string {
  if (!c) return "没有 AI 认领";
  const lease = c.lease_ok === false ? "租约已过期" : "租约有效";
  return `${c.host} · ${lease}${c.idle_hours !== null ? ` · ${c.idle_hours} 小时没动静` : ""}`;
}

export function HandoffFacts({ desk, claim }: { desk: Desk; claim: CardPanelData["claim"] }) {
  const h = desk.handoff;
  return <details className="desk-handoff">
    <summary>交接详情</summary>
    {!h ? <p className="muted">还没交给剪辑</p> : <dl className="pb-facts">
      <dt>交接</dt><dd>第 {h.generation} 代</dd>
      <dt>交接时间</dt><dd>{when(h.at)}</dd>
      <dt>持有会话</dt><dd>{h.session || "没有记录"}</dd>
      <dt>指纹</dt><dd className="mono">{h.fingerprint}</dd>
      <dt>原片</dt><dd>{h.aroll ?? "还没有收到原片"}</dd>
    </dl>}
    <p><span className="muted">当前认领</span> {claimText(claim)}</p>
  </details>;
}

export function RailDetails({ contentId, desk, claim }: { contentId: string; desk: Desk; claim: CardPanelData["claim"] }) {
  return <><RevealThis contentId={contentId} /><HandoffFacts desk={desk} claim={claim} /></>;
}
