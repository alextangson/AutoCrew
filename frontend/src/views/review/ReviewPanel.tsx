/**
 * 「等你拍板」右侧面板（review-inbox §3.1、§4）：Notion 页面预览式——大标题、2–4 行属性、预览、按钮。
 * 只放处理这件事要的东西。按钮全是后端给的 actions（params 原样交回）；带「…」的动作就地展开输入框，回车发送。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { relativeLabel } from "../../time-format";
import { openStoryboard } from "../board-api";
import { attachmentUrl, inboxFileUrl, mediaUrl } from "./review-api";
import { platformName } from "../board-columns";
import { plainWords, type InboxAction, type InboxItem } from "./review-model";

export type Act = (a: InboxAction, extra?: Record<string, unknown>) => Promise<void>;

/**
 * 回车 = 面板上的主按钮（整分支审 P1）：面板把「现在点主按钮会交什么」登记上来——正在看的那一版、选的那一组、改过的封面字都在里面，
 * 键盘和鼠标交的是同一个东西。
 */
export const PrimaryContext = createContext<(fn: (() => void) | null) => void>(() => {});

const variant = (r: InboxAction["role"]) => (r === "primary" ? "primary" : r === "quiet" ? "quiet" : "secondary");

interface Version { fact_id: string; sha256: string; at: string; label: string; ready?: boolean; approved?: boolean; has_srt?: boolean; blocked_reason?: string }
interface Group { group_id: string; label: string; at: string; text: string; approved: boolean; "3:4": { fact_id: string; sha256: string } | null; "4:3": { fact_id: string; sha256: string } | null }

/** 安静的分段胶囊：只切「看哪一版」，不是动作；标签是时间，不写版本号 */
export function VersionPill<T extends { label: string; at: string }>(p: { list: T[]; index: number; onPick: (i: number) => void }) {
  if (p.list.length < 2) return null;
  return <div className="ri-pill" role="tablist" aria-label="看哪一版">
    {p.list.map((v, i) => <span key={i} role="tab" aria-selected={i === p.index} className={i === p.index ? "ri-pill-on" : ""} title={relativeLabel(v.at)} onClick={() => p.onPick(i)}>{v.label}</span>)}
  </div>;
}

function Props(p: { rows: Array<[string, ReactNode]> }) {
  return <dl className="ri-props">{p.rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/** 就地输入框：回车发送，Shift+回车换行 */
/** 这个动作的「一句话」其实是作品链接（「发了吗」） */
const takesUrl = (a: InboxAction) => a.action === "i_published";
/** 只认 http / https 链接；不对就说哪里不对 */
export function urlProblem(text: string): string | null {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:" ? null : "作品链接要以 http:// 或 https:// 开头";
  } catch { return "这不像一个链接：贴作品页的完整地址（https://…）"; }
}

function Inline(p: { a: InboxAction; onSend: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const send = () => {
    const t = note.trim();
    if (p.a.note === "required" && !t) return;
    // 作品链接就地校验（整分支审 15 P2）：空着 = 不填链接，照常记「发了」
    const bad = t && takesUrl(p.a) ? urlProblem(t) : null;
    if (bad) { setErr(bad); return; }
    p.onSend(t);
  };
  return <div className="ri-inline">
    <textarea autoFocus value={note} placeholder={p.a.placeholder ?? "写一句"} onChange={(e) => { setNote(e.target.value); setErr(null); }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === "Escape") p.onCancel(); }} />
    {err && <p className="ri-reason" role="alert">{err}</p>}
    <div className="ri-actions"><Button variant="primary" onClick={send}>发送</Button><Button variant="quiet" onClick={p.onCancel}>算了</Button></div>
  </div>;
}

