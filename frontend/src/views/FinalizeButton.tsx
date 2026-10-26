/**
 * 稿件页顶栏「定稿」（视频稿）：写稿段一直在，AI 还占着也能点（服务端释放写手认领）；
 * 认的是保存过的那份正文（带哈希，别处改过服务端拒）。定过变成「已定稿 · 时刻」。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { useGuardedAction } from "./guarded-action";
import { sha256Hex } from "./StageCard";
import { finalizeView, type ScriptFinalState } from "./finalize-button";

export function FinalizeButton(p: { contentId: string; savedBody: string; refreshKey: string; dirty: boolean; reload: () => Promise<void> }) {
  const [s, setS] = useState<ScriptFinalState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const g = useGuardedAction();
  const load = useCallback(async () => {
    const r = await invoke("script:final_get", { id: p.contentId });
    if (!r.ok) { setLoadError(r.error ?? "定稿状态读不出来"); return; }
    setLoadError(null);
    setS((r.data as ScriptFinalState | null | undefined) ?? null);
  }, [p.contentId]);
  useEffect(() => { void load(); }, [load, p.refreshKey]);
  if (loadError) return <span className="ed-finalize is-error" role="alert">定稿状态读不出来：{loadError} <button className="bcard-link" onClick={() => void load()}>重试</button></span>;
  const v = finalizeView(s, p.dirty);
  if (v.kind === "hidden") return null;
  if (v.kind === "label") return <span className="ed-finalize ed-status-label">{v.text}</span>;
  const run = () => void g.run("定稿", async () => {
    if (p.dirty) return { ok: false, error: "先保存修改" };
    const r = await invoke("script:finalize", { id: p.contentId, expected_body_hash: await sha256Hex(p.savedBody) });
    if (!r.ok) { toast(`没定上：${r.error ?? "刷新再试"}`); await load(); return { ok: false, error: r.error ?? "没定上，刷新再试" }; }
    toast("定稿了：进入等 A-roll");
    await Promise.all([load(), p.reload()]);
    return { ok: true };
  });
  return <span className="ed-finalize">
    <button className="primary" disabled={v.disabled || g.busy} title={v.why} onClick={run}>{g.busy ? "定稿中…" : "定稿"}</button>
    {(v.why ?? v.reminder) && <span className="muted">{v.why ?? v.reminder}</span>}
    {g.error && <span className="stage-card-error" role="alert">没定上：{g.error} <button className="bcard-link" disabled={g.busy} onClick={() => void g.retry()}>重试</button></span>}
  </span>;
}
