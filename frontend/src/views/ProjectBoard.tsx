/**
 * 剪辑看板（P6 §13.4-C）：一眼回答「这条视频在哪」「现在要我做什么」。
 * 从上到下：步骤条 → 「现在轮到你」卡（全页唯一醒目的卡）→ Codex 一行 → 折叠的文件 / 交接详情 / 文案。
 * 步骤是 status=editing 里的展示步骤，不改稿件状态。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { confirmDialog, toast } from "../ui";
import { useProjectReview } from "./use-project-review";
import { CoverStep } from "./CoverStep";
import { FinalCutStep, NowTitle } from "./FinalCutStep";
import { ScriptPeek } from "./ScriptPeek";
import { CodexPublishButton } from "./CodexPublish";
import { showCodexPublish } from "./codex-publish";
import { artifactUrl, RevealLink, when } from "./board-parts";
import { coverVersions } from "./cover-board";
import { inboxHref, loadInbox } from "./review/review-api";
import { boardFiles, codexLine, nowKind, refreshFailedLine, stepperStates, type NowKind } from "./board-view";
import { boardAnomalies, fileName, type ProjectReview } from "./project-board";

type BoardContent = { id: string; status: string; title: string; body: string };

export function ProjectBoard(props: { content: BoardContent; reload: () => Promise<void> }) {
  const r = useProjectReview(props.content.id, true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, []);
  if (!r.review && !r.error) return <BoardSkeleton />;
  return <ProjectBoardView {...props} {...r} now={now} />;
}

type ReviewState = ReturnType<typeof useProjectReview>;

/** 看板本体（纯渲染，给定 review）：旧交接与本体工作台共用；测试直接渲染它 */
export function ProjectBoardView(props: { content: BoardContent; reload: () => Promise<void>; now: number } & Pick<ReviewState, "review" | "error" | "refreshError" | "lastOkAt" | "busy" | "submit">) {
  const { id, status } = props.content;
  const { review, error, refreshError, lastOkAt, busy, submit, now } = props;
  const kind = nowKind(status, review);
  const live = review?.enabled && review.handoff_valid ? review : null;
  // 本体下工作台只看详情（review-inbox §10）：历史、全部版本、文件；拍板都在「等你拍板」
  if (live?.ontology) return <ReadOnlyWorkbench review={live} content={props.content} error={error} />;
  return <div className="pb-board">
    <Stepper kind={kind} />
    {boardAnomalies(status, review).includes("draft_changed") && <p className="pb-warn">交接之后稿子又改过，和 Codex 手里那版不一致</p>}
    <section className="pb-now" aria-label="现在轮到你">
      <div className="pb-now-kicker">现在轮到你</div>
      {kind === "no_handoff" ? <NoHandoff contentId={id} status={status} reload={props.reload} /> : live && <NowBody kind={kind} review={live} contentId={id} busy={busy} submit={submit} title={live.title || props.content.title} status={status} />}
      {error && <p role="alert" className="pb-inline-error">{error}</p>}
    </section>
    {live && <CodexLine review={live} now={now} />}
    {refreshError && <p className="pb-muted-line">{refreshFailedLine(refreshError, lastOkAt, now)}</p>}
    {live && <FilesSection review={live} contentId={id} />}
    {live?.handoff && <HandoffDetails review={live} />}
    <ScriptPeek title={props.content.title} body={props.content.body} summary="文案" hint="只读；剪辑阶段不改字。" />
  </div>;
}

function BoardSkeleton() {
  return <div className="pb-board" aria-busy="true">
    <p className="muted">正在读取交接和剪辑进度…</p>
    <div className="pb-skeleton pb-skeleton-line" />
    <div className="pb-skeleton pb-skeleton-block" />
  </div>;
}

export function Stepper({ kind }: { kind: NowKind }) {
  return <ol className="pb-stepper">
    {stepperStates(kind).map((s) => <li key={s.label} className={`is-${s.state}`} aria-current={s.state === "current" ? "step" : undefined}>
      {s.state === "done" ? "✓ " : ""}{s.label}
    </li>)}
  </ol>;
}

type Submit = (payload: Record<string, unknown>) => Promise<boolean>;
function NowBody(props: { kind: NowKind; review: ProjectReview; contentId: string; busy: boolean; submit: Submit; title: string; status: string }) {
  if (props.kind === "final_review") return <FinalCutStep {...props} />;
  if (props.kind === "covers") return <CoverStep {...props} durationMs={props.review.final_cut?.duration_ms} />;
  if (props.kind === "ready") return <>
    <NowTitle title="成片和封面都定了" sub="可以让 Codex 登记并发布；指令复制好后由你在 Codex 里按发送。" />
    {showCodexPublish("board", props.status, props.review) && <div className="pb-actions">
      <CodexPublishButton primary contentId={props.contentId} title={props.title} status={props.status} review={props.review} />
    </div>}
  </>;
  const beat = props.review.execution?.heartbeat;
  return <NowTitle title="Codex 正在剪，暂时不用你操作" sub={beat ? undefined : "Codex 还没报告过进度。"} />;
}

