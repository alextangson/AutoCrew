/** 「让 Codex 发布」：准备发布指令 → 复制 → 打开这条视频的 Codex 对话。发送由创始人自己按（规则见 codex-publish.ts） */
import { useRef, useState } from "react";
import { invoke } from "../transport";
import { codexTargetLine, publishMessage, publishPlatforms } from "./codex-publish";
import { profilePlatformsOf } from "./platform-preview";
import { saveInstruction, skipResave } from "./publish-prefs-api";
import type { ProjectReview } from "./project-board";

type Props = { contentId: string; title: string; status: string; review: ProjectReview; primary?: boolean };

type Choice = { defaults: string[]; optional: string[]; picked: string[] };

/** 这条稿自己的平台 + 兄弟变体的平台（读不到就只剩空，让创始人在弹窗里勾） */
async function ownPlatforms(contentId: string): Promise<string[]> {
  const get = async (id: string) => (await invoke("content:get", { id }).catch(() => null) as unknown as { ok?: boolean; content?: { platform?: string; siblings?: string[] } } | null)?.content ?? null;
  const self = await get(contentId);
  const siblings = await Promise.all((self?.siblings ?? []).map(get));
  return [self?.platform, ...siblings.map((c) => c?.platform)].filter((p): p is string => typeof p === "string");
}

export function CodexPublishButton(props: Props) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const compose = (picked: string[]) => publishMessage({ contentId: props.contentId, title: props.title, status: props.status, review: props.review, platforms: picked });
  const open = async () => {
    if (preparing || text !== null) return;
    setPreparing(true);
    const [own, profile] = await Promise.all([ownPlatforms(props.contentId), invoke("onboarding:status").catch(() => null)]);
    const split = publishPlatforms(own, profilePlatformsOf(profile) ?? []);
    setChoice({ ...split, picked: split.defaults });
    setText(compose(split.defaults));
    setPreparing(false);
  };
  const toggle = (name: string) => {
    if (!choice) return;
    const all = [...choice.defaults, ...choice.optional];
    const picked = all.filter((p) => (p === name ? !choice.picked.includes(p) : choice.picked.includes(p)));
    setChoice({ ...choice, picked });
    setText(compose(picked));
  };
  const close = () => { setText(null); setChoice(null); };
  return <>
    <button className={props.primary ? "primary" : undefined} disabled={preparing} onClick={() => void open()}>让 Codex 发布</button>
    {text !== null && <CodexPublishDialog {...props} text={text} setText={setText} onClose={close} choice={choice} toggle={toggle} />}
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

function CodexPublishDialog(props: Props & { text: string; setText: (t: string) => void; onClose: () => void; choice: Choice | null; toggle: (name: string) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  /** 最近一次存到服务端的文本（带编号行）：文本改过就必须重存，不能沿用旧编号 */
  const [savedText, setSavedText] = useState<string | null>(null);
  const openOnly = skipResave(copyFailed, props.text, savedText);
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopyFailed(false); return true; }
    catch { setCopyFailed(true); requestAnimationFrame(() => area.current?.select()); return false; }
  };
  /** 发布前把关 §6：复制前先把编辑后的文本存到服务端，末行带上指令编号；存不上就不复制，免得 Codex 拿到查不到的指令 */
  const saveAndCopy = async (via: "copy" | "copy_open"): Promise<boolean | null> => {
    const saved = await saveInstruction(props.contentId, props.text, via);
    if (!saved.ok) { setNote(`指令没存上，所以没复制：${saved.error}`); return null; }
    props.setText(saved.data.copy_text);
    setSavedText(saved.data.copy_text);
    return copy(saved.data.copy_text);
  };
  const run = async (thenOpen: boolean) => {
    if (busy) return;
    setBusy(true); setNote(null);
    // 上次复制失败、手动复制的正是已存的那份（文本一字没改）→ 这次只打开；改过就重存重复制
    const copied = openOnly && thenOpen ? false : await saveAndCopy(thenOpen ? "copy_open" : "copy");
    if (copied === null) { setBusy(false); return; }
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
      {props.choice && props.choice.defaults.length + props.choice.optional.length > 0 && <fieldset className="cx-platforms">
        <legend>发到哪些平台（默认只勾这条稿自己的平台；改勾选会重写下面的指令）</legend>
        {[...props.choice.defaults, ...props.choice.optional].map((p) => <label key={p}>
          <input type="checkbox" checked={props.choice!.picked.includes(p)} onChange={() => props.toggle(p)} /> {p}{props.choice!.optional.includes(p) ? "（可选）" : ""}
        </label>)}
      </fieldset>}
      <textarea ref={area} className="cx-text" rows={12} value={props.text} onChange={(e) => props.setText(e.target.value)} />
      {copyFailed && <p className="pb-inline-error" role="alert">复制失败，请手动复制（⌘C）</p>}
      {note && <p className={note === "已复制" ? "muted" : "pb-inline-error"} role="status">{note}</p>}
      <div className="pb-actions">
        <button className="primary" disabled={busy} onClick={() => void run(true)}>{openOnly ? "打开 Codex" : "复制并打开 Codex"}</button>
        <button disabled={busy} onClick={() => void run(false)}>只复制</button>
      </div>
    </div>
  </div>;
}
