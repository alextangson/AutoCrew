/**
 * 选段视图(视频 spec §4.4 人工路径 + 粗剪 spec §6)——剪辑单元列表,勾上=留,不勾=剪掉。
 *
 * 从横屏 spec §3.5 起它是**两步向导的第 1 步**:确认选段之后不回卡片,直接停在同一页的
 * 第 2 步「成片计划」等剪辑师排完。两步各自是独立组件而不是一个组件里的分支——
 * phase 变化时如果只切分支,hook 数量会随之变化,React 当场报「渲染的 hook 比上次少」。
 *
 * 五条纪律:
 * 1. **乐观锁**:提交必须带手里这版的 base revision;`conflict:true` 不是故障,
 *    是「有人/后台改过了」——提示已刷新最新版并重拉,绝不覆盖别人的决定。
 *    改字带的是**三版**(转写/文字/选段):文字住在 clean 里,少锁一版就会盲改。
 * 2. **ASR 事实不可改**:门上改的字落派生产物 `transcript-clean`(转写纠错 spec §6),
 *    `transcript.vN` 一个字都不动——「这个字是听成这样的还是人改的」要一直说得清。
 * 3. **空结果说人话**:一句都没转写出来、一句都没勾,都要当场讲清楚,不让人对着
 *    禁用按钮猜为什么。
 * 4. **AI 只是提案**:降级 warning 原样摆出来;flags 是只读证据,「恢复全留」之后也不清除
 *    ——人需要知道 AI 当时认为哪里有问题。「恢复全留」**现场算当前单元的全集**,
 *    不能钉死某一版:重跑转写会继续递增 revision,写死的那版会指向错的东西。
 * 5. **勾选是脏增量**:本地只记「人显式动过哪几行」,新数据到达后套在最新 keeps 上
 *    (cut-keeps.ts)。数据会在人勾到一半时被刷新(改了个错字、后台渲完预览),
 *    整份重置等于每改一次字就白挑一轮。
 *
 * 屏录/图片覆盖轨(overlays)service 已经支持,但摆时间轴那套交互还没做——
 * 现在把半成品放上来只会让人以为它已经能用。
 *
 * v2 起门内多了一个**看片器**(spec §4.1):低规格预览是「看一眼自己剪的是什么」,
 * 不是成片。预览没渲出来也照样能确认——门就是门,不被渲染阻塞。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { confirmDialog, toast } from "../ui";
import {
  CUT_FLAG_LABEL,
  VIDEO_TEXT_EDIT_MAX_CHARS,
  alignmentWarning,
  formatTimecode,
  keepsInTranscriptOrder,
  previewStatus,
  roughCutSummary,
  videoCutConfirm,
  videoCutPreview,
  videoPreviewUrl,
  videoRoughCutRerun,
  videoTranscribeRerun,
  videoTranscriptGet,
  videoTranscriptTextEdit,
  type CutFlagKind,
  type CutView,
  type TranscriptSegment,
  type VideoReviewDecision,
  type VideoState,
} from "../lib";
import { keptWithDelta, withToggle, type KeepDelta } from "./cut-keeps";
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

/**
 * 行内改字(转写纠错 spec §6)。只改文字——时间码、勾选、这一句在成片里的位置都不动,
 * 所以编辑框里只有一个 textarea,没有第二个能改坏东西的控件。
 */
