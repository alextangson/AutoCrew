/**
 * 审片视图(视频 spec §6.4 + §8.4)——播这一版成片,通过或打回。
 *
 * 三条纪律:
 * 1. **播的是被审的那一版**:URL 里带 renderedRevision,重渲染出新版会换 src,
 *    绝不出现「看的是旧片、点的是新片」。鉴权走同源 session cookie,端点支持 Range。
 * 2. **乐观锁**:确认带 rendered_revision;`conflict:true` = 期间又渲了一版,
 *    提示已刷新最新版并重拉,不硬盖。
 * 3. **盖戳失败不吞**:通过后 `videoReadyAt` 落盘失败时后端会带 stampWarning——
 *    确认照样算数,但这句警告必须让人看见(复盘的第四段用时靠这枚戳)。
 */
import { useState } from "react";
import { confirmDialog, toast } from "../ui";
import { videoMediaUrl, videoReviewConfirm, type VideoState } from "../lib";

export function VideoReviewPanel(props: {
  contentId: string;
  state: VideoState;
  /** done 上进来只是回看,没有可确认的动作 */
  readOnly: boolean;
  reload: () => Promise<void>;
  back: () => void;
  toCut: () => void;
}) {
  const rendered = props.state.revisions.rendered;
  const [busy, setBusy] = useState(false);
  const [playError, setPlayError] = useState(false);

  const decide = async (verdict: "approve" | "reject") => {
    if (busy || rendered === undefined) return;
    if (verdict === "approve") {
      const yes = await confirmDialog({
        title: "这条成片通过?",
        body: "通过 = 认这一版可以发了(会记下达成时间)。发布仍然要你自己去平台做,这里不发。",
        confirmLabel: "通过",
      });
      if (!yes) return;
    }
    setBusy(true);
    try {
      const r = await videoReviewConfirm({ contentId: props.contentId, renderedRevision: rendered, verdict });
      if (r.conflict) {
        toast("版本已过期,已刷新最新版 —— 请重新看一遍再确认");
        await props.reload();
        return;
      }
      if (!r.ok) return toast(r.error ?? "审片确认失败");
      if (verdict === "approve") {
        toast("已通过 ✓ 成片可以发了" + (r.data?.stampWarning ? ` · ${r.data.stampWarning}` : ""));
        await props.reload();
        props.back();
        return;
      }
      toast("已打回 —— 回到选段重剪,这版成片留档不删");
      await props.reload();
      props.toCut();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vid-sub">
      <div className="vid-sub-bar">
        <button onClick={props.back}>← 成片卡</button>
        <span className="mono muted">{props.readOnly ? "回看成片" : "审片"} · 成片 v{rendered ?? "—"}</span>
      </div>

      {rendered === undefined ? (
        <p className="ed-error">这一版没有成片文件可播 —— 回成片卡看渲染那一步的状态。</p>
      ) : (
        <>
          {playError && (
            <p className="ed-error">
              成片播不出来(文件可能被清理了,或渲染中途失败只留了 .failed 留档)。去「任务日志」看渲染那一步,或回卡片重试。
            </p>
          )}
          <video
            className="vid-player"
            src={videoMediaUrl(props.contentId, rendered)}
            controls
            preload="metadata"
            onError={() => setPlayError(true)}
          />
          {props.readOnly ? (
            <p className="muted">这一版已经通过。要改就回成片卡「重开:改选段再出一版」。</p>
          ) : (
            <>
              <div className="row-actions">
                <button className="primary" disabled={busy} onClick={() => void decide("approve")}>
                  通过
                </button>
                <button disabled={busy} onClick={() => void decide("reject")}>
                  打回重剪
                </button>
              </div>
              <p className="muted">打回 = 回选段视图改勾选,重新组装渲染出新一版;这一版 mp4 会留档不删。</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
