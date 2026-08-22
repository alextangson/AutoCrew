/**
 * 成片计划(向导第 2 步,横屏 spec §3.5)——剪辑师排的 B-roll 与强调词,人只删不改。
 *
 * 四条纪律:
 * 1. **只删不改**:这一版不做时间轴拖拽。能删掉就够人兜住 AI 的错;摆半成品的拖拽出来
 *    只会让人以为它能用。删光也合法——那就是一条纯口播。
 * 2. **乐观锁**:提交带 plan_revision;`conflict:true` 不是故障,是「后台又跑出一版」。
 * 3. **不静默降级**:warning(没跑成)与 note(合法空)分开显示;被排除的素材必须点名,
 *    否则人只会看到空计划,不知道是自己少写了一行说明。
 * 4. **对不上的强调词要说**:归一化后仍匹配不到转写的词不会亮,当场标出来。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "../ui";
import {
  editorPlanSummary,
  formatTimecode,
  videoEditorConfirm,
  videoEditorPlanGet,
  videoEditorRerun,
  type EditorPlanView,
  type VideoState,
} from "../lib";

export function VideoPlanStep(props: {
  contentId: string;
  state: VideoState;
  reload: () => Promise<void>;
  back: () => void;
}) {
  const planRev = props.state.revisions.editor ?? 0;
  const waiting = props.state.state !== "awaiting_human";

  const [view, setView] = useState<EditorPlanView | null>(null);
  const [dropped, setDropped] = useState<ReadonlySet<string>>(new Set<string>());
  const [droppedWords, setDroppedWords] = useState<ReadonlySet<string>>(new Set<string>());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 手里这份是给哪一版拉的。不记这个,新版本刚到、还没拉回来的那一帧会闪出「没找到」 */
  const [loadedRev, setLoadedRev] = useState(-1);

  const load = useCallback(async () => {
    const r = await videoEditorPlanGet(props.contentId);
    if (!r.ok) return setErr(r.error ?? "读不到成片计划");
    setErr(null);
    setView(r.data ?? null);
    setLoadedRev(planRev);
    setDropped(new Set<string>());
    setDroppedWords(new Set<string>());
  }, [props.contentId, planRev]);

  // 版本变了(重跑过、或冲突后被刷新)就整份重拉:删除状态跟着最新那版走
  useEffect(() => {
    void load();
  }, [load]);

  /** 拉回来的就是当前这版才敢往外画:否则画的是上一版的编排 */
  const ready = loadedRev === planRev;

  const plan = view?.plan ?? null;
  const overlays = useMemo(() => plan?.overlays.filter((o) => !dropped.has(o.overlayId)) ?? [], [plan, dropped]);
  const words = useMemo(() => plan?.emphasisWords.filter((w) => !droppedWords.has(w)) ?? [], [plan, droppedWords]);
  const unmatched = new Set(plan?.unmatchedEmphasis ?? []);

  const rerun = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await videoEditorRerun(props.contentId);
      if (!r.ok) return toast(r.error ?? "重跑剪辑师失败");
      toast("剪辑师已重新排队 —— 跑完这里会自动刷新");
      await props.reload();
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!view || busy) return;
    setBusy(true);
    try {
      const r = await videoEditorConfirm({
        contentId: props.contentId,
        planRevision: view.revision,
        keptOverlayIds: overlays.map((o) => o.overlayId),
        keptEmphasisWords: words,
      });
      if (r.conflict) {
        toast("成片计划已过期,已刷新最新版 —— 请重新确认一次");
        await props.reload();
        await load();
        return;
      }
      if (!r.ok) return toast(r.error ?? "确认成片计划失败");
      toast("计划已确认 —— 组装和渲染在后台跑");
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
        <span className="mono muted">① 选段 ✓ → ② 成片计划 · 计划 v{planRev}</span>
        <span className="mono muted vid-sub-right">
          留 {overlays.length}/{plan?.overlays.length ?? 0} 段 B-roll
        </span>
      </div>

      {err && <p className="ed-error">{err}</p>}
      {waiting && <p className="muted">剪辑师在看素材排 B-roll —— 跑完这一页会自己变。</p>}
      {ready && plan?.warning && <p className="vid-warn">{plan.warning}</p>}
      {ready && plan?.excludedAssets && plan.excludedAssets.length > 0 && (
        <p className="vid-warn">
          这 {plan.excludedAssets.length} 个素材剪辑师看不见它们:{plan.excludedAssets.join("、")}
          (给素材写一行说明,重跑一次就能用上)
        </p>
      )}

      {plan && ready && !waiting && (
        <>
          <p className="muted">{editorPlanSummary(plan)}</p>
          {plan.overlays.length > 0 && (
            <ul className="vid-segs">
              {plan.overlays.map((o) => {
                const off = dropped.has(o.overlayId);
                const trim = o.inMs !== undefined && o.outMs !== undefined ? ` · 取材 ${formatTimecode(o.inMs)}–${formatTimecode(o.outMs)}` : "";
                return (
                  <li key={o.overlayId} className={"vid-seg" + (off ? " vid-seg-off" : "")}>
                    <span className="mono muted vid-seg-time">
                      {formatTimecode(o.outputStartMs)}–{formatTimecode(o.outputStartMs + o.durationMs)}
                    </span>
                    <span className="chip">{o.kind === "image" ? "图版" : "屏录"}</span>
                    <span className="vid-seg-text">
                      {o.label}
                      <span className="mono muted">
                        {" "}
                        · {(o.durationMs / 1000).toFixed(1)}s{trim} · {o.filename}
                      </span>
                    </span>
                    <button
                      onClick={() =>
                        setDropped((cur) => {
                          const next = new Set(cur);
                          if (!next.delete(o.overlayId)) next.add(o.overlayId);
                          return next;
                        })
                      }
                    >
                      {off ? "撤销删除" : "删掉这段"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="row-actions vid-seg-tools">
            <span className="muted">
              强调词(字幕里点亮){plan.emphasisWords.length === 0 ? ":剪辑师没挑出来" : ""}
            </span>
            {plan.emphasisWords.map((w) => {
              const off = droppedWords.has(w);
              return (
                <button
                  key={w}
                  className={"chip" + (off ? " vid-seg-off" : "")}
                  title={unmatched.has(w) ? "转写里找不到这个词,它不会亮" : "点一下删掉"}
                  onClick={() =>
                    setDroppedWords((cur) => {
                      const next = new Set(cur);
                      if (!next.delete(w)) next.add(w);
                      return next;
                    })
                  }
                >
                  {w}
                  {unmatched.has(w) ? " ⚠" : ""}
                  {off ? " ↩" : " ×"}
                </button>
              );
            })}
          </div>
          {unmatched.size > 0 && (
            <p className="muted">带 ⚠ 的词在转写里找不到(念的和写的不一样?),它们不会亮。</p>
          )}

          <div className="row-actions">
            <button className="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? "提交中…" : overlays.length === 0 ? "确认:出纯口播" : `确认 ${overlays.length} 段,开始组装`}
            </button>
            <button disabled={busy} onClick={() => void rerun()}>
              重新跑剪辑师
            </button>
            <button onClick={props.back}>回成片卡</button>
          </div>
        </>
      )}

      {!waiting && !err && !ready && <p className="muted">读取成片计划中…</p>}
      {/* 状态说这一步跑完了,产物却不在——只可能是定版没落位。不假装还在加载 */}
      {!plan && !waiting && !err && ready && (
        <div className="vid-bad">
          <strong>没找到成片计划 v{planRev} 这份产物</strong>
          <p>状态说剪辑师跑完了,但文件不在。重排一版就好,旧的不会被覆盖。</p>
          <div className="row-actions">
            <button className="primary" disabled={busy} onClick={() => void rerun()}>
              重新跑剪辑师
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