/** 按钮行：主 / 次 / 少用（少用放右侧）；条件不够时按钮位置写原因，不放灰按钮 */
export function Actions(p: { item: InboxItem; act: Act; extra?: () => Record<string, unknown>; only?: (a: InboxAction) => boolean; noEnter?: boolean }) {
  const [open, setOpen] = useState<InboxAction | null>(null);
  const list = p.item.actions.filter(p.only ?? (() => true));
  const run = (a: InboxAction, note?: string) => void p.act(a, { ...(p.extra?.() ?? {}), ...(note ? { note } : {}) });
  const register = useContext(PrimaryContext);
  const primary = !p.item.blocked_reason && !open ? list.find((a) => a.role === "primary" && a.note !== "required") : undefined;
  // 每次渲染都重新登记：闭包里是这一刻面板上的选择
  useEffect(() => {
    if (p.noEnter) return;
    register(primary ? () => run(primary) : null);
    return () => register(null);
  });
  if (open) return <Inline a={open} onSend={(n) => { setOpen(null); run(open, n); }} onCancel={() => setOpen(null)} />;
  const loud = list.filter((a) => a.role !== "quiet"), quiet = list.filter((a) => a.role === "quiet");
  const click = (a: InboxAction) => (a.note === "required" ? setOpen(a) : run(a));
  // 只给「一件事一个可补一句的动作」开这个入口（整分支审 16 P1）：请示的每个选项都带 note，多个同名「补一句…」会悄悄替创始人选了某个选项；请示有自己的「说一句…」
  const optionalAll = loud.filter((a) => a.note === "optional" && a.action !== "answer_ask" && !(p.item.blocked_reason && a.role === "primary"));
  const optional = optionalAll.length === 1 ? optionalAll : [];
  // 条件不够时：主按钮的位置写原因（不放灰按钮），次按钮照给（verifier 2a P2：「还要改…」要留着）
  return <div className="ri-actions">
    {p.item.blocked_reason && <span className="ri-reason">{p.item.blocked_reason}</span>}
    {loud.filter((a) => !(p.item.blocked_reason && a.role === "primary")).map((a, i) => <Button key={`${a.action}-${i}`} variant={variant(a.role)} onClick={() => click(a)}>{a.label}</Button>)}
    {/* 可写可不写的动作：按钮照样一点就记；旁边一个安静的入口展开输入框（整分支审 15 P2） */}
    {(quiet.length > 0 || optional.length > 0) && <span className="ri-quiet-slot">
      {optional.map((a, i) => <Button key={`${a.action}-o${i}`} variant="quiet" onClick={() => setOpen(a)}>{takesUrl(a) ? "填作品链接…" : "补一句…"}</Button>)}
      {quiet.map((a, i) => <Button key={`${a.action}-q${i}`} variant="quiet" onClick={() => click(a)}>{a.label}</Button>)}
    </span>}
  </div>;
}

// ---- 各类的正文 ----

function CutBody(p: { item: InboxItem; act: Act }) {
  const versions = (p.item.detail.versions as Version[]) ?? [];
  const reviewId = String(p.item.detail.review_fact_id ?? "");
  const [idx, setIdx] = useState(Math.max(0, versions.findIndex((v) => v.fact_id === reviewId)));
  const v = versions[idx];
  return <>
    <Props rows={[["稿子", p.item.title], ["剪好", v ? relativeLabel(v.at) : null], ["谁剪的", String(p.item.detail.editor_label ?? "")], ["字幕", v ? (v.has_srt ? "这版有字幕" : "这版还没有字幕") : null]]} />
    <VersionPill list={versions} index={idx} onPick={setIdx} />
    {v && p.item.content_id && <div className="ri-preview"><video controls preload="metadata" src={mediaUrl(p.item.content_id, v.fact_id)} /></div>}
    {v?.approved && <p className="ri-note">这一版现在是定下的那版</p>}
    {/* 拦不拦按正在看的这一版算（整分支审 10 P2）：最新一版被拦不连累上一版 */}
    <Actions item={v ? { ...p.item, blocked_reason: v.blocked_reason ?? (v.fact_id === reviewId ? p.item.blocked_reason : undefined) } : p.item} act={p.act} extra={() => (v ? { fact_id: v.fact_id } : {})} />
  </>;
}