function CodexLine({ review, now }: { review: ProjectReview; now: number }) {
  const line = codexLine(review, now);
  return <div className="pb-codex">
    <div className="pb-muted-line" title={line.next ? `下一步：${line.next}` : undefined}>{line.text}</div>
    {line.next && <div className="pb-muted-line">下一步：{line.next}</div>}
    {line.stale && <div className="pb-warn">{line.stale}</div>}
  </div>;
}

function FilesSection({ review, contentId }: { review: ProjectReview; contentId: string }) {
  return <details className="pb-section">
    <summary>文件</summary>
    <ul className="pb-files">
      {boardFiles(review).map((f) => <li key={f.label}>
        <span className="pb-files-label">{f.label}</span>
        {f.path ? <><code className="pb-path" title={f.path}>{f.path}</code><RevealLink contentId={contentId} target={f.target} /></> : <span className="muted">{f.missingText}</span>}
      </li>)}
    </ul>
  </details>;
}

function HandoffDetails({ review }: { review: ProjectReview }) {
  const h = review.handoff!;
  return <details className="pb-section">
    <summary>交接详情</summary>
    <dl className="pb-facts">
      <dt>交接代次</dt><dd>第 {h.generation} 代</dd>
      <dt>交接时间</dt><dd>{when(h.at)}</dd>
      <dt>持有会话</dt><dd>{review.execution?.session_id || "还没有剪辑会话报到"}</dd>
      <dt>指纹</dt><dd className="mono">{(h.hash ?? "").slice(0, 8)}</dd>
      <dt>原片</dt><dd>{h.aroll_path ? fileName(h.aroll_path) : "还没有收到原片"}</dd>
    </dl>
  </details>;
}

function NoHandoff(props: { contentId: string; status: string; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const back = async () => {
    const yes = await confirmDialog({ title: "退回待交接？", body: "这篇会回到「草稿」，之后在 Codex 里说「剪这条」重新交接。", confirmLabel: "退回待交接" });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await invoke("content:transition", { id: props.contentId, target_status: "draft_ready", from_status: props.status });
      if (!r.ok) return toast(r.error ?? "退回失败");
      await props.reload();
    } finally { setBusy(false); }
  };
  return <>
    <NowTitle title="这篇在剪辑中，但找不到有效的交接" sub="退回待交接后，在 Codex 里说「剪这条」重新交接。" />
    <div className="pb-actions"><button disabled={busy} onClick={() => void back()}>退回待交接</button></div>
  </>;
}

/**
 * 本体下的工作台（review-inbox §10，R18）：只看——本轮全部成片（最新一版 / 上一版…按剪好时间）、全部封面组、文件、文案。
 * 不放审核按钮；这条有要你拍板的事时给一个「去『等你拍板』处理」。
 */
export function ReadOnlyWorkbench(p: { review: ProjectReview; content: BoardContent; error?: string | null }) {
  const id = p.content.id, arts = p.review.execution?.artifacts ?? [];
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void loadInbox().then((r) => { if (live && r.ok) setPending(r.data.items.filter((i) => i.content_id === id).length); });
    return () => { live = false; };
  }, [id]);
  const cuts = arts.filter((a) => a.role === "final-cut").sort((a, b) => b.reported_at.localeCompare(a.reported_at));
  const covers = coverVersions(arts).sort((a, b) => b.at.localeCompare(a.at));
  const label = (i: number) => (i === 0 ? "最新一版" : i === 1 ? "上一版" : `往前第 ${i} 版`);
  return <div className="pb-board">
    <section className="pb-now" aria-label="这条在哪">
      <h3 className="pb-now-title">{p.review.editor_label ?? "agent"} 在剪；要你拍板的事都在「等你拍板」</h3>
      {pending ? <p><a href={inboxHref(id)}>去『等你拍板』处理（{pending} 件）</a></p> : <p className="pb-now-sub">现在没有要你拍板的事。</p>}
      {p.error && <p role="alert" className="pb-inline-error">{p.error}</p>}
    </section>
    <details className="pb-section" open={cuts.length > 0}><summary>成片（{cuts.length}）</summary>
      <ul className="pb-files">{cuts.map((a, i) => <li key={a.sha256}><span className="pb-files-label">{label(i)} · {when(a.reported_at)}</span>
        <video controls preload="metadata" style={{ width: "100%", maxWidth: 480 }} src={artifactUrl(id, a)} /><RevealLink contentId={id} target={a.sha256} /></li>)}</ul>
    </details>
    <details className="pb-section" open={covers.length > 0}><summary>封面（{covers.length} 组）</summary>
      <ul className="pb-files">{covers.map((v, i) => <li key={`${v.version}-${v.at}`}><span className="pb-files-label">{i === 0 ? "最新一组" : i === 1 ? "上一组" : `往前第 ${i} 组`} · {when(v.at)}</span>
        {(["3:4", "4:3"] as const).map((r) => v.pair[r] ? <img key={r} alt={r} style={{ height: 120, marginRight: 8, borderRadius: 8 }} src={artifactUrl(id, v.pair[r]!)} /> : <span key={r} className="muted">还差 {r} </span>)}</li>)}</ul>
    </details>
    <FilesSection review={p.review} contentId={id} />
    <ScriptPeek title={p.content.title} body={p.content.body} summary="文案" hint="只读；剪辑阶段不改字。" />
  </div>;
}
