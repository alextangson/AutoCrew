import { useEffect, useState } from "react";

type Artifact = { path: string; sha256: string; role: string };
type State = { enabled: boolean; title: string; platform: string; draft_hash: string; manifest_hash?: string;
  decisions?: { cover_text: string; target_seconds: number }; execution?: { artifacts: Artifact[]; heartbeat: { next_action: string } };
  approvals?: { final_cut?: unknown; covers?: unknown }; error?: string };

export function SharedProjectPanel({ contentId }: { contentId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [cover, setCover] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = `/api/project-review?content_id=${encodeURIComponent(contentId)}`;
  useEffect(() => {
    let live = true;
    fetch(url).then(r => r.json()).then((s: State) => {
      if (!live) return;
      setState(s); setCover(s.decisions?.cover_text ?? ""); setSeconds(s.decisions?.target_seconds ?? 0);
    }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [url]);
  async function submit(payload: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const s = await r.json();
      if (!r.ok || s.ok === false) throw new Error(s.error ?? "确认未保存");
      setState(s);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  if (!state?.enabled) return error ? <p role="alert">项目读取失败：{error}</p> : null;
  const files = state.execution?.artifacts ?? [];
  const final = files.find(f => f.role === "final-cut");
  const cover34 = files.find(f => f.role === "cover:3:4"), cover43 = files.find(f => f.role === "cover:4:3");
  const assetUrl = (f: Artifact) => `/api/project-artifact?content_id=${encodeURIComponent(contentId)}&path=${encodeURIComponent(f.path)}&sha256=${f.sha256}`;
  return <details className="panel" style={{ margin: "12px 24px", padding: 12 }}>
    <summary>项目交接与确认</summary>
    <p>当前标题：{state.title} · 平台：{state.platform}</p>
    <label>封面字 <input value={cover} onChange={e => setCover(e.target.value)} /></label>{" "}
    <label>目标时长（秒）<input type="number" min="1" value={seconds} onChange={e => setSeconds(Number(e.target.value))} /></label>{" "}
    <button disabled={busy || !cover.trim() || seconds <= 0} onClick={() => void submit({ action: "decisions", title: state.title, cover_text: cover, target_seconds: seconds, draft_hash: state.draft_hash })}>确认交接信息</button>
    {state.execution?.heartbeat.next_action && <p>剪辑报告的下一步：{state.execution.heartbeat.next_action}</p>}
    {files.filter(f => f.role === "rough_cut" || f.role === "storyboard").map(f => <div key={f.sha256}>
      <p>{f.role === "rough_cut" ? "粗剪" : "分镜与生成方案"}</p>
      {f.role === "rough_cut" ? <video src={assetUrl(f)} controls preload="metadata" style={{ maxWidth: "100%", maxHeight: 400 }} /> : <img src={assetUrl(f)} alt="分镜与生成方案" style={{ maxWidth: "100%", maxHeight: 600, objectFit: "contain" }} />}
      <button disabled={busy} onClick={() => void submit({ action: "approve", which: f.role, files: [f], manifest_hash: state.manifest_hash })}>确认这一版{f.role === "rough_cut" ? "粗剪" : "分镜方案"}</button>
    </div>)}
    {final && <div>
      <video key={final.sha256} src={assetUrl(final)} controls preload="metadata" style={{ maxWidth: "100%", maxHeight: 480 }} />
      <p><button disabled={busy} onClick={() => void submit({ action: "approve", which: "final_cut", files: [final], manifest_hash: state.manifest_hash })}>已完整审看并批准这版成片</button></p>
    </div>}
    {cover34 && cover43 && <div>
      {[cover34, cover43].map(f => <img key={f.sha256} src={assetUrl(f)} alt={f.role === "cover:3:4" ? "竖版封面" : "横版封面"} style={{ maxWidth: "45%", maxHeight: 350, objectFit: "contain", margin: 8 }} />)}
      <p><button disabled={busy} onClick={() => void submit({ action: "approve", which: "covers", files: [cover34, cover43], manifest_hash: state.manifest_hash })}>批准这两张封面</button></p>
    </div>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