function CoverBody(p: { item: InboxItem; act: Act }) {
  const groups = (p.item.detail.groups as Group[]) ?? [];
  // 一打开就选中这件事要你看的那一组（主按钮绑的组），不是列表第一组（整分支审 8 P2）
  const wanted = p.item.actions.find((a) => a.action === "pick_cover")?.params?.group_id;
  const [idx, setIdx] = useState(() => Math.max(0, groups.findIndex((g) => g.group_id === wanted)));
  const g = groups[idx];
  // 封面字预填（组里的字，或交接时你确认过的字）；空着也能用这组，就是不带封面字
  const [text, setText] = useState(g?.text ?? "");
  useEffect(() => { setText(g?.text ?? ""); }, [g?.group_id, g?.text]);
  const incomplete = typeof p.item.detail.incomplete_note === "string" ? p.item.detail.incomplete_note : null;
  const img = (x: Group["3:4"]) => (x?.fact_id && p.item.content_id ? <img alt="" src={mediaUrl(p.item.content_id, x.fact_id)} /> : null);
  return <>
    <Props rows={[["稿子", p.item.title], ["做好", g ? relativeLabel(g.at) : null], ["谁做的", p.item.waiting?.label ?? ""]]} />
    <VersionPill list={groups} index={idx} onPick={setIdx} />
    {g && <div className="ri-preview ri-covers"><figure>{img(g["3:4"])}<figcaption>竖版 3:4</figcaption></figure><figure>{img(g["4:3"])}<figcaption>横版 4:3</figcaption></figure></div>}
    <input className="ri-textline ri-textline-sm" aria-label="封面上的字" value={text} onChange={(e) => setText(e.target.value)} placeholder="封面上的字（可不填）" />
    {incomplete && <p className="ri-note">{incomplete}</p>}
    <Actions item={p.item} act={p.act} extra={() => (g ? { group_id: g.group_id, cover_text: text.trim() } : {})} />
  </>;
}

function AskBody(p: { item: InboxItem; act: Act }) {
  const d = p.item.detail;
  const [note, setNote] = useState("");
  const [talk, setTalk] = useState(false);
  const atts = (d.attachments as Array<{ index: number; name: string; html: boolean; path: string }>) ?? [];
  const cid = p.item.content_id ?? "";
  const media = (a: { index: number; name: string }) => /\.(png|jpe?g|webp|gif)$/i.test(a.name) ? <img alt={a.name} src={attachmentUrl(cid, String(d.ask_id), a.index)} style={{ maxWidth: "100%", borderRadius: 8 }} />
    : /\.(mp4|mov|m4v)$/i.test(a.name) ? <video controls preload="metadata" src={attachmentUrl(cid, String(d.ask_id), a.index)} style={{ width: "100%" }} /> : <p className="ri-note">{a.name}（到项目文件夹里看）</p>;
  return <>
    <Props rows={[["稿子", p.item.title], ["谁问的", p.item.waiting?.label ?? ""], ["问的时候", relativeLabel(p.item.since)]]} />
    <p className="ri-question">{String(d.question ?? "")}</p>
    {Boolean(d.storyboard_fact_id) && <p><Button variant="secondary" onClick={() => void openStoryboard(cid, String(d.storyboard_fact_id))}>在浏览器里打开分镜</Button></p>}
    {d.attachments_changed ? <p className="ri-warn">附件变过，请重新发请示：问你的那份已经不是现在盘上的这份了</p>
      : atts.map((a) => <div key={a.index} className="ri-preview">{a.html ? <p className="ri-note">{a.name}：网页附件请到项目文件夹里用浏览器打开</p> : media(a)}</div>)}
    {talk && <textarea className="ri-textline" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="比如：就这样，但配乐再轻一点" />}
    <Actions item={p.item} act={p.act} extra={() => (note.trim() ? { note: note.trim() } : {})} />
    {!talk && !p.item.blocked_reason && !d.attachments_changed && <Button variant="quiet" onClick={() => setTalk(true)}>说一句…</Button>}
  </>;
}

function SliverBody(p: { item: InboxItem; act: Act }) {
  const rows = (p.item.detail.items as Array<{ key: string; start_tc: string; frames: number; prev_name: string | null; next_name: string | null; suggestion: string | null; waived: boolean; action: InboxAction }>) ?? [];
  return <>
    <Props rows={[["稿子", p.item.title], ["检查", String(p.item.detail.status) === "slivers" ? `${rows.filter((r) => !r.waived).length} 处闪帧` : `没查成：${String(p.item.detail.reason ?? "")}`]]} />
    <ul className="ri-check">{rows.map((r) => <li key={r.key}>{r.start_tc} 露出真人 {r.frames} 帧（「{r.prev_name ?? "前一段"}」和「{r.next_name ?? "后一段"}」之间）{r.suggestion ? ` · 建议：${r.suggestion}` : ""}
      {" "}{r.waived ? <span className="ri-note">已放行</span> : <Button variant="quiet" onClick={() => void p.act(r.action)}>{r.action.label}</Button>}</li>)}</ul>
    <Actions item={p.item} act={p.act} />
  </>;
}

