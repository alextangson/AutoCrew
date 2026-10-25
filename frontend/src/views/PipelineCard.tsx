/** 内容管线的两种卡：主题卡（一个主题一张，展开看每个去向）、选题卡（现有内容，星级在第 5 期，这里只留位置）。 */
import { useState } from "react";
import { isHttpUrl } from "../lib";
import { openDialog, toast } from "../ui";
import { reshootTheme, setDestination } from "./board-api";
import { BackMenu, BoardCodexPublish, PickupNudge } from "./BoardCards";
import { WRITER_LABEL } from "./hand-off";
import type { HostId } from "./onboarding/connect-api";
import type { PublishTarget, TargetAction } from "./publish-targets";
import { performTarget } from "./StageCard";
import { topicSourceLabel, type BoardItem, type BoardTopic } from "./board-columns";
import { PGlyph, StateGlyph } from "./pipeline-glyphs";
import {
  DEST_LABEL, canReshoot, canSkipRow, destLabel, meterRows, meterTone, mmdd, showMeter, skippedLine, stateIcon, statusLine,
  type DestRow, type ThemeCard,
} from "./pipeline-model";

/** 行里地方小：动作用短说法（意思同 publish-targets 的 ACTION_LABEL） */
const ROW_ACTION: Record<TargetAction, string> = { prepare_publish: "去发", i_published: "标已发", resubmit: "重新提交", confirm_receipt: "确认", correct_publish: "纠正" };

/** 卡上只显示例外：待你定、没发成、等新成片；发布中再加还没发的；重拍留下的「已定时，要你去撤」 */
export function exceptionRows(card: ThemeCard): Array<{ key: string; platform: string | null; text: string; hot: boolean }> {
  const out: Array<{ key: string; platform: string | null; text: string; hot: boolean }> = [];
  for (const r of card.destinations) {
    const name = `${destLabel(r.platform)}${r.tag ? ` ${r.tag}` : ""}`;
    const key = `${r.platform}-${r.content_id ?? "none"}-${r.tag ?? ""}`;
    if (r.paused) out.push({ key, platform: r.platform, text: `${name} 等新成片`, hot: false });
    else if ((r.state === "待你定" || r.state === "没发成") && (r.required || r.content_id)) out.push({ key, platform: r.platform, text: `${name} ${r.detail}`, hot: true });
    else if (card.column === "发布中" && r.required && (r.state === "在做" || r.state === "没开始")) out.push({ key, platform: r.platform, text: `${name} ${r.state === "在做" ? (r.platform === "youtube" || r.platform === "x" ? "英文版在做" : "在做") : "没开始"}`, hot: false });
  }
  for (const c of card.reshoot?.to_cancel ?? []) out.push({ key: `cancel-${c.platform}`, platform: c.platform, text: `${destLabel(c.platform)} 已定时，要你去撤`, hot: true });
  const labels = Object.values(DEST_LABEL);
  for (const e of card.exceptions) if (!labels.some((l) => e.startsWith(l))) out.push({ key: e, platform: null, text: e, hot: true });
  return out;
}

async function askWords(title: string, body: string, label: string, placeholder: string): Promise<string | null> {
  const v = await openDialog({ title, body, fields: [{ key: "words", label, placeholder }], confirmLabel: "记下" });
  const words = v?.words.trim();
  if (v && !words) toast("要写一句你的原话，没记");
  return words || null;
}

async function skipRow(card: ThemeCard, platform: string, skip: boolean, reload: () => Promise<void>) {
  const name = destLabel(platform);
  const words = await askWords(skip ? `这条不出${name}？` : `${name}又要发？`, skip ? "只改这一个主题的去向计划，已经发了的不会撤。" : "这个主题重新把它算进要发的去向。", "你的原话", skip ? "比如：这条不适合 B站" : "比如：还是发吧");
  if (!words) return;
  const r = await setDestination(card.id, platform, skip, words);
  toast(r.ok ? (skip ? `记下了：这条不出${name}` : `记下了：${name}要发`) : r.error);
  await reload();
}

async function runReshoot(card: ThemeCard, reload: () => Promise<void>) {
  const words = await askWords("这条要重拍？", "本轮的原片、成片、封面批准转入历史（文件不删），沿用原稿回到「录制」。已发的保留；已定时还没公开的会列出来，要你自己去后台撤，不会自动撤。公众号、英文版先暂停，等新成片。",
    "你的原话", "比如：这条我觉得拍的不好，重新拍");
  if (!words) return;
  try {
    const r = await reshootTheme(card.id, card.item.round ?? 1, words);
    if (!r.ok) return toast(r.error);
    const cancel = r.data.to_cancel.map((c) => destLabel(c.platform));
    toast(cancel.length ? `已回到录制。${cancel.join("、")} 已定时，要你去后台撤` : "已回到录制，等你录新的 A-roll");
  } finally { await reload(); }
}

