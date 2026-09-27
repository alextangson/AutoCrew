/**
 * 共享内容项目面板（P6 §13.4-C）：
 * - 交接前（draft_ready/approved 的视频稿）：只有一句怎么交接 + 交接信息确认，没有剪辑界面；
 * - 剪辑中（editing）：整页看板，数据来自 /api/project-review，打开期间每 15 秒自动刷新。
 * 路由错误原样显示，不静默。
 */
import { useState } from "react";
import { clockLabel } from "../time-format";
import { ProjectBoard } from "./ProjectBoard";
import { useProjectReview } from "./use-project-review";

const PRE_HANDOFF = new Set(["draft_ready", "approved"]);

export function SharedProjectPanel(props: { contentId: string; status: string; isVideo: boolean; reload: () => Promise<void> }) {
  const board = props.isVideo && (props.status === "editing" || props.status === "cover_pending");
  const pre = props.isVideo && PRE_HANDOFF.has(props.status);
  if (board) return <ProjectBoard contentId={props.contentId} status={props.status} reload={props.reload} />;
  if (pre) return <PreHandoff contentId={props.contentId} />;
  return null;
}

function PreHandoff({ contentId }: { contentId: string }) {
  const { review, error, busy, submit } = useProjectReview(contentId, false);
  const [cover, setCover] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const coverText = cover ?? review?.decisions?.cover_text ?? "";
  const target = seconds ?? review?.decisions?.target_seconds ?? 0;
  const confirmed = review?.decisions;
  return <section className="panel" style={{ margin: "12px 24px", padding: 12 }}>
    <p><strong>录完按标题命名放进 Downloads，在 Codex 里说『剪这条』</strong></p>
    {!review && !error && <p className="muted">正在读取交接信息…</p>}
    {review?.enabled && <>
      {confirmed && <p className="muted">已确认的交接信息：封面字「{confirmed.cover_text}」· 目标 {confirmed.target_seconds} 秒 · {clockLabel(confirmed.confirmed_at)}</p>}
      <label>封面字 <input value={coverText} onChange={(e) => setCover(e.target.value)} /></label>{" "}
      <label>目标时长（秒）<input type="number" min="1" value={target} onChange={(e) => setSeconds(Number(e.target.value))} /></label>{" "}
      <button disabled={busy || !coverText.trim() || target <= 0} onClick={() => void submit({ action: "decisions", title: review.title, cover_text: coverText, target_seconds: target, draft_hash: review.draft_hash })}>
        {confirmed ? "更新交接信息" : "确认交接信息"}
      </button>
    </>}
    {error && <p role="alert" className="ed-error">{error}</p>}
  </section>;
}
