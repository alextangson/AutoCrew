/**
 * 「成片」卡(视频 spec §8.4)——phase×state 状态机的可视化:每个状态只给该状态该做的事,
 * 底下挂选段视图与审片视图两个人工门。
 *
 * 四条纪律:
 * 1. **状态只有一个来源**:`video:status`。界面不自己推演下一步,后端说什么显示什么;
 *    刷新靠 SSE `video:updated` 驱动重拉 + 断线重连无条件重拉(§8.3 三、四)。
 * 2. **投递即返回**:按钮点完立刻回到「看状态」,不在界面里等 ASR/渲染。
 * 3. **不静默降级**:blocked/failed 把原因和下一步动作摆在卡上;冲突提示「已刷新最新版」
 *    而不是红色报错(video-handlers 纪律 4)。
 * 4. **状态变了就把人拉回卡上**:后台推进时手里那版 base revision 已经作废,
 *    继续留在选段/审片视图上只会提交出冲突。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { toast } from "../ui";
import {
  VIDEO_PHASE_LABEL,
  videoAsrStatus,
  videoAsrWarmup,
  videoBlockedGuide,
  videoBuildStart,
  videoFinalAssetName,
  videoReassemble,
  videoRetry,
  videoStateSummary,
  videoStatus,
  type VideoState,
  type VideoStatusData,
} from "../lib";
import { VideoCutPanel } from "./VideoCutPanel";
import { VideoReviewPanel } from "./VideoReviewPanel";

const ASR_LABEL: Record<string, string> = {
  absent: "未预热",
  warming: "预热中(约 1GB,可以先干别的)",
  ready: "已就绪",
  failed: "预热失败",
};

export function VideoPanel({ contentId }: { contentId: string }) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<VideoStatusData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"card" | "cut" | "review">("card");
  const [asr, setAsr] = useState<{ status: string; detail?: string } | null>(null);
  /** 预热完要不要自动接着剪,取决于「现在是不是还卡在 asr_not_ready」——轮询回调里读不到最新 state,故用 ref */
  const blockedOnAsr = useRef(false);

  const load = useCallback(async () => {
    const r = await videoStatus(contentId);
    setLoaded(true);
    if (!r.ok) return setErr(r.error ?? "读不到成片状态");
    setErr(null);
    setStatus(r.data ?? null);
  }, [contentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // SSE 三件套的订阅端:状态落盘 → 重拉;断线重连 → 无条件重拉(丢掉的事件补不回来)
  useEffect(
    () =>
      subscribeEvents((e) => {
        if (e.kind === "video:updated" && e.data.contentId === contentId) void load();
        else if (e.kind === "reconnect") void load();
      }),
    [contentId, load],
  );

  const st = status?.state ?? null;
  const canCut = !!st && ((st.phase === "cut" && st.state === "awaiting_human") || (st.phase === "done" && st.state === "done"));
  const canPlan = !!st && st.phase === "edit" && st.state === "awaiting_human";
  /**
   * 确认选段后**不回卡片**(VideoCutPanel 头注):整个 edit phase 都停在向导第 2 步——
   * 排队/在跑时那一页自己会说「剪辑师在排」。blocked/failed 不算:那两种要回卡片拿重试按钮。
   */
  const inPlan = !!st && st.phase === "edit" && (st.state === "queued" || st.state === "running" || st.state === "awaiting_human");
  const canReview = !!st && st.phase === "review" && st.state === "awaiting_human";
  const isDone = !!st && st.phase === "done" && st.state === "done";

  useEffect(() => {
    blockedOnAsr.current = st?.state === "blocked" && st.blockedReason === "asr_not_ready";
  }, [st]);

  // 后台把状态推走了,手里那版就作废——说一声再收回卡片,别让人对着废页面点确认
  useEffect(() => {
    if (view === "cut" && !canCut && !inPlan) {
      setView("card");
      toast("这一版选段已经被推进了,先看成片卡的最新状态");
    } else if (view === "review" && !canReview && !isDone) {
      setView("card");
      toast("成片状态变了,先看成片卡的最新状态");
    }
  }, [view, canCut, inPlan, canReview, isDone]);

  // 卡在「语音模型没就绪」时先看一眼预热进度:可能另一个窗口已经在下模型了
  useEffect(() => {
    if (st?.state === "blocked" && st.blockedReason === "asr_not_ready" && !asr) {
      void videoAsrStatus().then((r) => r.ok && r.data && setAsr(r.data));
    }
  }, [st, asr]);

  // 预热是分钟级的下载,只能轮询(spec §8.2:投递即返回,进度轮 video:asr_status)
  useEffect(() => {
    if (asr?.status !== "warming") return;
    const timer = window.setInterval(() => {
      void (async () => {
        const r = await videoAsrStatus();
        if (!r.ok || !r.data) return;
        setAsr(r.data);
        if (r.data.status === "failed") toast(`语音模型预热失败:${r.data.detail ?? "看任务日志"}`);
        if (r.data.status !== "ready") return;
        if (blockedOnAsr.current) {
          toast("语音模型已就绪 —— 自动接着往下剪");
          const rr = await videoRetry(contentId);
          if (!rr.ok) toast(rr.error ?? "自动继续失败,手动点一下「重试」");
        } else {
          toast("语音模型已就绪");
        }
        void load();
      })();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [asr?.status, contentId, load]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      toast(r.ok ? done : (r.error ?? "操作失败"));
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** 预热可能当场就 failed(比如没装 python)——那时报「已开始预热」就是撒谎,要把 detail 捞出来说清 */
  const warmup = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await videoAsrWarmup();
      if (!r.ok) return toast(r.error ?? "预热没起来");
      setAsr({ status: r.data?.status ?? "warming" });
      if (r.data?.status !== "failed") return toast("开始预热语音模型 —— 好了会自动接着剪");
      const detail = await videoAsrStatus();
      if (detail.ok && detail.data) setAsr(detail.data);
      toast(`预热没起来:${detail.data?.detail ?? "去「任务日志」看剪辑师那几条"}`);
    } finally {
      setBusy(false);
    }
  };

  const headline = st ? videoStateSummary(st) : loaded && !err ? "还没开始剪" : err ? "读不到状态" : "读取中…";
  /**
   * 下面每个分支各管一组 phase×state。**没被任何分支接住的组合要自己冒出来**——
   * 迁移表之外的组合(比如 assemble/awaiting_human)本不该出现,真出现了也绝不能
   * 显示成一张什么都不说的空卡。
   */
  const handled =
    !st ||
    st.state === "idle" ||
    st.state === "queued" ||
    st.state === "running" ||
    st.state === "blocked" ||
    st.state === "failed" ||
    canCut ||
    canPlan ||
    canReview ||
    isDone;

  return (
    <details className="ed-tools" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>成片 · {headline}</summary>
      {err && <p className="ed-error">{err}</p>}
      {view === "cut" && st && (canCut || inPlan) && (
        <VideoCutPanel contentId={contentId} state={st} reload={load} back={() => setView("card")} />
      )}
      {view === "review" && st && (canReview || isDone) && (
        <VideoReviewPanel
          contentId={contentId}
          state={st}
          readOnly={isDone}
          reload={load}
          back={() => setView("card")}
          toCut={() => setView("cut")}
        />
      )}
      {view === "card" && (
        <div className="vid-card">
          {loaded && (
            <div className="vid-head">
              <span className="mono muted">{err ? "" : st ? revisionLine(st) : "转写 / 选段 / 成片都还没有"}</span>
              <button onClick={() => void load()}>{err ? "重新读取" : "刷新"}</button>
            </div>
          )}
          {st && staleNote(st) && <p className="vid-warn">{staleNote(st)}</p>}
          {(!st || st.state === "idle") && !err && loaded && (
            <>
              <p className="muted">
                A-roll(你对着镜头拍的那条)挂进上面的「素材附件」后就能开工:转写 → 你勾选留哪些句子 → 组装渲染 → 你审片。
                全程后台跑,分钟级。
              </p>
              <button className="primary" disabled={busy} onClick={() => void act(() => videoBuildStart(contentId), "已投给剪辑师,后台在跑")}>
                开始构建
              </button>
            </>
          )}
          {st && (st.state === "queued" || st.state === "running") && (
            <p className="muted">
              {videoStateSummary(st)} —— 后台在跑,可以先干别的,好了这张卡会自己变。
              {attemptNote(status)}
            </p>
          )}
          {st?.state === "blocked" && (
            <BlockedBody
              state={st}
              busy={busy}
              asrLabel={asr ? (ASR_LABEL[asr.status] ?? asr.status) + (asr.detail ? ` · ${asr.detail}` : "") : null}
              warmup={() => void warmup()}
              retry={() => void act(() => videoRetry(contentId), "已重投,后台接着跑")}
            />
          )}
          {st?.state === "failed" && (
            <div className="vid-bad">
              <strong>{VIDEO_PHASE_LABEL[st.failedPhase ?? st.phase]}这一步失败了</strong>
              <p>{st.failReason || "没给出原因 —— 去「任务日志」看剪辑师那几条"}</p>
              {st.errorCode && <p className="mono muted">错误码 {st.errorCode}</p>}
              <div className="row-actions">
                <button className="primary" disabled={busy} onClick={() => void act(() => videoRetry(contentId), "已重投,从失败那一步接着跑")}>
                  重试
                </button>
                {/* 渲染失败可能是那份 manifest 本身作废了(例如旧 schema):重试只会重投同一份,
                    所以门上必须另有一条回组装的出口(v2 spec §2.3) */}
                {(st.failedPhase ?? st.phase) === "render" && (
                  <button
                    disabled={busy}
                    onClick={() => void act(() => videoReassemble(contentId), "已回到组装 —— 会重出一份渲染清单再渲")}
                  >
                    重新组装
                  </button>
                )}
              </div>
              {(st.failedPhase ?? st.phase) === "render" && (
                <p className="muted">
                  报错里提到「重新组装」就点右边那个:那说明渲染清单是旧版本产物,重试再多次也还是同一份。
                </p>
              )}
            </div>
          )}
          {st && !handled && (
            <div className="vid-bad">
              <strong>状态是「{VIDEO_PHASE_LABEL[st.phase]} / {st.state}」——这个组合不在迁移表里</strong>
              <p>界面不知道该给你什么按钮。去「任务日志」看剪辑师最近那几条,或刷新看看是不是已经走过去了。</p>
            </div>
          )}
          {canCut && !isDone && (
            <>
              <p className="muted">转写好了 —— 哪些句子留、哪些删,由你定。</p>
              <button className="primary" onClick={() => setView("cut")}>去选段 →</button>
            </>
          )}
          {canPlan && (
            <>
              <p className="muted">剪辑师排好 B-roll 了 —— 哪几段留、哪几段删,由你定。</p>
              <button className="primary" onClick={() => setView("cut")}>去看成片计划 →</button>
            </>
          )}
          {canReview && (
            <>
              <p className="muted">成片渲染好了 —— 看一遍再决定通过还是打回。</p>
              <button className="primary" onClick={() => setView("review")}>去审片 →</button>
            </>
          )}
          {isDone && (
            <div className="vid-done">
              <strong>已完成 ✓</strong>
              <p className="mono muted">
                {st.revisions.rendered
                  ? `成片:稿件素材里的 ${videoFinalAssetName(st.revisions.rendered)}(中间产物在稿件目录 video/ 下)`
                  : "状态是完成,但没记下成片版本号 —— 去稿件文件夹里找 final-v*.mp4"}
              </p>
              <div className="row-actions">
                <button onClick={() => setView("review")}>查看成片</button>
                <button onClick={() => setView("cut")}>重开:改选段再出一版</button>
                <button
                  onClick={async () => {
                    const r = await invoke("content:open_folder", { id: contentId });
                    toast(r.ok ? "已在 Finder 打开 —— 成片在 assets/ 里" : (r.error ?? "打开失败"));
                  }}
                >
                  打开稿件文件夹
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function revisionLine(s: VideoState): string {
  const r = s.revisions;
  const parts = [
    `转写 ${r.transcript ? "v" + r.transcript : "—"}`,
    `选段 ${r.cut ? "v" + r.cut : "—"}`,
    `成片 ${r.rendered ? "v" + r.rendered : "—"}`,
  ];
  return parts.join(" · ");
}

/** 输入漂移只标注不自动重跑(§2.2)——所以必须让人看见,自己决定要不要重开一版 */
function staleNote(s: VideoState): string | null {
  const notes: string[] = [];
  if (s.stale?.body) notes.push("稿子在这版成片之后改过");
  if (s.stale?.aroll) notes.push("A-roll 素材在这版成片之后动过");
  return notes.length > 0 ? `${notes.join("；")} —— 不会自动重剪,要更新就重开一版。` : null;
}

function attemptNote(status: VideoStatusData | null): string {
  const running = status?.jobs.find((j) => j.status === "running" || j.status === "queued");
  return running && running.attempts > 1 ? ` (第 ${running.attempts} 次尝试)` : "";
}

function BlockedBody(props: {
  state: VideoState;
  busy: boolean;
  asrLabel: string | null;
  warmup: () => void;
  retry: () => void;
}) {
  const guide = videoBlockedGuide(props.state.blockedReason);
  return (
    <div className="vid-blocked">
      <strong>{guide.title}</strong>
      <p>{guide.how}</p>
      {guide.command && (
        <div className="row-actions">
          <code className="vid-cmd mono">{guide.command}</code>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(guide.command as string);
                toast("命令已复制");
              } catch {
                toast("剪贴板写入失败,手动抄一下");
              }
            }}
          >
            复制
          </button>
        </div>
      )}
      <div className="row-actions">
        {guide.action === "asr_warmup" && (
          <button className="primary" disabled={props.busy} onClick={props.warmup}>
            预热语音模型
          </button>
        )}
        <button disabled={props.busy} onClick={props.retry}>
          重试
        </button>
        {props.asrLabel && <span className="mono muted">语音模型:{props.asrLabel}</span>}
      </div>
    </div>
  );
}