/** 检查结论说人话（verifier 2a P2）：被拦 → 不能发；有提醒 / 有没查成的 → 说哪些没查；都过才说「都没问题」 */
export function checkLine(verdict: string, rows: Array<{ check?: string; result?: string; basis?: string }>): string {
  if (verdict === "block") return "被拦了，现在不能发";
  const notRun = rows.filter((r) => r.result === "warn" && /没跑|没查|not_run|未运行/.test(`${r.basis ?? ""}${r.check ?? ""}`));
  if (notRun.length) return `有 ${notRun.length} 项没查成（比如内容复核没跑），自己再看一眼`;
  if (verdict === "warn" || rows.some((r) => r.result === "warn")) return "有几处要留意";
  return "都没问题";
}

function CheckBody(p: { item: InboxItem; act: Act }) {
  const rows = (p.item.detail.items as Array<{ check?: string; result?: string; basis?: string }>) ?? [];
  const shown = rows.filter((r) => r.result === "block" || r.result === "warn");
  return <>
    <Props rows={[["稿子", p.item.title], ["平台", platformName(String(p.item.detail.platform ?? ""))], ["检查", checkLine(String(p.item.detail.verdict ?? ""), rows)]]} />
    <ul className="ri-check">{shown.map((r, i) => <li key={i}>{r.result === "block" ? "要改：" : "留意："}{plainWords(r.basis ?? r.check ?? "")}</li>)}</ul>
    <Actions item={p.item} act={p.act} />
  </>;
}

/** 候选的样子：封面是图、成片 / 原片是播放器；一句人话的「为什么」和文件名 */
export function CandidatePreview(p: { item: InboxItem }) {
  const d = p.item.detail, cid = p.item.content_id;
  if (!cid || !d.preview) return null;
  if (d.kind === "cover") return <div className="ri-preview"><img alt={String(d.name ?? "")} src={mediaUrl(cid, String(d.fact_id))} style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8 }} /></div>;
  if (d.kind === "cut" || d.kind === "aroll") return <div className="ri-preview"><video controls preload="metadata" src={mediaUrl(cid, String(d.fact_id))} /></div>;
  return null;
}

function CandidateBody(p: { item: InboxItem; act: Act }) {
  const d = p.item.detail;
  return <>
    <Props rows={[["稿子", p.item.title], ["为什么", d.reason ? String(d.reason) : null], ["文件", d.name ? String(d.name) : null]]} />
    <CandidatePreview item={p.item} />
    <Actions item={p.item} act={p.act} />
  </>;
}

/** 「Claude 说已经发了」：先给链接、说法和依据，再让创始人认（整分支审 15 P2） */
function ClaimBody(p: { item: InboxItem; act: Act }) {
  const d = p.item.detail;
  const url = typeof d.url === "string" && !urlProblem(d.url) ? d.url : null;
  const evidence = d.evidence ? plainWords(String(d.evidence)) : null;
  return <>
    <Props rows={[["稿子", p.item.title], ["平台", d.platform ? platformName(String(d.platform)) : null],
      ["作品链接", url ? <a href={url} target="_blank" rel="noopener noreferrer">{url}</a> : null],
      ["说的是", `已经发出去了${d.item ? `（作品编号 ${String(d.item)}）` : ""}`], ["依据", evidence]]} />
    {!url && !evidence && <p className="ri-note">没给作品链接，去平台上看一眼再确认</p>}
    <Actions item={p.item} act={p.act} />
  </>;
}