function rowTarget(r: DestRow): PublishTarget {
  return { platform: r.platform, state: "未发", actions: r.actions ?? [], ...(r.slot_id ? { slot_id: r.slot_id } : {}), ...(r.fact_id ? { fact_id: r.fact_id } : {}) };
}

function DestLine(p: { card: ThemeCard; r: DestRow; open: (id: string) => void; reload: () => Promise<void> }) {
  const { r, card } = p;
  const [busy, setBusy] = useState(false);
  const owner = r.content_id ? [card.item, ...card.children].find((i) => i.id === r.content_id) : undefined;
  const acts = (r.actions ?? []).filter((a) => a !== "correct_publish");
  const run = async (a: TargetAction) => {
    if (!owner) return;
    setBusy(true);
    try {
      const res = await performTarget(rowTarget(r), a, { id: owner.id, title: owner.title, status: owner.status, platform: owner.platform ?? "", body: "", updatedAt: owner.updatedAt }, owner.round ?? 1);
      if (!res.ok) toast(res.error);
    } finally { setBusy(false); await p.reload(); }
  };
  const hot = r.state === "待你定" || r.state === "没发成";
  const canSkip = canSkipRow(card, r);
  const text = r.skipped && r.state !== "已发" ? "不出" : r.history ? `${r.detail} · 计划外` : r.detail;
  return <div className={"pl-pr" + (hot && !r.skipped ? " hot" : "") + (r.skipped || r.history ? " muted" : "")}>
    <span className="nm"><PGlyph id={r.platform} />{destLabel(r.platform)}{r.tag && <small>{r.tag}</small>}</span>
    <span className="s"><StateGlyph kind={r.paused ? "wip" : stateIcon(r)} /><span title={text}>{text}</span></span>
    <span className="r">
      {r.at && <span>{r.at}</span>}
      {r.url && isHttpUrl(r.url) && <a className="pl-link" href={r.url} target="_blank" rel="noreferrer">看作品</a>}
      {acts.map((a) => <button key={a} className={"pl-link" + (hot ? " go" : "")} disabled={busy} onClick={() => void run(a)}>{ROW_ACTION[a]}</button>)}
      {!acts.length && hot && r.content_id && <button className="pl-link go" onClick={() => p.open(r.content_id!)}>去处理 →</button>}
      {canSkip && <button className="pl-link" onClick={() => void skipRow(card, r.platform, true, p.reload)}>不出</button>}
    </span>
  </div>;
}

function Expanded(p: { card: ThemeCard; open: (id: string) => void; reload: () => Promise<void>; onMenu: (open: boolean) => void }) {
  const { card } = p;
  const skipped = skippedLine(card);
  const shown = card.destinations.filter((r) => !(r.skipped && r.state !== "已发" && !r.content_id));
  const it = card.item;
  return <div className="pl-xp" onClick={(e) => e.stopPropagation()}>
    {shown.length === 0 && <div className="pl-warn">还没定发哪里：到设置里勾平台，或在下面恢复要发的去向</div>}
    {shown.map((r) => <DestLine key={`${r.platform}-${r.content_id ?? "none"}-${r.tag ?? ""}`} card={card} r={r} open={p.open} reload={p.reload} />)}
    {card.reshoot && <div className="pl-warn">要重拍（你说「{card.reshoot.founder_words}」）{card.reshoot.to_cancel.length ? `：${card.reshoot.to_cancel.map((c) => destLabel(c.platform)).join("、")} 已定时，要你去后台撤` : ""}</div>}
    {skipped && <div className="pl-pf"><StateGlyph kind="skip" />{skipped}
      {card.plan.skipped.map((s) => <button key={s.platform} className="pl-link" title={`你说「${s.founder_words}」`} onClick={() => void skipRow(card, s.platform, false, p.reload)}>恢复 {destLabel(s.platform)}</button>)}</div>}
    <div className="pl-ops">
      <button className="pl-link" onClick={() => p.open(it.id)}>打开稿件 →</button>
      {card.children.map((c) => <button key={c.id} className="pl-link" onClick={() => p.open(c.id)}>{c.platform === "wechat_mp" ? "公众号文章" : "英文版"} →</button>)}
      {canReshoot(card) && <button className="pl-link" onClick={() => void runReshoot(card, p.reload)}>重拍…</button>}
      <BackMenu item={it} onMenu={p.onMenu} reload={p.reload} />
    </div>
    <PickupNudge item={it} reload={p.reload} />
    {(it.status === "publish_ready" || it.status === "editing") && <BoardCodexPublish item={it} />}
  </div>;
}

