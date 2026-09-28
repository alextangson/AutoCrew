/** 看板的回收站：选题和稿件都能恢复（§6：回收站入口保留） */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { platformLabel, type Content, type Topic } from "../lib";

interface TrashData { topics: Topic[]; contents: Content[] }

export function BoardTrash(props: { back: () => void }) {
  const [trash, setTrash] = useState<TrashData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const r = await invoke("trash:list");
    if (!r.ok) return setError(r.error ?? "回收站加载失败");
    const d = ((r as Record<string, unknown>).data ?? r) as unknown as TrashData;
    setTrash({ topics: d.topics ?? [], contents: d.contents ?? [] });
    setError(null);
  };
  useEffect(() => { void load(); }, []);
  const restore = async (channel: string, id: string) => {
    const r = await invoke(channel, { id });
    toast(r.ok ? "已恢复" : r.error ?? "恢复失败");
    if (r.ok) await load();
  };
  return <div className="board-trash">
    <div className="board-bar">
      <button onClick={props.back}>← 看板</button>
      <span className="serif board-title">回收站</span>
    </div>
    {error && <p className="acard-err" role="alert">{error} <button onClick={() => void load()}>重试</button></p>}
    {!trash && !error && <p className="muted pad">读取中</p>}
    {trash && trash.topics.length + trash.contents.length === 0 && <p className="muted pad">回收站是空的。</p>}
    {trash?.topics.map((t) => <div key={t.id} className="row">
      <span className="mono pri">选题</span><span className="row-title">{t.title}</span>
      <button onClick={() => void restore("topic:restore", t.id)}>恢复</button>
    </div>)}
    {trash?.contents.map((c) => <div key={c.id} className="row">
      <span className="mono pri">{platformLabel(c.platform)}</span><span className="row-title">{c.title}</span>
      <button onClick={() => void restore("content:restore", c.id)}>恢复</button>
    </div>)}
  </div>;
}
