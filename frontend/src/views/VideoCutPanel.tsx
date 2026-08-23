/**
 * 选段视图(视频 spec §4.4 人工路径 + 粗剪 spec §6)——剪辑单元列表,勾上=留,不勾=剪掉。
 *
 * 从横屏 spec §3.5 起它是**两步向导的第 1 步**:确认选段之后不回卡片,直接停在同一页的
 * 第 2 步「成片计划」等剪辑师排完。两步各自是独立组件而不是一个组件里的分支——
 * phase 变化时如果只切分支,hook 数量会随之变化,React 当场报「渲染的 hook 比上次少」。
 *
 * 四条纪律:
 * 1. **乐观锁**:提交必须带手里这版的 base revision;`conflict:true` 不是故障,
 *    是「有人/后台改过了」——提示已刷新最新版并重拉,绝不覆盖别人的决定。
 * 2. **转写是事实,不可改**:这里只写「留哪些」(cut),一个字都不改转写。
 * 3. **空结果说人话**:一句都没转写出来、一句都没勾,都要当场讲清楚,不让人对着
 *    禁用按钮猜为什么。
 * 4. **AI 只是提案**:降级 warning 原样摆出来;flags 是只读证据,「恢复全留」之后也不清除
 *    ——人需要知道 AI 当时认为哪里有问题。「恢复全留」**现场算当前单元的全集**,
 *    不能钉死某一版:重跑转写会继续递增 revision,写死的那版会指向错的东西。
 *
 * 屏录/图片覆盖轨(overlays)service 已经支持,但摆时间轴那套交互还没做——
 * 现在把半成品放上来只会让人以为它已经能用。
 *
 * v2 起门内多了一个**看片器**(spec §4.1):低规格预览是「看一眼自己剪的是什么」,
 * 不是成片。预览没渲出来也照样能确认——门就是门,不被渲染阻塞。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "../ui";
import {
  CUT_FLAG_LABEL,
  alignmentWarning,
  formatTimecode,
  keepsInTranscriptOrder,
  previewStatus,
  roughCutSummary,
  videoCutConfirm,
  videoCutPreview,
  videoPreviewUrl,
  videoRoughCutRerun,
  videoTranscriptGet,
  type CutFlagKind,
  type CutView,
  type VideoReviewDecision,
  type VideoState,
} from "../lib";
import { VideoPlanStep } from "./VideoPlanStep";

interface StepProps {
  contentId: string;
  state: VideoState;
  /** 门三打回时留下的备注与定位;两道门都要能原样显示(lifecycle §2.4) */
  review?: VideoReviewDecision;
  reload: () => Promise<void>;
  back: () => void;
}

/** 向导入口:phase 决定站在哪一步 */
export function VideoCutPanel(props: StepProps) {
  return props.state.phase === "edit" ? <VideoPlanStep {...props} /> : <CutStep {...props} />;
}

