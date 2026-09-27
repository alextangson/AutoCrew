/**
 * 剪辑看板（P6 §13.4-C）：剪辑中 → 成片待审 → 封面 → 待发布。
 * 当前步骤展开，已完成的折成一行摘要（点开还能看）。这些是展示步骤，不改稿件状态。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { confirmDialog, openDialog, toast } from "../ui";
import { useProjectReview } from "./use-project-review";
import {
  BOARD_STEPS, GATE_STATUS_LABEL, STEP_LABEL, boardAnomalies, currentStep, fileName, finalCutArtifact, heartbeatStale, roughCutArtifact, stepSummary,
  type Artifact, type BoardStep, type GateView, type ProjectReview,
} from "./project-board";

type Submit = (payload: Record<string, unknown>) => Promise<boolean>;
const when = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

export function ProjectBoard(props: { contentId: string; status: string; reload: () => Promise<void> }) {
  const { review, error, busy, submit } = useProjectReview(props.contentId, true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(t); }, []);
  if (!review && !error) return <section className="panel ed-board" aria-busy="true" style={{ margin: "12px 0", padding: 12 }}><p className="muted">正在读取交接和剪辑进度…</p><div style={{ height: 120, background: "var(--surface)", borderRadius: 6 }} /></section>;
  const anomalies = boardAnomalies(props.status, review);
  return <section className="panel ed-board" style={{ margin: "12px 0", padding: 12 }}>
    {error && <p role="alert" className="ed-error">{error}</p>}
    {anomalies.includes("no_handoff") && <NoHandoff contentId={props.contentId} status={props.status} reload={props.reload} />}
    {anomalies.includes("draft_changed") && <p className="vid-warn">稿已改，和交接版不一致</p>}
    {review?.enabled && review.handoff_valid && <>
      <HandoffCard review={review} stale={heartbeatStale(review, now)} />
      <Steps review={review} contentId={props.contentId} busy={busy} submit={submit} />
    </>}
  </section>;
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
  return <div className="ed-error">
    状态异常：剪辑中但没有交接包{" "}
    <button disabled={busy} onClick={() => void back()}>退回待交接</button>
  </div>;
}

function HandoffCard({ review, stale }: { review: ProjectReview; stale: boolean }) {
  const h = review.handoff!, beat = review.execution?.heartbeat;
  return <div className={stale ? "vid-warn" : "muted"} style={{ padding: 8, borderRadius: 6 }}>
    <strong>交接 第 {h.generation} 代</strong> · {when(h.at)} · A-roll「{fileName(h.aroll_path)}」 ·
    持有会话 {review.execution?.session_id || "还没有剪辑会话报到"}
    <div>{beat ? <>最近报告 {when(beat.reported_at)}：{beat.result} → 下一步：{beat.next_action}</> : "剪辑还没报告过进度"}
      {stale && " · 超过 30 分钟没有报告"}</div>
  </div>;
}

function Steps(props: { review: ProjectReview; contentId: string; busy: boolean; submit: Submit }) {
  const current = currentStep(props.review), at = BOARD_STEPS.indexOf(current);
  return <ol style={{ listStyle: "none", padding: 0 }}>
    {BOARD_STEPS.map((step, i) => {
      if (i === at) return <li key={step}><h3>{STEP_LABEL[step]}</h3><StepBody step={step} {...props} /></li>;
      if (i < at) return <li key={step}><details><summary>✓ {STEP_LABEL[step]} · {stepSummary(step, props.review)}</summary><StepBody step={step} {...props} /></details></li>;
      return <li key={step} className="muted">{STEP_LABEL[step]}</li>;
    })}
  </ol>;
}

function StepBody(props: { step: BoardStep; review: ProjectReview; contentId: string; busy: boolean; submit: Submit }) {
  const { review, step } = props, artifacts = review.execution?.artifacts ?? [], gates = review.gates;
  const card = (label: string, which: string, view: GateView | undefined, artifact: Artifact | null) =>
    <GateCard key={which} label={label} which={which} view={view} artifact={artifact} {...props} />;
  if (step === "cutting") return <>
    {card("粗剪（gate1）", "rough_cut", gates?.gate1, roughCutArtifact(artifacts, "rough_cut"))}
    {card("分镜与生成方案（gate2）", "storyboard", gates?.gate2, roughCutArtifact(artifacts, "storyboard"))}
  </>;
  if (step === "final_review") return card("成片（gate3）", "final_cut", gates?.gate3, finalCutArtifact(artifacts));
  if (step === "covers") return <CoverStepSeam review={review} />;
  return <p className="muted">成片和封面都批了。等 Codex 用 register 登记，登记后这篇进入待发布。</p>;
}

/** slice 2 的封面步占位：只显示门状态，封面挑选见 CoverStep */
function CoverStepSeam({ review }: { review: ProjectReview }) {
  return <p>封面（gate4）：{review.gates ? GATE_STATUS_LABEL[review.gates.gate4.status] : "—"}</p>;
}

export function artifactUrl(contentId: string, a: { path: string; sha256: string }) {
  return `/api/project-artifact?content_id=${encodeURIComponent(contentId)}&path=${encodeURIComponent(a.path)}&sha256=${a.sha256}`;
}

function GateCard(props: { label: string; which: string; view?: GateView; artifact: Artifact | null; review: ProjectReview; contentId: string; busy: boolean; submit: Submit }) {
  const { view, artifact } = props;
  if (!artifact) return <p className="muted">{props.label}：还没交上来</p>;
  const reject = async () => {
    const r = await openDialog({ title: `打回${props.label}`, body: "写给剪辑的原话，Codex 按这个出下一版。", fields: [{ key: "note", label: "原话", multiline: true, required: true }], confirmLabel: "打回" });
    if (!r?.note?.trim()) return;
    await props.submit({ action: "reject", which: props.which, note: r.note, artifact_sha256: view?.artifact_sha256 ?? artifact.sha256, manifest_hash: props.review.manifest_hash });
  };
  const video = /\.mp4$/i.test(artifact.path);
  return <div style={{ margin: "8px 0" }}>
    <p><strong>{props.label}</strong> · {fileName(artifact.path)} · 指纹 {artifact.sha256.slice(0, 8)} · <GateBadge view={view} /></p>
    {video
      ? <video key={artifact.sha256} src={artifactUrl(props.contentId, artifact)} controls preload="metadata" style={{ maxWidth: "100%", maxHeight: 480 }} />
      : <img key={artifact.sha256} src={artifactUrl(props.contentId, artifact)} alt={props.label} style={{ maxWidth: "100%", maxHeight: 600, objectFit: "contain" }} />}
    {view?.status !== "approved" && view?.status !== "rejected" && <p>
      <button disabled={props.busy} onClick={() => void props.submit({ action: "approve", which: props.which, files: [{ path: artifact.path, sha256: artifact.sha256 }], manifest_hash: props.review.manifest_hash })}>通过</button>{" "}
      <button disabled={props.busy} onClick={() => void reject()}>打回</button>
    </p>}
  </div>;
}

export function GateBadge({ view }: { view?: GateView }) {
  if (!view) return <span className="muted">—</span>;
  const extra = view.status === "approved" ? ` · ${when(view.approval?.approved_at)}` : view.status === "rejected" ? ` · 「${view.rejection?.note}」` : view.reason ? ` · ${view.reason}` : "";
  return <span>{GATE_STATUS_LABEL[view.status]}{extra}</span>;
}
