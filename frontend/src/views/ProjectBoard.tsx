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
import { RevealLink, when } from "./board-parts";
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
