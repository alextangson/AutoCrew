/**
 * 网页顶部的偏好提议条（发布前把关 spec §3、E6）：agent 调 propose_preference 提的新偏好，
 * 创始人点「确认」才写进账号资料，点「不要」就作废。只在有待确认提议时出现。
 */
import { useEffect, useState } from "react";
import { toast } from "../ui";
import { loadPublishPrefs, proposalText, publishPrefsOp, type Proposal } from "./publish-prefs-api";

const HOST_LABEL: Record<string, string> = { codex: "Codex", "claude-code": "Claude", "local-user": "总编辑" };
const POLL_MS = 30_000;

export function PreferenceBanner() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const r = await loadPublishPrefs();
    if (!r.ok) { setError(`读不了发布偏好提议：${r.error}`); return; }
    setError(null);
    setProposals(r.data.proposals);
    setLabels(Object.fromEntries(r.data.platforms.map((p) => [p.id, p.label])));
  };
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, []);
  const decide = async (id: string, decision: "confirm" | "dismiss") => {
    if (busy) return;
    setBusy(id);
    const r = await publishPrefsOp({ op: "decide_proposal", id, decision });
    setBusy(null);
    if (!r.ok) { toast(r.error); await load(); return; }
    toast(decision === "confirm" ? "已写进发布偏好" : "已放弃这条提议");
    setProposals(r.data.proposals);
  };
  if (!proposals.length && !error) return null;
  return <div className="pref-banner" role="status">
    {error && <p className="pb-inline-error">{error}</p>}
    {proposals.map((p) => <div key={p.id} className="pref-banner-row">
      <span>{HOST_LABEL[p.host] ?? p.host} 提议：{proposalText(p, (id) => labels[id] ?? id)}<span className="muted">（你的原话：「{p.founder_quote}」）</span></span>
      <button className="primary" disabled={busy !== null} onClick={() => void decide(p.id, "confirm")}>确认</button>
      <button disabled={busy !== null} onClick={() => void decide(p.id, "dismiss")}>不要</button>
    </div>)}
  </div>;
}