export interface CardDrag { onDragStart: (item: BoardItem) => void; onDragEnd: () => void }

export function ThemeCardView(p: { card: ThemeCard; expanded: boolean; busy: boolean; toggle: () => void; open: (id: string) => void; reload: () => Promise<void>; onMenu: (open: boolean) => void } & CardDrag) {
  const { card } = p;
  const st = showMeter(card) ? null : statusLine(card);
  const ex = exceptionRows(card);
  const sent = new Set(card.destinations.filter((d) => d.state === "已发").map((d) => d.platform));
  return <article className={"pl-card" + (p.expanded ? " sel" : "")} aria-busy={p.busy} aria-expanded={p.expanded} draggable={!p.busy && !p.expanded}
    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.title); p.onDragStart(card.item); }} onDragEnd={p.onDragEnd}
    onClick={() => { if (!p.expanded) p.toggle(); }}>
    <div className="t" title={card.title} onClick={(e) => { if (p.expanded) { e.stopPropagation(); p.toggle(); } }}>{card.title || "（无标题）"}</div>
    {st && <div className={"pl-st" + (st.tone === "you" ? " hot" : "")}><StateGlyph kind={st.tone} />{st.text}</div>}
    <div className="pl-ft">
      {showMeter(card)
        ? <>{card.required > 0 && <span className="pl-meter" aria-label="去向">{meterRows(card).map((r, i) => <i key={i} className={meterTone(r.state) === "done" ? "" : meterTone(r.state)} />)}</span>}
          <span className="pl-frac">{card.required > 0 ? `${card.sent}/${card.required} 已发` : "没定去向"}</span></>
        : <span className="pl-plan" aria-label="要发的去向">{card.plan.required.map((pf) => <span key={pf} style={sent.has(pf) ? { color: "var(--ink)" } : undefined} title={sent.has(pf) ? `${destLabel(pf)} 已发` : destLabel(pf)}><PGlyph id={pf} /></span>)}</span>}
      <span className="d">{mmdd(card.date)}</span>
    </div>
    {!p.expanded && ex.map((x) => <div key={x.key} className={"pl-ex" + (x.hot ? " hot" : "")}>{x.platform ? <PGlyph id={x.platform} /> : <StateGlyph kind="fail" />}{x.text}</div>)}
    {p.expanded && <Expanded card={card} open={p.open} reload={p.reload} onMenu={p.onMenu} />}
  </article>;
}

/** 选题卡：现有内容不变（开始写 / 换一个 AI 写 / 看来源 / 移入回收站）；星级第 5 期上，这里只留位置 */
export function TopicCardView(p: { topic: BoardTopic; busy: boolean; others: HostId[]; onStart: (host?: HostId) => void; onOpen: () => void; onTrash: () => void; onDragStart: () => void; onDragEnd: () => void }) {
  const t = p.topic;
  return <article className="pl-card" draggable={!p.busy} aria-busy={p.busy}
    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.title); p.onDragStart(); }} onDragEnd={p.onDragEnd}
    onClick={p.onOpen}>
    <div className="t" title={t.title}>{t.title}</div>
    <div className="pl-st">{[t.inSlate ? "本周片单" : null, t.score !== null ? `雷达 ${t.score}` : topicSourceLabel(t.source), mmdd(t.renewedAt ?? t.createdAt)].filter(Boolean).join(" · ")}</div>
    <div className="pl-ft" onClick={(e) => e.stopPropagation()}>
      <span className="pl-stars" data-slot="stars" />
      <span className="pl-acts">
        {p.others.length > 0 && <select className="pl-sel" aria-label="换一个 AI 写" value="" disabled={p.busy} onChange={(e) => { const h = e.target.value as HostId; if (h) p.onStart(h); }}>
          <option value="">换一个 AI 写</option>
          {p.others.map((h) => <option key={h} value={h}>{WRITER_LABEL[h]}</option>)}
        </select>}
        <details className="bcard-menu">
          <summary aria-label="更多操作">⋯</summary>
          <div className="bcard-menu-list">
            {t.link && isHttpUrl(t.link) && <a href={t.link} target="_blank" rel="noreferrer">看来源</a>}
            <button onClick={(e) => { const d = e.currentTarget.closest("details"); if (d) d.open = false; p.onTrash(); }}>移入回收站</button>
          </div>
        </details>
        <button className="pl-btn primary" disabled={p.busy} onClick={() => p.onStart()}>{p.busy ? "开始中…" : "开始写"}</button>
      </span>
    </div>
  </article>;
}

