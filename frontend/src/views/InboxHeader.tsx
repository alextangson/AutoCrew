/**
 * 待录制列头的收件箱提示（1b §4）：「收件箱里有 N 个视频没对上」（只数收件箱，监视文件夹不算）、
 * 「N 个视频没核对成：原因」、在核对的个数。点开列表：文件名、大小、时间、猜测、「指定给…」（= 卡片挂载决定）、「在访达中显示」。
 */
import { useState } from "react";
import { toast } from "../ui";
import { decide, revealSource } from "./board-api";
import type { InboxStatus } from "./board-columns";

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;
const when = (ms: number) => new Date(ms).toLocaleString();

export function InboxHeader(p: { inbox: InboxStatus | undefined; targets: Array<{ id: string; title: string }>; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inbox = p.inbox;
  if (!inbox || (!inbox.unmatched.length && !inbox.failed.length && !inbox.checking)) return null;
  const assign = async (file: string, id: string) => {
    if (!id) return;
    setBusy(true);
    try {
      const r = await decide(id, "attach_aroll", { path: file });
      toast(r.ok ? "已挂上、挪进项目" : r.error);
      if (r.ok) await p.reload();
    } finally { setBusy(false); }
  };
  const reveal = async (file: string) => { const r = await revealSource(file); if (!r.ok) toast(r.error); };
  return <div className="bcol-inbox">
    {inbox.unmatched.length > 0 && <button className="bcard-link" aria-expanded={open} onClick={() => setOpen(!open)}>收件箱里有 {inbox.unmatched.length} 个视频没对上</button>}
    {inbox.failed.length > 0 && <p className="bcol-refuse" role="status">{inbox.failed.length} 个视频没核对成：{inbox.failed.map((f) => `${f.name}（${f.reason}）`).join("；")}</p>}
    {inbox.checking > 0 && <p className="bcol-note">收件箱里 {inbox.checking} 个视频正在核对</p>}
    {open && <ul className="bcol-inbox-list">{inbox.unmatched.map((f) => <li key={f.path}>
      <strong>{f.name}</strong> <span className="muted">{mb(f.size)} · {when(f.mtime_ms)}</span>
      {f.guess.length > 0 && <span className="muted"> · 猜测：{f.guess.join("、")}</span>}
      <div className="card-panel-row">
        <select aria-label={`把 ${f.name} 指定给`} disabled={busy || !p.targets.length} defaultValue="" onChange={(e) => void assign(f.path, e.target.value)}>
          <option value="">{p.targets.length ? "指定给…" : "没有等原片的稿"}</option>
          {p.targets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <button className="bcard-link" onClick={() => void reveal(f.path)}>在访达中显示</button>
      </div>
    </li>)}</ul>}
  </div>;
}
