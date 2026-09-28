/** 看板上的卡：选题卡（开始写）、稿件卡（⋯ 往回退）、发布行（我发了 / 撤销）。 */
import { useState } from "react";
import { invoke } from "../transport";
import { confirmDialog, openDialog, toast } from "../ui";
import { VIDEO_PLATFORMS, isHttpUrl } from "../lib";
import { relativeLabel } from "../time-format";
import { artifactUrl } from "./board-parts";
import { CodexPublishButton } from "./CodexPublish";
import { showCodexPublish } from "./codex-publish";
import { useProjectReview } from "./use-project-review";
import { markPublished, unmarkPublished } from "./board-api";
import {
  backMoves, itemMeta, platformName, publishHeadline, publishLine, topicSourceLabel,
  type BoardColumn, type BoardItem, type BoardTopic, type PlatformPublication,
} from "./board-columns";

export interface DragProps { onDragStart: (from: BoardColumn, id: string) => void; onDragEnd: () => void }

export function TopicCard(props: DragProps & { topic: BoardTopic; busy: boolean; onStart: () => void; onOpen: () => void; onTrash: () => void }) {
  const t = props.topic;
  const meta = [topicSourceLabel(t.source), relativeLabel(t.renewedAt ?? t.createdAt)].join(" · ");
  return <article className="bcard" draggable={!props.busy} aria-busy={props.busy}
    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.title); props.onDragStart("选题", t.id); }}
    onDragEnd={props.onDragEnd}>
    <button className="bcard-title" title={t.title} onClick={props.onOpen}>
      {t.score !== null && <span className="bcard-score">{t.score}</span>}{t.title}
    </button>
    <div className="bcard-meta">{meta}</div>
    <div className="bcard-actions">
      <button className="primary" disabled={props.busy} onClick={props.onStart}>{props.busy ? "正在开始…" : "开始写"}</button>
      {t.link && isHttpUrl(t.link) && <a className="bcard-link" href={t.link} target="_blank" rel="noreferrer">看来源</a>}
      <button className="bcard-link bcard-trash" title="将选题移入回收站" onClick={props.onTrash}>移入回收站</button>
    </div>
  </article>;
}

export function ItemCard(props: DragProps & { item: BoardItem; wpm: number | null; onOpen: () => void; onMenu: (open: boolean) => void; reload: () => Promise<void> }) {
  const item = props.item;
  const publishing = item.column === "待发布" || item.column === "已发布";
  const meta = itemMeta(item, props.wpm);
  const head = item.column === "已发布" ? publishHeadline(item) : null;
  return <article className={"bcard" + (publishing ? " bcard-wide" : "")} draggable
    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", item.title); props.onDragStart(item.column, item.id); }}
    onDragEnd={props.onDragEnd}>
    {head && <div className="bcard-when">{head}</div>}
    <div className="bcard-main">
      {publishing && item.cover && <img className="bcard-cover" alt="已选封面" src={artifactUrl(item.id, item.cover)} />}
      <div className="bcard-text">
        <button className="bcard-title" title={item.title} onClick={props.onOpen}>{item.title || "（无标题）"}</button>
        {meta && <div className={"bcard-meta" + (item.status === "needs_evidence" ? " bcard-red" : "")}>{meta}</div>}
        {(item.blockedReason || item.lastError) && <div className="bcard-meta bcard-red">{item.blockedReason || "生成中断，打开稿件查看"}</div>}
      </div>
      <BackMenu item={item} onMenu={props.onMenu} reload={props.reload} />
    </div>
    {publishing && <PublishRows item={item} reload={props.reload} />}
    {(item.status === "publish_ready" || item.status === "editing") && item.platform && VIDEO_PLATFORMS.has(item.platform) && <BoardCodexPublish item={item} />}
  </article>;
}

function BoardCodexPublish({ item }: { item: BoardItem }) {
  const { review } = useProjectReview(item.id, false);
  const place = item.status === "editing" ? "board" : "publish_page";
  if (!review || !showCodexPublish(place, item.status, review)) return null;
  return <div className="bcard-actions"><CodexPublishButton contentId={item.id} title={review.title || item.title} status={item.status} review={review} /></div>;
}

