/**
 * 成片计划(向导第 2 步,横屏 spec §3.5 + v2 spec §4.2)——剪辑师排的 B-roll,人删、填、确认。
 *
 * 五条纪律:
 * 1. **只删不改**:这一版不做时间轴拖拽。能删掉就够人兜住 AI 的错;摆半成品的拖拽出来
 *    只会让人以为它能用。删光也合法——那就是一条纯口播。
 * 2. **乐观锁**:提交带 plan_revision;`conflict:true` 不是故障,是「后台又跑出一版」。
 *    填槽同理——它派生的是**新一版 plan**,提交时要拿新号。
 * 3. **不静默降级**:warning(没跑成)与 note(合法空)分开显示;被排除的素材必须点名,
 *    否则人只会看到空计划,不知道是自己少写了一行说明。
 * 4. **待生成槽要么填、要么明示跳过**:确认按钮旁必须把「N 个待生成槽未填充」说出来,
 *    悄悄丢掉等于让人以为那几段画面会有。
 * 5. **上传入口直达**:填槽面板里就能把新素材导进素材库,不用先跳去素材库再回来。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import {
  editorPlanSummary,
  formatTimecode,
  videoEditorBackToCut,
  videoEditorConfirm,
  videoEditorPlanGet,
  videoEditorRerun,
  videoEditorSlotFill,
  videoEditorSlotRemove,
  type EditorPlanOverlay,
  type EditorPlanView,
  type VideoReviewDecision,
  type VideoState,
} from "../lib";

/** 素材库那边给的一条记录;这里只用它挑素材,不改它 */
interface LibraryPick {
  id: string;
  name: string;
  type: string;
  description?: string;
  missing?: boolean;
}