function CutStep(props: StepProps) {
  const tRev = props.state.revisions.transcript ?? 0;
  const cRev = props.state.revisions.cut ?? 0;
  /** done 上进来 = 重开(§2.2 done→assemble 白名单边):确认后会重新组装渲染 */
  const reopening = props.state.phase === "done";

  const [data, setData] = useState<CutView | null>(null);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set<string>());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playError, setPlayError] = useState(false);

  const load = useCallback(async () => {
    const r = await videoTranscriptGet(props.contentId);
    if (!r.ok) return setErr(r.error ?? "读不到转写");
    if (!r.data) return setErr("这篇还没有转写/选段文件 —— 回成片卡看状态");
    setErr(null);
    setData(r.data);
    setKept(new Set(r.data.cut.keeps));
  }, [props.contentId]);

  // revision 变了(自己确认过、或冲突后被刷新)就整份重拉:勾选状态跟着最新那版走
  useEffect(() => {
    void load();
  }, [load, tRev, cRev]);

  // 单元表在就用它;老产物(V0a)没有,回落 VAD 分句
  const segments = data?.editUnits?.segments ?? data?.transcript.segments ?? [];
  const flags = useMemo(() => {
    const map = new Map<string, CutFlagKind[]>();
    for (const f of data?.cut.flags ?? []) map.set(f.segmentId, [...(map.get(f.segmentId) ?? []), f.flag]);
    return map;
  }, [data]);
  const keptMs = segments.reduce((sum, s) => (kept.has(s.id) ? sum + Math.max(0, s.endMs - s.startMs) : sum), 0);
  const warn = alignmentWarning(data?.transcript ?? null);
  /** 打回时点名的那一句:高亮它,人一眼看见「你说的是这一句」(§2.4) */
  const flagged = props.review?.locate?.kind === "segment" ? props.review.locate.segmentId : null;
  const aiWarn = data?.editUnits?.warning;
  const aiSummary = roughCutSummary(data?.editUnits);
  /** 人工终裁过的那一版,后台不许再覆盖(粗剪 spec §3.4) */
  const rerunnable = data?.cut.origin !== "human" && !reopening;

  // 现场算全集:指向的永远是当前这版单元
  const setAll = (on: boolean) => setKept(on ? new Set(segments.map((s) => s.id)) : new Set<string>());

  const rerun = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await videoRoughCutRerun(props.contentId);
      if (!r.ok) return toast(r.error ?? "重跑 AI 粗剪失败");
      toast("AI 粗剪已重新排队 —— 跑完这里会自动刷新");
      await props.reload();
    } finally {
      setBusy(false);
    }
  };
  /** 预览是低规格的看片辅助:渲不出来就把原因摆出来,门照开(边界 #1) */
  const preview = previewStatus(props.state.preview);
  useEffect(() => setPlayError(false), [preview.playableRevision]);
  const rerenderPreview = async () => {
    if (busy || kept.size === 0) return;
    setBusy(true);
    try {
      const r = await videoCutPreview({
        contentId: props.contentId,
        keeps: keepsInTranscriptOrder(segments, kept),
        baseTranscriptRevision: tRev,
        baseCutRevision: cRev,
      });
      if (r.conflict) {
        toast("版本已过期,已刷新最新版 —— 请重新确认一次");
        await props.reload();
        await load();
        return;
      }
      if (!r.ok) return toast(r.error ?? "生成预览失败");
      toast("预览在后台渲染 —— 好了这一页会自己出现");
      await props.reload();
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setKept((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const submit = async () => {
    if (!data || busy) return;
    setBusy(true);
    try {
      const r = await videoCutConfirm({
        contentId: props.contentId,
        keeps: keepsInTranscriptOrder(segments, kept),
        flags: data.cut.flags,
        baseTranscriptRevision: tRev,
        baseCutRevision: cRev,
      });
      if (r.conflict) {
        toast("版本已过期,已刷新最新版 —— 请重新确认一次");
        await props.reload();
        await load();
        return;
      }
      if (!r.ok) return toast(r.error ?? "确认选段失败");
      // 不回卡片:下一步(成片计划)就在同一页,剪辑师排完这里会自己变成第 2 步
      toast(reopening ? "已重开 —— 剪辑师按新选段重排 B-roll" : "选段已确认 —— 剪辑师在排 B-roll");
      await props.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vid-sub">
      <div className="vid-sub-bar">
        <button onClick={props.back}>← 成片卡</button>
        <span className="mono muted">
          ① 选段 → ② 成片计划 · 基于转写 v{tRev} / 选段 v{cRev}
        </span>
        <span className="mono muted vid-sub-right">
          留 {kept.size}/{segments.length} 句 · 约 {formatTimecode(keptMs)}
        </span>
      </div>

      {err && <p className="ed-error">{err}</p>}
      {/* 打回备注落在不可变记录里,刷新、换窗口、隔天再来都还在(§2.4) */}
      {props.review?.verdict === "reject" && props.review.target === "cut" && (
        <p className="vid-warn">
          你把成片 v{props.review.renderedRevision} 打回到了这一步
          {props.review.timestampMs !== undefined ? `(${formatTimecode(props.review.timestampMs)} 处)` : ""}
          {props.review.note ? `:${props.review.note}` : "。"}
        </p>
      )}
      {aiWarn && <p className="vid-warn">{aiWarn}</p>}
      {warn && <p className="vid-warn">{warn}</p>}
      {reopening && <p className="vid-warn">这条已经出过成片。改完确认会重新组装渲染出新一版,旧成片留档不删。</p>}
      {aiSummary && <p className="muted">{aiSummary}(下面已按建议预勾,最终留哪些由你定)</p>}

      {!err && !data && <p className="muted">读取转写中…</p>}
      {data && segments.length === 0 && (
        <p className="ed-error">这条素材一句都没转写出来(纯音乐或全程静音?)——换素材,或回成片卡重跑转写。</p>
      )}

      {segments.length > 0 && (
        <>
          {preview.message && <p className="vid-warn">{preview.message}</p>}
          {playError && (
            <p className="ed-error">
              预览播不出来 —— 多半是它已经被更新的一版顶掉了(只留最新)。点「重新生成预览」再出一版。
            </p>
          )}
          {preview.playableRevision !== null && !playError && (
            <video
              className="vid-player"
              // key 带版本号:换版时强制重建 <video>,不然浏览器会继续播缓存里那一版
              key={preview.playableRevision}
              src={videoPreviewUrl(props.contentId, preview.playableRevision)}
              controls
              preload="metadata"
              onError={() => setPlayError(true)}
            />
          )}
          {preview.playableRevision === null && !preview.message && (
            <p className="muted">这一版还没有预览 —— 勾完点「重新生成预览」看一眼。</p>
          )}
          <div className="row-actions vid-seg-tools">
            <button disabled={busy || kept.size === 0} onClick={() => void rerenderPreview()}>
              {preview.rendering ? "预览渲染中…" : "重新生成预览"}
            </button>
            <span className="muted">预览是 540p 快出的低规格片,只用来看剪得对不对;成片按全规格另渲。</span>
          </div>
          <div className="row-actions vid-seg-tools">
            <button onClick={() => setAll(true)}>恢复全留</button>
            <button onClick={() => setAll(false)}>全不留</button>
            <button disabled={busy || !rerunnable} onClick={() => void rerun()}>
              重新跑 AI 粗剪
            </button>
            <span className="muted">
              勾上的句子按原顺序拼成成片;时间码是 A-roll 里的原始位置。
              {rerunnable ? "" : "这一版你已经确认过,AI 建议不会再覆盖它。"}
            </span>
          </div>
          <ul className="vid-segs">
            {segments.map((s) => (
              <li
                key={s.id}
                className={"vid-seg" + (kept.has(s.id) ? "" : " vid-seg-off") + (s.id === flagged ? " vid-seg-flagged" : "")}
              >
                <label>
                  <input type="checkbox" checked={kept.has(s.id)} onChange={() => toggle(s.id)} />
                  <span className="mono muted vid-seg-time">
                    {formatTimecode(s.startMs)}–{formatTimecode(s.endMs)}
                  </span>
                  {(flags.get(s.id) ?? []).map((f) => (
                    <span key={f} className="chip">
                      {CUT_FLAG_LABEL[f]}
                    </span>
                  ))}
                  <span className="vid-seg-text">
                    {s.id === flagged ? <strong>你打回时指的就是这一句 · </strong> : null}
                    {s.text}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            <button className="primary" disabled={busy || kept.size === 0} onClick={() => void submit()}>
              {busy ? "提交中…" : reopening ? "确认并重出一版" : "确认选段,去排 B-roll"}
            </button>
            <button onClick={props.back}>取消</button>
            {kept.size === 0 && <span className="muted">一句都没留,成片会是空的 —— 至少留一句。</span>}
          </div>
        </>
      )}
    </div>
  );
}
