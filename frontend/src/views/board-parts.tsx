/** 看板各步共用的小件：时间、产物地址（哈希校验）、在访达中显示、就地打回 */
import { useState } from "react";
import { clockLabel } from "../time-format";
import { rejectNoteError } from "./board-view";

/** 本地时区的「今天 17:50」 */
export const when = (iso?: string | null) => clockLabel(iso);

export function artifactUrl(contentId: string, a: { path: string; sha256: string }) {
  return `/api/project-artifact?content_id=${encodeURIComponent(contentId)}&path=${encodeURIComponent(a.path)}&sha256=${a.sha256}`;
}

/** 只传稿件 id + 目标名/产物指纹，路径由服务端按本条稿解析；失败原因在链接旁边明说 */
async function reveal(contentId: string, target: string): Promise<string | null> {
  try {
    const r = await fetch("/api/project-reveal", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_id: contentId, target }) });
    const body = await r.json().catch(() => null) as { ok?: boolean; opened?: boolean; path?: string; error?: string } | null;
    if (!r.ok || !body?.ok) return body?.error ?? `没打开（HTTP ${r.status}）`;
    return body.opened ? null : `这台机器打不开访达，路径：${body.path}`;
  } catch (e) { return `没打开：${e instanceof Error ? e.message : String(e)}`; }
}

export function RevealLink(props: { contentId: string; target: string; label?: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); setErr(await reveal(props.contentId, props.target)); setBusy(false); };
  return <span className="pb-reveal">
    <button className="pb-link" disabled={busy || !props.target} onClick={() => void go()}>{props.label ?? "在访达中显示"}</button>
    {err && <span className="pb-inline-error" role="alert">{err}</span>}
  </span>;
}

/** 「打回，写原话…」：就地展开输入框，原话必填，错误就地显示 */
export function RejectInline(props: { busy: boolean; disabled?: boolean; label?: string; onReject: (note: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button disabled={props.busy || props.disabled} onClick={() => setOpen(true)}>{props.label ?? "打回，写原话…"}</button>;
  const send = async () => {
    const problem = rejectNoteError(note);
    setErr(problem);
    if (problem) return;
    if (await props.onReject(note.trim())) { setOpen(false); setNote(""); }
  };
  return <div className="pb-reject">
    <textarea autoFocus rows={3} value={note} placeholder="写给 Codex 的原话，比如：开头 10 秒太慢，砍掉自我介绍" onChange={(e) => setNote(e.target.value)} />
    {err && <p className="pb-inline-error" role="alert">{err}</p>}
    <div className="pb-actions">
      <button disabled={props.busy} onClick={() => void send()}>打回</button>
      <button className="pb-link" onClick={() => { setOpen(false); setErr(null); }}>取消</button>
    </div>
  </div>;
}

export function MovieIcon() {
  return <svg className="pb-file-icon" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="2.5" y="4" width="15" height="12" rx="1.5" fill="none" stroke="currentColor" />
    <path d="M8.5 7.5v5l4-2.5z" fill="currentColor" />
  </svg>;
}