function SegTextEditor(props: { text: string; busy: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(props.text);
  const chars = [...draft.trim()].length;
  const tooLong = chars > VIDEO_TEXT_EDIT_MAX_CHARS;
  return (
    <div className="vid-seg-edit">
      <textarea rows={2} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
      <span className="row-actions">
        <span className={tooLong ? "ed-error" : "muted mono"}>
          {chars}/{VIDEO_TEXT_EDIT_MAX_CHARS} 字 · 只改文字,时间与勾选不动;改完成片字幕用新文字
        </span>
        <button onClick={props.onCancel}>取消</button>
        <button className="primary" disabled={props.busy || chars === 0 || tooLong} onClick={() => props.onSave(draft.trim())}>
          {props.busy ? "保存中…" : "保存这句"}
        </button>
      </span>
    </div>
  );
}

interface SegRowProps {
  seg: TranscriptSegment;
  kept: boolean;
  flags: CutFlagKind[];
  /** 打回时点名的那一句 */
  flagged: boolean;
  /** 没有清洗版的老稿件改不了字(后端也会拒),按钮就别摆出来 */
  editable: boolean;
  editing: boolean;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (text: string) => void;
}

/**
 * 一行 = 勾选区(label)与操作区**并列**,而不是整行一个 `<label>`:
 * label 包着按钮时,点「改字」会顺带把这一句的勾选切掉(codex 抓的 DOM 坑,spec §6)。
 */
function SegRow(props: SegRowProps) {
  const { seg } = props;
  return (
    <li className={"vid-seg" + (props.kept ? "" : " vid-seg-off") + (props.flagged ? " vid-seg-flagged" : "")}>
      <div className="vid-seg-row">
        <label className="vid-seg-pick">
          <input type="checkbox" checked={props.kept} onChange={props.onToggle} />
          <span className="mono muted vid-seg-time">
            {formatTimecode(seg.startMs)}–{formatTimecode(seg.endMs)}
          </span>
          {props.flags.map((f) => (
            <span key={f} className="chip">
              {CUT_FLAG_LABEL[f]}
            </span>
          ))}
          <span className="vid-seg-text">
            {props.flagged ? <strong>你打回时指的就是这一句 · </strong> : null}
            {seg.text}
          </span>
        </label>
        {props.editable && !props.editing && (
          <button className="vid-seg-edit-btn" disabled={props.busy} onClick={props.onEdit}>
            改字
          </button>
        )}
      </div>
      {props.editing && (
        <SegTextEditor text={seg.text} busy={props.busy} onSave={props.onSave} onCancel={props.onCancelEdit} />
      )}
    </li>
  );
}

function CutStep(props: StepProps) {
  const tRev = props.state.revisions.transcript ?? 0;
  const cRev = props.state.revisions.cut ?? 0;
  /** 文字版本(清洗/手改);0 = 这一稿还没有清洗版,改字无从下手 */
  const clRev = props.state.revisions.clean ?? 0;
  /** done 上进来 = 重开(§2.2 done→assemble 白名单边):确认后会重新组装渲染 */
  const reopening = props.state.phase === "done";

  const [data, setData] = useState<CutView | null>(null);
  /** 人显式动过的勾选增量(spec §6):数据被刷新时,没提交的勾选靠它活下来 */
  const [delta, setDelta] = useState<KeepDelta>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playError, setPlayError] = useState(false);

  const load = useCallback(async () => {
    const r = await videoTranscriptGet(props.contentId);
    if (!r.ok) return setErr(r.error ?? "读不到转写");
    if (!r.data) return setErr("这篇还没有转写/选段文件 —— 回成片卡看状态");
    setErr(null);
    setData(r.data);
  }, [props.contentId]);

  // revision 变了(自己确认过、改过字、或冲突后被刷新)就整份重拉;
  // 勾选不跟着重置——它由「服务端最新 keeps + 本地增量」现算(keptWithDelta)
  useEffect(() => {
    void load();
  }, [load, tRev, clRev, cRev]);

  // 换代就清增量:重跑转写会整代换掉单元编号,而 unit-0001 这种号跨代复用(spec §7)
  useEffect(() => setDelta(new Map()), [tRev]);

  // 单元表在就用它;老产物(V0a)没有,回落 VAD 分句
  const segments = useMemo(
    () => data?.editUnits?.segments ?? data?.transcript.segments ?? [],
    [data],
  );
  const kept = useMemo(
    () => keptWithDelta({ keeps: data?.cut.keeps ?? [], ids: segments.map((s) => s.id), delta }),
    [data, segments, delta],
  );
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
  /**
   * 改字只在选段门上成立(后端同判):没有清洗版的老稿件无从改起(clRev=0),
   * done 上重开的那一版也不行——摆一个按下去必被拒的按钮比没有按钮更糟。
   */
  const editable = clRev > 0 && !reopening;

  // 现场算全集:指向的永远是当前这版单元。全选/全不留都算「对每一行各按了一次」,
  // 所以逐行记进增量——否则下一次刷新就把这一下点没了
  const setAll = (on: boolean) =>
    setDelta((cur) => withToggle(cur, segments.map((s) => [s.id, on] as [string, boolean])));

  const rerun = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await videoRoughCutRerun(props.contentId);
      if (!r.ok) return toast(r.error ?? "重跑 AI 粗剪失败");
      // 新一版建议会按词区间重分单元,旧编号对应的已经是另一段话——本地增量跟着作废
      setDelta(new Map());
      toast("AI 粗剪已重新排队 —— 跑完这里会自动刷新");
      await props.reload();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 重跑转写(spec §7):热词与清洗口径都换了才用得上它。**会作废这一版选段与手工改字**
   * ——旧产物留档不删,但门上这一版从此指向新的文字,所以按之前先当面问一句。
   */
  const rerunAsr = async () => {
    if (busy) return;
    const yes = await confirmDialog({
      title: "重跑转写?",
      body: "会用当前稿件重新认一遍文字。这一版的选段勾选与手工改字都会作废(旧版本留档不删),转写与 AI 粗剪要重跑一轮。",
      confirmLabel: "重跑转写",
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    try {
      const r = await videoTranscribeRerun(props.contentId);
      if (!r.ok) return toast(r.error ?? "重跑转写失败");
      setDelta(new Map());
      setEditing(null);
      toast("转写已重新排队 —— 跑完这里会自动刷新");
      await props.reload();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 手工改一句的文字(spec §6)。三个 base 一起带;`conflict` 不是故障——
   * 有人(或后台)换过文字,重拉最新版让人对着新文字再改一次。
   */
  const saveText = async (unitId: string, text: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await videoTranscriptTextEdit({
        contentId: props.contentId,
        unitId,
        text,
        baseTranscriptRevision: tRev,
        baseCleanRevision: clRev,
        baseCutRevision: cRev,
      });
      if (r.conflict) {
        toast("这版文字已过期,已刷新最新版 —— 请对着新文字再改一次");
        setEditing(null);
        await props.reload();
        await load();
        return;
      }
      if (!r.ok) return toast(r.error ?? "改字没保存成功");
      setEditing(null);
      // 勾选增量刻意不清:改个错字不该把人刚挑到一半的选段抹掉(spec §6 dirty-delta)
      toast(
        preview.rendering
          ? "这一句已改 —— 正在渲的那版预览烧的是旧字,已作废;要看新字再点一次「重新生成预览」"
          : "这一句已改 —— 成片字幕与下一版预览都会用新文字",
      );
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

  const toggle = (id: string) => setDelta((cur) => withToggle(cur, [[id, !kept.has(id)]]));

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
      // 服务端已经采纳这份勾选,本地增量到此为止(留着它只会盖在下一版的基线上)
      setDelta(new Map());
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
          {/* 文字版本也摆出来:手改会推它,人一眼看得出「现在用的是哪一版字」 */}
          ① 选段 → ② 成片计划 · 基于转写 v{tRev}
          {clRev > 0 ? ` / 文字 v${clRev}` : ""} / 选段 v{cRev}
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
      {/* 清洗降级的人话(spec §8 #4):哪几段没被纠错要看得见,否则人以为字都过过一遍 */}
      {data?.cleanWarning && <p className="vid-warn">{data.cleanWarning}</p>}
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
            {/* 唯一能回到转写的出口(spec §7);按钮上就写明它作废什么,按下去还会再问一次 */}
            <button disabled={busy || reopening} onClick={() => void rerunAsr()}>
              重跑转写(作废选段与手改)
            </button>
            <span className="muted">
              勾上的句子按原顺序拼成成片;时间码是 A-roll 里的原始位置。
              {rerunnable ? "" : "这一版你已经确认过,AI 建议不会再覆盖它。"}
              {clRev > 0 ? "" : "这一版转写没有可改的文字(老稿件),要改错字先重跑转写。"}
            </span>
          </div>
          <ul className="vid-segs">
            {segments.map((s) => (
              <SegRow
                key={s.id}
                seg={s}
                kept={kept.has(s.id)}
                flags={flags.get(s.id) ?? []}
                flagged={s.id === flagged}
                editable={editable}
                editing={editing === s.id}
                busy={busy}
                onToggle={() => toggle(s.id)}
                onEdit={() => setEditing(s.id)}
                onCancelEdit={() => setEditing(null)}
                onSave={(text) => void saveText(s.id, text)}
              />
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
