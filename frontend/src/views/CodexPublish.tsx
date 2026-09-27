/** 「让 Codex 发布」：准备发布指令 → 复制 → 打开这条视频的 Codex 对话。发送由创始人自己按（规则见 codex-publish.ts） */
import { useRef, useState } from "react";
import { invoke } from "../transport";
import { codexTargetLine, publishMessage, videoPlatforms } from "./codex-publish";
import { profilePlatformsOf } from "./platform-preview";
import type { ProjectReview } from "./project-board";

type Props = { contentId: string; title: string; status: string; review: ProjectReview; primary?: boolean };

export function CodexPublishButton(props: Props) {
  const [text, setText] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const open = async () => {
    if (preparing || text !== null) return;
    setPreparing(true);
    const platforms = videoPlatforms(profilePlatformsOf(await invoke("onboarding:status").catch(() => null)) ?? []);
    setText(publishMessage({ contentId: props.contentId, title: props.title, status: props.status, review: props.review, platforms }));
    setPreparing(false);
  };
  return <>
    <button className={props.primary ? "primary" : undefined} disabled={preparing} onClick={() => void open()}>让 Codex 发布</button>
    {text !== null && <CodexPublishDialog {...props} text={text} setText={setText} onClose={() => setText(null)} />}
  </>;
}

async function openCodex(contentId: string): Promise<string | null> {
  try {
    const r = await fetch("/api/open-codex", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_id: contentId }) });
    const body = await r.json().catch(() => null) as { ok?: boolean; opened?: boolean; link?: string; error?: string } | null;
    if (!r.ok || !body?.ok) return `${body?.error ?? `没打开（HTTP ${r.status}）`}${body?.link ? `。链接：${body.link}` : ""}`;
    return body.opened ? null : `这台机器打不开 Codex，链接：${body.link}`;
  } catch (e) { return `没打开：${e instanceof Error ? e.message : String(e)}`; }
}

function CodexPublishDialog(props: Props & { text: string; setText: (t: string) => void; onClose: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(props.text); setCopyFailed(false); return true; }
    catch { setCopyFailed(true); area.current?.select(); return false; }
  };
  const run = async (thenOpen: boolean) => {
    if (busy) return;
    setBusy(true); setNote(null);
    const copied = copyFailed && thenOpen ? false : await copy();
    const err = thenOpen ? await openCodex(props.contentId) : null;
    setBusy(false);
    if (err) setNote(err);
    else if (copied && thenOpen) props.onClose();
    else if (copied) setNote("已复制");
  };
  return <div className="pb-viewer pp-overlay" role="dialog" aria-modal="true" aria-label="让 Codex 发布" onClick={props.onClose}>
    <div className="pp-body cx-body" onClick={(e) => e.stopPropagation()}>
      <header className="pp-head"><strong>让 Codex 发布</strong><button className="pb-link" onClick={props.onClose}>关闭</button></header>
      <p className="muted">{codexTargetLine(props.review)}。发不发由你在 Codex 里按发送决定。</p>
      <textarea ref={area} className="cx-text" rows={12} value={props.text} onChange={(e) => props.setText(e.target.value)} />
      {copyFailed && <p className="pb-inline-error" role="alert">复制失败，请手动复制（⌘C）</p>}
      {note && <p className={note === "已复制" ? "muted" : "pb-inline-error"} role="status">{note}</p>}
      <div className="pb-actions">
        <button className="primary" disabled={busy} onClick={() => void run(true)}>{copyFailed ? "打开 Codex" : "复制并打开 Codex"}</button>
        <button disabled={busy} onClick={() => void run(false)}>只复制</button>
      </div>
    </div>
  </div>;
}
