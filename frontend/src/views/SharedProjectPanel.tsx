/**
 * 交接前的视频稿（draft_ready/approved）：步骤条停在「交接」+ 一张「现在轮到你」卡——
 * 一句怎么交接 + 交接信息（封面字、目标时长）确认。剪辑中的整页看板见 EditingWorkspace。
 * 路由错误原样显示，不静默。
 */
import { useState } from "react";
import { clockLabel, durationText } from "../time-format";
import { NowTitle } from "./FinalCutStep";
import { Stepper } from "./ProjectBoard";
import { useProjectReview } from "./use-project-review";

const PRE_HANDOFF = new Set(["draft_ready", "approved"]);

export function SharedProjectPanel(props: { contentId: string; status: string; isVideo: boolean }) {
  return props.isVideo && PRE_HANDOFF.has(props.status) ? <PreHandoff contentId={props.contentId} /> : null;
}

function PreHandoff({ contentId }: { contentId: string }) {
  const { review, error, busy, submit } = useProjectReview(contentId, false);
  const [cover, setCover] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const coverText = cover ?? review?.decisions?.cover_text ?? "";
  const target = seconds ?? review?.decisions?.target_seconds ?? 0;
  const confirmed = review?.decisions;
  return <div className="pb-board pb-pre">
    <Stepper kind="pre_handoff" />
    <section className="pb-now" aria-label="现在轮到你">
      <div className="pb-now-kicker">现在轮到你</div>
      <NowTitle title="录完按标题命名放进 Downloads，在 Codex 里说『剪这条』" />
      {!review && !error && <p className="muted">正在读取交接信息…</p>}
      {review?.enabled && <>
        {confirmed && <p className="pb-muted-line">已确认：封面字「{confirmed.cover_text}」· 目标 {durationText(confirmed.target_seconds * 1000)} · {clockLabel(confirmed.confirmed_at)}</p>}
        <div className="pb-actions">
          <label>封面字 <input value={coverText} onChange={(e) => setCover(e.target.value)} /></label>
          <label>目标时长（秒）<input type="number" min="1" value={target} onChange={(e) => setSeconds(Number(e.target.value))} /></label>
          <button disabled={busy || !coverText.trim() || target <= 0} onClick={() => void submit({ action: "decisions", title: review.title, cover_text: coverText, target_seconds: target, draft_hash: review.draft_hash })}>
            {confirmed ? "更新交接信息" : "确认交接信息"}
          </button>
        </div>
      </>}
      {error && <p role="alert" className="pb-inline-error">{error}</p>}
    </section>
  </div>;
}