function Generic(p: { item: InboxItem; act: Act }) {
  const d = p.item.detail;
  const rows: Array<[string, ReactNode]> = [["稿子", p.item.content_id ? p.item.title : null], ["为什么", d.reason ? String(d.reason) : null], ["文件", d.name ? String(d.name) : null],
    ["平台", d.platform ? platformName(String(d.platform)) : null], ["原话", d.quote ? `『${String(d.quote)}』` : null]];
  return <>
    <Props rows={rows} />
    <CandidatePreview item={p.item} />
    <Actions item={p.item} act={p.act} />
  </>;
}

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;

/** 收件箱里没对上的视频：先看片（播放器、时长、文件时间、开头说了什么），再认是哪条，或忽略 */
function InboxFileBody(p: { item: InboxItem; act: Act }) {
  const d = p.item.detail;
  const guesses = (d.guesses as Array<{ content_id: string; title: string }> | undefined) ?? [];
  // 旧对账报告只有标题：只显示，不给按钮
  const oldGuess = guesses.length ? [] : ((d.guess as string[] | undefined) ?? []);
  const usedBy = d.used_by as { title: string } | null;
  const quiet = p.item.actions.filter((a) => a.role === "quiet");
  return <>
    <Props rows={[["文件", String(d.name ?? "")], ["时长", typeof d.duration_ms === "number" ? clock(d.duration_ms) : null],
      ["文件时间", typeof d.mtime_ms === "number" ? new Date(d.mtime_ms).toLocaleString() : null], ["为什么", usedBy && d.reason ? String(d.reason) : null]]} />
    <div className="ri-preview"><video controls preload="metadata" src={inboxFileUrl(p.item.item_id)} /></div>
    {typeof d.transcript_head === "string" && d.transcript_head && <p className="ri-question">开头说的：「{d.transcript_head}」</p>}
    {!usedBy && guesses.length > 0 && <ul className="ri-check">{guesses.map((g) => {
      const a = p.item.actions.find((x) => x.action === "assign" && x.params?.to === g.content_id);
      return <li key={g.content_id}>《{g.title}》 {a && <Button variant="secondary" onClick={() => void p.act(a)}>{a.label}</Button>}</li>;
    })}</ul>}
    {!usedBy && oldGuess.length > 0 && <p className="ri-note">可能是：{oldGuess.map((t) => `《${t}》`).join("、")}</p>}
    {!usedBy && <AssignPicker item={p.item} act={p.act} />}
    {quiet.length > 0 && <div className="ri-actions"><span className="ri-quiet-slot">{quiet.map((a, i) => <Button key={i} variant="quiet" onClick={() => void p.act(a)}>{a.label}</Button>)}</span></div>}
  </>;
}

/** 都不是猜的那几条：从所有还没过剪辑的视频稿里选 */
function AssignPicker(p: { item: InboxItem; act: Act }) {
  const choices = (p.item.detail.choices as Array<{ id: string; title: string }>) ?? [];
  const [to, setTo] = useState(choices[0]?.id ?? "");
  const assign = p.item.actions.find((a) => a.action === "assign" && a.params?.to === undefined);
  if (!choices.length || !assign) return <p className="ri-reason">没有还能挂原片的视频稿</p>;
  return <div className="ri-actions">
    <select aria-label="指定给哪条" value={to} onChange={(e) => setTo(e.target.value)}>{choices.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
    <Button variant="secondary" onClick={() => void p.act(assign, { to })}>指定给这条</Button>
  </div>;
}

export function ReviewPanel(p: { item: InboxItem; act: Act; gone: boolean; onClose: () => void }) {
  const it = p.item;
  const Body = it.type === "candidate" ? CandidateBody : it.type === "cut_review" ? CutBody : it.type === "cover_pick" ? CoverBody : it.type === "inbox_file" ? InboxFileBody
    : it.type === "ask" ? AskBody : it.type === "sliver" ? SliverBody : it.type === "publish_check" ? CheckBody : it.type === "publish_claim" ? ClaimBody : Generic;
  return <aside className="ri-peek" role="dialog" aria-label={it.summary}>
    <div className="ri-peek-top"><Button variant="quiet" onClick={p.onClose}>关闭</Button></div>
    <h2>{plainWords(it.summary)}</h2>
    {p.gone ? <p className="ri-note" role="status">已在别处处理</p> : <Body key={`${it.item_id}:${it.gen}`} item={it} act={p.act} />}
  </aside>;
}