export function VideoPlanStep(props: {
  contentId: string;
  state: VideoState;
  /** 门三打回时留下的备注与定位;回到这道门要原样看得见(刷新也不丢) */
  review?: VideoReviewDecision;
  reload: () => Promise<void>;
  back: () => void;
}) {
  const planRev = props.state.revisions.editor ?? 0;
  const waiting = props.state.state !== "awaiting_human";

  const [view, setView] = useState<EditorPlanView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 手里这份是给哪一版拉的。不记这个,新版本刚到、还没拉回来的那一帧会闪出「没找到」 */
  const [loadedRev, setLoadedRev] = useState(-1);
  /** 正在给哪个槽挑素材(null = 没开填槽面板) */
  const [filling, setFilling] = useState<EditorPlanOverlay | null>(null);

  const load = useCallback(async () => {
    const r = await videoEditorPlanGet(props.contentId);
    if (!r.ok) return setErr(r.error ?? "读不到成片计划");
    setErr(null);
    setView(r.data ?? null);
    setLoadedRev(planRev);
    setFilling(null);
  }, [props.contentId, planRev]);

  // 版本变了(重跑过、填过槽、或冲突后被刷新)就整份重拉:删除状态跟着最新那版走
  useEffect(() => {
    void load();
  }, [load]);

  /** 拉回来的就是当前这版才敢往外画:否则画的是上一版的编排 */
  const ready = loadedRev === planRev;

  const plan = view?.plan ?? null;
  const kept = useMemo(() => plan?.overlays ?? [], [plan]);
  /** 留下的待生成槽 = 确认后会被丢掉的那些,必须在按钮旁说出条数 */
  const pending = kept.filter((o) => o.source.kind === "generate");
  /** 打回时点名的那一槽:高亮它,人一眼看见「你说的是这一段」 */
  const flagged = props.review?.locate?.kind === "overlay" ? props.review.locate.overlayId : null;
  /** 选段换过版:这份编排按旧输出域时间排的,确认它等于让 overlay 落在错误的话上 */
  const staleCut = view?.staleCutRevision;

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

  /** 填 / 删共用这一段:两者都派生新一版 plan,冲突与刷新的处理完全一样 */
  const mutate = async (
    run: (planRevision: number) => Promise<{ ok: boolean; conflict?: boolean; error?: string }>,
    done: string,
    failed: string,
  ) => {
    if (!view || busy) return;
    setBusy(true);
    try {
      const r = await run(view.revision);
      if (r.conflict) {
        toast("成片计划已过期,已刷新最新版 —— 请重新来一次");
        await props.reload();
        await load();
        return;
      }
      if (!r.ok) return toast(r.error ?? failed);
      toast(done);
      setFilling(null);
      // 新版本号在状态里,reload 会把它带回来并触发整份重拉
      await props.reload();
    } finally {
      setBusy(false);
    }
  };

  const fill = (libraryId: string) => {
    if (!filling) return;
    const overlayId = filling.overlayId;
    return mutate(
      (planRevision) => videoEditorSlotFill({ contentId: props.contentId, planRevision, overlayId, libraryId }),
      "已填上 —— 这是新一版计划,旧的留档不删",
      "填充素材失败",
    );
  };

  const removeSlot = (overlayId: string) =>
    mutate(
      (planRevision) => videoEditorSlotRemove({ contentId: props.contentId, planRevision, overlayId }),
      "已删掉这一段 —— 派生了新一版计划,旧的留档不删",
      "删除失败",
    );

  const backToCut = () =>
    mutate(
      (planRevision) => videoEditorBackToCut({ contentId: props.contentId, planRevision }),
      "已回到选段 —— 改完再走一遍成片计划",
      "回选段失败",
    );

  const submit = async () => {
    if (!view || busy) return;
    setBusy(true);
    try {
      const r = await videoEditorConfirm({
        contentId: props.contentId,
        planRevision: view.revision,
        keptOverlayIds: kept.map((o) => o.overlayId),
      });
      if (r.conflict) {
        toast("成片计划已过期,已刷新最新版 —— 请重新确认一次");
        await props.reload();
        await load();
        return;
      }
      if (!r.ok) return toast(r.error ?? "确认成片计划失败");
      toast(pending.length > 0 ? `计划已确认 —— 跳过了 ${pending.length} 个未填的待生成槽` : "计划已确认 —— 组装和渲染在后台跑");
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
          留 {kept.length}/{plan?.overlays.length ?? 0} 段 B-roll
        </span>
      </div>

      {err && <p className="ed-error">{err}</p>}
      {waiting && <p className="muted">剪辑师在看素材排 B-roll —— 跑完这一页会自己变。</p>}
      {/* 打回备注落在不可变记录里,所以刷新、换窗口、隔天再来都还在(§2.4) */}
      {props.review?.verdict === "reject" && props.review.target === "edit" && (
        <p className="vid-warn">
          你把成片 v{props.review.renderedRevision} 打回到了这一步
          {props.review.timestampMs !== undefined ? `(${formatTimecode(props.review.timestampMs)} 处)` : ""}
          {props.review.note ? `:${props.review.note}` : "。"}
          {flagged ? ` 指向的是 ${flagged} 这一段。` : ""}
        </p>
      )}
      {ready && staleCut !== undefined && (
        <div className="vid-bad">
          <strong>这份编排是对选段 v{staleCut} 排的,当前选段已经换版了</strong>
          <p>输出域时间全变了,按它出片会让 B-roll 落在错误的话上。重排一版再确认。</p>
          <div className="row-actions">
            <button className="primary" disabled={busy} onClick={() => void rerun()}>
              重新跑剪辑师
            </button>
          </div>
        </div>
      )}
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
              {plan.overlays.map((o) => (
                <OverlayRow
                  key={o.overlayId}
                  overlay={o}
                  flagged={o.overlayId === flagged}
                  busy={busy}
                  onRemove={() => void removeSlot(o.overlayId)}
                  onFill={() => setFilling(o)}
                />
              ))}
            </ul>
          )}

          {filling && (
            <SlotFiller
              slot={filling}
              busy={busy}
              onPick={(id) => void fill(id)}
              onClose={() => setFilling(null)}
            />
          )}

          <div className="row-actions">
            <button className="primary" disabled={busy || staleCut !== undefined} onClick={() => void submit()}>
              {busy ? "提交中…" : kept.length === 0 ? "确认:出纯口播" : `确认 ${kept.length - pending.length} 段,开始组装`}
            </button>
            <button disabled={busy} onClick={() => void rerun()}>
              重新跑剪辑师
            </button>
            {/* 门二退门一(§2.2):在这一页才发现话说错了,不该逼人绕回成片卡去找入口 */}
            <button disabled={busy} onClick={() => void backToCut()}>
              回选段改勾选
            </button>
            <button onClick={props.back}>回成片卡</button>
          </div>
          {pending.length > 0 && (
            <p className="vid-warn">
              还有 {pending.length} 个待生成槽没填素材,确认后会跳过它们(那几段回到出镜画面)。
              想要这几个画面,就按描述做好素材、导进素材库,再回来点「填素材」。
            </p>
          )}
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

/**
 * 一行编排。两类来源长得不一样:已有素材报文件名,待生成槽报「要做成什么」。
 *
 * 「删掉这段」是**服务端的一次真实改动**(派生新一版 plan),不是本地打勾:
 * 刷新、换窗口、隔天回来都还是删过的样子,旧版也留档可查。代价是没有本地撤销——
 * 要找回来就回上一版计划(它一直在盘上)或重跑一次剪辑师。
 */
function OverlayRow(props: {
  overlay: EditorPlanOverlay;
  flagged: boolean;
  busy: boolean;
  onRemove: () => void;
  onFill: () => void;
}) {
  const o = props.overlay;
  const generate = o.source.kind === "generate";
  const trim =
    o.inMs !== undefined && o.outMs !== undefined ? ` · 取材 ${formatTimecode(o.inMs)}–${formatTimecode(o.outMs)}` : "";
  const still = o.source.kind === "generate" ? o.source.mediaKind === "image" : o.source.type === "image";
  return (
    <li className={"vid-seg" + (props.flagged ? " vid-seg-flagged" : "")}>
      <span className="mono muted vid-seg-time">
        {formatTimecode(o.outputStartMs)}–{formatTimecode(o.outputStartMs + o.durationMs)}
      </span>
      <span className="chip">{generate ? "待生成" : still ? "图版" : "屏录"}</span>
      <span className="vid-seg-text">
        {props.flagged ? <strong>你打回时指的就是这一段 · </strong> : null}
        {o.label}
        <span className="mono muted">
          {" "}
          · {(o.durationMs / 1000).toFixed(1)}s{trim}
          {o.source.kind === "asset" ? ` · ${o.source.name}` : ` · 要一段${still ? "静图" : "视频"}`}
        </span>
      </span>
      {generate && <button disabled={props.busy} onClick={props.onFill}>填素材</button>}
      <button disabled={props.busy} onClick={props.onRemove}>删掉这段</button>
    </li>
  );
}

/**
 * 填槽面板:从素材库挑一条,或当场把新文件导进素材库再挑。
 * 只列类型对得上的素材——列一堆填不进去的选项,人只会以为系统坏了。
 */
function SlotFiller(props: {
  slot: EditorPlanOverlay;
  busy: boolean;
  onPick: (libraryId: string) => void;
  onClose: () => void;
}) {
  const want = props.slot.source.kind === "generate" ? props.slot.source.mediaKind : "video";
  const [assets, setAssets] = useState<LibraryPick[] | null>(null);
  const [paths, setPaths] = useState("");

  const load = useCallback(async () => {
    const r = await invoke("library:list");
    if (!r.ok) {
      setAssets([]);
      return toast(r.error ?? "素材库加载失败");
    }
    const list = (r as unknown as { data: { assets?: LibraryPick[] } }).data.assets ?? [];
    setAssets(list.filter((a) => !a.missing && a.type === (want === "image" ? "image" : "video")));
  }, [want]);

  useEffect(() => {
    void load();
  }, [load]);

  const importFiles = async () => {
    const list = paths.split("\n").map((p) => p.trim()).filter(Boolean);
    if (list.length === 0) return toast("先粘贴至少一个绝对路径(每行一个)");
    const r = await invoke("library:add", { paths: list });
    if (!r.ok) return toast(r.error ?? "导入失败");
    setPaths("");
    toast("已导入素材库 —— 在下面挑它");
    await load();
  };

  return (
    <div className="vid-sub" style={{ marginTop: 8 }}>
      <div className="vid-sub-bar">
        <span className="mono muted">
          给 {props.slot.overlayId} 填{want === "image" ? "静图" : "视频"}
          （需要 ≥{(props.slot.durationMs / 1000).toFixed(1)}s）
        </span>
        <button onClick={props.onClose}>收起</button>
      </div>
      <p className="muted">要做成什么:{props.slot.label}</p>
      <div className="row-actions vid-seg-tools">
        <textarea
          rows={2}
          placeholder="做好素材后,把绝对路径贴这里(每行一个)导进素材库"
          value={paths}
          onChange={(e) => setPaths(e.target.value)}
        />
        <button disabled={props.busy} onClick={() => void importFiles()}>
          导入素材库
        </button>
      </div>
      {assets === null && <p className="muted">读取素材库中…</p>}
      {assets?.length === 0 && (
        <p className="muted">素材库里还没有能用的{want === "image" ? "图片" : "视频"} —— 先按上面的描述做一个,导进来再填。</p>
      )}
      <ul className="vid-segs">
        {(assets ?? []).map((a) => (
          <li key={a.id} className="vid-seg">
            <span className="vid-seg-text">
              {a.name}
              {a.description ? <span className="mono muted"> · {a.description}</span> : null}
            </span>
            <button className="primary" disabled={props.busy} onClick={() => props.onPick(a.id)}>
              用它
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
