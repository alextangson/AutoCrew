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
import { useRef, useState } from "react";
import { confirmDialog, openDialog, toast } from "../ui";
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
  /** 打回时把播放头位置一起带上:「第 3 分 20 秒那段不对」比「B-roll 不对」有用得多 */
  const player = useRef<HTMLVideoElement | null>(null);

  const approve = async () => {
    if (busy || rendered === undefined) return;
    const yes = await confirmDialog({
      title: "这条成片通过?",
      body:
        "通过 = 认这一版可以发了(会记下达成时间),并清理测试产物:预览、废弃成片、可重算的音轨。" +
        "通过版成片、它引用的音轨与全部决策记录都留着,A-roll 原片和素材库文件永不触碰。",
      confirmLabel: "通过",
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await videoReviewConfirm({ contentId: props.contentId, renderedRevision: rendered, verdict: "approve" });
      if (r.conflict) {
        toast("版本已过期,已刷新最新版 —— 请重新看一遍再确认");
        await props.reload();
        return;
      }
      if (!r.ok) return toast(r.error ?? "审片确认失败");
      toast("已通过 ✓ 成片可以发了" + (r.data?.stampWarning ? ` · ${r.data.stampWarning}` : ""));
      await props.reload();
      props.back();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 打回分流(lifecycle §2.2):**B-roll 不对只回门二**,选段与决策链原样在,
   * 改完槽再确认只重走组装+渲染;说错了话才回门一重选段。
   * 备注与播放位置一起落进不可变记录——回到那道门时它还在(§2.4)。
   */
  const reject = async (target: "edit" | "cut") => {
    if (busy || rendered === undefined) return;
    const where = target === "edit" ? "成片计划(改 B-roll)" : "选段(改留哪些句子)";
    const at = player.current?.currentTime;
    const v = await openDialog({
      title: `打回到${where}?`,
      body: "写一句「哪里不对」,回到那道门时这句话还在。这一版 mp4 留档不删。",
      fields: [{ key: "note", label: "哪里不对", placeholder: "例:这段屏录跟我说的界面对不上", multiline: true }],
      confirmLabel: "打回",
    });
    if (!v) return;
    setBusy(true);
    try {
      const r = await videoReviewConfirm({
        contentId: props.contentId,
        renderedRevision: rendered,
        verdict: "reject",
        target,
        ...(typeof at === "number" && at > 0 ? { timestampMs: Math.round(at * 1000) } : {}),
        ...(v.note.trim() ? { note: v.note.trim() } : {}),
      });
      if (r.conflict) {
        toast("版本已过期,已刷新最新版 —— 请重新看一遍再确认");
        await props.reload();
        return;
      }
      if (!r.ok) return toast(r.error ?? "审片确认失败");
      toast(`已打回到${where} —— 这版成片留档不删`);
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
            ref={player}
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
                <button className="primary" disabled={busy} onClick={() => void approve()}>
                  通过
                </button>
                <button disabled={busy} onClick={() => void reject("edit")}>
                  打回:改 B-roll
                </button>
                <button disabled={busy} onClick={() => void reject("cut")}>
                  打回:改选段
                </button>
              </div>
              <p className="muted">
                B-roll 不对就打回成片计划:选段和转写都不动,改完槽位再确认,只重走组装和渲染。
                话说错了才回选段——那会让剪辑师按新选段重排一遍。播放头停在哪儿,打回时就带上哪个时间点。
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
