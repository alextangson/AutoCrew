/**
 * 选段视图(视频 spec §4.4 人工路径 + 粗剪 spec §6)——剪辑单元列表,勾上=留,不勾=剪掉。
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
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "../ui";
import {
  CUT_FLAG_LABEL,
  alignmentWarning,
  formatTimecode,
  keepsInTranscriptOrder,
  roughCutSummary,
  videoCutConfirm,
  videoRoughCutRerun,
  videoTranscriptGet,
  type CutFlagKind,
  type CutView,
  type VideoState,
} from "../lib";

export function VideoCutPanel(props: {
  contentId: string;
  state: VideoState;
  reload: () => Promise<void>;
  back: () => void;
}) {
  const tRev = props.state.revisions.transcript ?? 0;
  const cRev = props.state.revisions.cut ?? 0;
  /** done 上进来 = 重开(§2.2 done→assemble 白名单边):确认后会重新组装渲染 */
  const reopening = props.state.phase === "done";

  const [data, setData] = useState<CutView | null>(null);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set<string>());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      toast(reopening ? "已重开 —— 按新选段重新组装渲染,旧成片留档" : "选段已确认 —— 组装和渲染在后台跑");
      await props.reload();
      props.back();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vid-sub">
      <div className="vid-sub-bar">
        <button onClick={props.back}>← 成片卡</button>
        <span className="mono muted">
          选段 · 基于转写 v{tRev} / 选段 v{cRev}
        </span>
        <span className="mono muted vid-sub-right">
          留 {kept.size}/{segments.length} 句 · 约 {formatTimecode(keptMs)}
        </span>
      </div>

      {err && <p className="ed-error">{err}</p>}
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
              <li key={s.id} className={"vid-seg" + (kept.has(s.id) ? "" : " vid-seg-off")}>
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
                  <span className="vid-seg-text">{s.text}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            <button className="primary" disabled={busy || kept.size === 0} onClick={() => void submit()}>
              {busy ? "提交中…" : reopening ? "确认并重出一版" : "确认选段"}
            </button>
            <button onClick={props.back}>取消</button>
            {kept.size === 0 && <span className="muted">一句都没留,成片会是空的 —— 至少留一句。</span>}
          </div>
        </>
      )}
    </div>
  );
}