function BackMenu(props: { item: BoardItem; onMenu: (open: boolean) => void; reload: () => Promise<void> }) {
  const moves = backMoves(props.item);
  const [busy, setBusy] = useState(false);
  if (moves.length === 0) return null;
  const run = async (move: (typeof moves)[number], el: HTMLDetailsElement | null) => {
    if (el) el.open = false;
    const yes = await confirmDialog({ title: move.title, body: move.body, confirmLabel: move.label, danger: true });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await invoke("content:transition", { id: props.item.id, from_status: props.item.status, target_status: move.target });
      toast(r.ok ? `已${move.label}` : r.error ?? "没退回去，刷新后再试");
      await props.reload();
    } finally { setBusy(false); }
  };
  return <details className="bcard-menu" onToggle={(e) => props.onMenu(e.currentTarget.open)}>
    <summary aria-label="改阶段">⋯</summary>
    <div className="bcard-menu-list">
      {moves.map((m) => <button key={m.target} disabled={busy} onClick={(e) => void run(m, e.currentTarget.closest("details"))}>{m.label}…</button>)}
    </div>
  </details>;
}

async function askMark(item: BoardItem, platform: string, reload: () => Promise<void>) {
  const v = await openDialog({
    title: `在${platformName(platform)}发了？`,
    body: "记成你手动发的。点错了可以撤销。",
    fields: [{ key: "url", label: "作品链接（选填）", placeholder: "https://…" }],
    confirmLabel: "记下",
  });
  if (!v) return;
  const url = v.url.trim();
  if (url && !isHttpUrl(url)) return toast("链接要是 http(s) 开头的地址，没记");
  const r = await markPublished(item.id, platform, url || undefined);
  toast(r.ok ? `已记下：${platformName(platform)}你手动发的` : r.error);
  await reload();
}

async function undoMark(item: BoardItem, platform: string, reload: () => Promise<void>) {
  const r = await unmarkPublished(item.id, platform);
  toast(r.ok ? `已撤销${platformName(platform)}的手动发布` : r.error);
  await reload();
}

function PublishRow(props: { item: BoardItem; p: PlatformPublication; reload: () => Promise<void> }) {
  const { p, item } = props;
  const line = publishLine(p);
  const url = p.url && isHttpUrl(p.url) ? p.url : null;
  return <div className={"prow prow-" + line.tone}>
    <span className="prow-name">{platformName(p.platform)}</span>
    <span className="prow-state">{line.text}{url && <> · <a href={url} target="_blank" rel="noreferrer">看作品</a></>}</span>
    <span className="prow-side">
      {p.campaigns.length > 0 && <span className="prow-camp">{p.campaigns.join("、")}</span>}
      {p.manual && <button className="bcard-link" onClick={() => void undoMark(item, p.platform, props.reload)}>撤销</button>}
      {!p.submitted && <button className="bcard-link" onClick={() => void askMark(item, p.platform, props.reload)}>我发了</button>}
    </span>
  </div>;
}

function PublishRows(props: { item: BoardItem; reload: () => Promise<void> }) {
  const rec = props.item.publish;
  if (!rec) return null;
  const listed = rec.kind === "none" ? [] : rec.platforms;
  const unlisted = [...VIDEO_PLATFORMS].filter((p) => !listed.some((x) => x.platform === p));
  return <div className="prows">
    {rec.kind === "unreadable" && <div className="prow-note prow-red">发布记录读不到：{rec.reason}</div>}
    {rec.kind === "none" && <div className="prow-note prow-muted">还没有发布记录</div>}
    {listed.map((p) => <PublishRow key={p.platform} item={props.item} p={p} reload={props.reload} />)}
    {unlisted.length > 0 && <details className="prow-more">
      <summary>在别的平台发了？</summary>
      {unlisted.map((p) => <button key={p} className="bcard-link" onClick={() => void askMark(props.item, p, props.reload)}>{platformName(p)} · 我发了</button>)}
    </details>}
  </div>;
}
