/**
 * 「原片从哪里找」（1b §5）：收件箱（固定，只读）、监视文件夹（给建议 / 允许 agent 直接搬入）、暂停自动找原片、转写环境。
 * 这些决定 agent 能从哪里直接搬文件，只收这个页面（浏览器会话）的修改。
 */
import { useEffect, useState } from "react";
import { toast } from "../ui";
import { videoAsrWarmup } from "../lib";
import { chooseFolder, loadSources, revealSource, sourceOp, type ArollSourcesView, type WatchFolderView } from "./board-api";
import { Section } from "./settings-kit";

function FolderRow(p: { f: WatchFolderView; busy: boolean; op: (op: string, params: Record<string, unknown>, done: string) => Promise<void> }) {
  const f = p.f;
  const last = f.last;
  return <li className="set-folder">
    <div className="card-panel-row"><strong className="mono">{f.path}</strong>
      <button className="bcard-link" onClick={() => void revealSource(f.path).then((r) => { if (!r.ok) toast(r.error); })}>在访达中显示</button>
      <button className="bcard-link" disabled={p.busy} onClick={() => void p.op("remove_folder", { path: f.path }, "已删掉这个监视文件夹")}>删除</button>
    </div>
    <label><input type="checkbox" checked={f.scan} disabled={p.busy} onChange={(e) => void p.op("set_folder", { path: f.path, scan: e.target.checked }, e.target.checked ? "会在这里找原片给建议" : "不再在这里找")} />给建议</label>{" "}
    <label><input type="checkbox" checked={f.allow_move} disabled={p.busy} onChange={(e) => void p.op("set_folder", { path: f.path, allow_move: e.target.checked }, e.target.checked ? "agent 报这里的原片会直接挪进项目" : "agent 报这里的原片只记候选")} />允许 agent 直接搬入</label>
    {f.problem && <p role="alert">{f.problem}</p>}
    {last?.error ? <p role="alert">{last.error}</p> : last ? <p className="muted">最近一次扫描 {new Date(last.at).toLocaleString()}：看了 {last.files} 个视频，给了 {last.suggested} 条建议</p> : <p className="muted">还没扫过</p>}
  </li>;
}

export function SettingsArollSources() {
  const [data, setData] = useState<ArollSourcesView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const load = async () => {
    const r = await loadSources();
    if (!r.ok) return setError(r.error);
    setError("");
    setData(r.data);
  };
  useEffect(() => { void load(); }, []);
  const op = async (name: string, params: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const r = await sourceOp(name, params);
      toast(r.ok ? done : r.error);
      await load();
    } finally { setBusy(false); }
  };
  const pick = async () => {
    const r = await chooseFolder();
    if (!r.ok) return toast(r.error);
    await op("add_folder", { path: r.data.path, scan: true }, "已加监视文件夹");
  };
  const warm = async () => { const r = await videoAsrWarmup(); toast(r.ok ? "已开始预热转写模型" : r.error || "预热没有启动"); };
  return <Section title="原片从哪里找" on={Boolean(data?.asr.ready)} status={data ? (data.paused ? "已暂停" : "自动找") : ""}>
    <p>原片放进收件箱会自动核对是哪条稿，对上了就挪进项目；监视文件夹里只给建议。</p>
    {error && <p role="alert">{error}</p>}
    {data && <>
      <p>收件箱：<span className="mono">{data.inbox ?? "（没连资料库）"}</span>{data.inbox && <> <button className="bcard-link" onClick={() => void revealSource(data.inbox!).then((r) => { if (!r.ok) toast(r.error); })}>在访达中显示</button></>}</p>
      <h4>监视文件夹</h4>
      {data.folders.length ? <ul>{data.folders.map((f) => <FolderRow key={f.path} f={f} busy={busy} op={op} />)}</ul> : <p className="muted">还没有。加了之后会在里面找像原片的视频（只看顶层、14 天内）。</p>}
      <div className="card-panel-row">
        <button className="primary" disabled={busy} onClick={() => void pick()}>添加文件夹…</button>
        <input value={draft} placeholder="/Users/你/Downloads" disabled={busy} onChange={(e) => setDraft(e.target.value)} />
        <button disabled={busy || !draft.trim()} onClick={() => void op("add_folder", { path: draft.trim(), scan: true }, "已加监视文件夹").then(() => setDraft(""))}>加这个路径</button>
      </div>
      <label><input type="checkbox" checked={data.paused} disabled={busy} onChange={(e) => void op("set_paused", { paused: e.target.checked }, e.target.checked ? "已暂停自动找原片（agent 报的和卡片挂的照常核对）" : "已恢复自动找原片")} />暂停自动找原片</label>
      <p>转写环境：{data.asr.ready ? "已就绪" : `没就绪（${data.asr.reason}）——只比文件名`}{!data.asr.ready && <> <button className="bcard-link" onClick={() => void warm()}>预热转写模型</button></>}</p>
    </>}
  </Section>;
}
