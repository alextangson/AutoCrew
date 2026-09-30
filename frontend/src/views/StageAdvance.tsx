/**
 * 顶栏推进控件（阶段制 spec §2）——四张工作台共用一个，阶段由它驱动。
 *
 * 三条纪律：
 * 1. **灰显要说得出原因**：阶段门的判定由后端随 `content:allowed_transitions` 一起下发，
 *    界面不自己推演规则；被拦的那一项在下拉里灰掉，原因摆在旁边——不是点了才报错。
 * 2. **双击无副作用**：请求在飞时按钮禁用；真发出去两次，第二次带的 `from_status`
 *    已经不是盘上的状态，后端人话拒绝，不会盖掉任何东西。
 * 3. **旧标签页不覆盖**：`from_status` 是这一屏看到的状态。别处（另一个标签页、
 *    对话工具）先改了，这里推进会被拒并提示刷新，而不是硬推过去。
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "../transport";
import { toast, confirmDialog } from "../ui";
import { VARIANT_STATUS, type AllowedTransition } from "../lib";
import { defaultAdvanceTarget } from "./stage-default";

const ACTION_LABELS: Record<string, string> = {
  topic_saved: "回到选题",
  drafting: "开始写作",
  needs_evidence: "补充证据",
  draft_ready: "回到文案",
  reviewing: "让 AI 再审一遍",
  revision: "返回修订",
  approved: "进入制作",
  cover_pending: "去封面",
  publish_ready: "准备发布",
  publishing: "标记发布中",
  published: "标记已发布",
  archived: "归档稿件",
};

function actionFor(status: string, currentStatus: string, isVideo = false): string {
  if (status === "draft_ready" && ["topic_saved", "drafting", "needs_evidence"].includes(currentStatus)) return "完成初稿";
  // 1b 验收：认稿就是「稿子没问题」——视频稿随后进制作
  if (status === "approved") return isVideo ? "稿子没问题，进入制作" : "稿子没问题";
  return ACTION_LABELS[status] ?? (VARIANT_STATUS[status] ?? status);
}

export function StageAdvance(props: {
  contentId: string;
  currentStatus: string;
  transitions: AllowedTransition[];
  /** 有未保存改动时不许推进——先落库再换阶段,否则改的字会留在上一个阶段的界面里 */
  dirty?: boolean;
  reload: () => Promise<void>;
  /** 视频稿：认稿后进制作，成功后说清进了哪一列 */
  isVideo?: boolean;
  /** 进制作之后去哪一列（待录制 / 剪辑中）：由调用方按卡片面板数据给出 */
  landedStage?: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  // 「剪辑中」只能由交接进入（P6 §13.4-C）：推进下拉不给这一站，后端同样拒绝手动切换
  const transitions = props.transitions.filter((t) => t.status !== "editing");
  if (transitions.length === 0) return null;

  // 默认指向管线前进方向——表序第一位在「待审」恰好是「修订」,推进按钮默认后退是真机踩过的陷阱。
  // 写好 / 审过的稿默认就是「稿子没问题」（1b 验收：创始人选了「进入审核」以为进了制作，其实只到待审）
  const approve = ["draft_ready", "reviewing"].includes(props.currentStatus) ? transitions.find((t) => t.status === "approved" && !t.blockedReason) : undefined;
  const fallback = approve?.status ?? defaultAdvanceTarget(props.currentStatus, transitions);
  const chosen = transitions.find((t) => t.status === fallback) ?? transitions[0];
  const blocked = chosen.blockedReason;
  const actionLabel = actionFor(chosen.status, props.currentStatus, props.isVideo);
  const disabledReason = props.dirty ? "先保存修改，再进入下一阶段" : blocked;

  /** 一步执行（1b 验收）：点哪一项就做哪一项；只有发布中 / 已发布 / 归档要确认 */
  const advance = async (to: AllowedTransition = chosen) => {
    const label = actionFor(to.status, props.currentStatus, props.isVideo);
    if (busyRef.current) return;
    if (props.dirty) return toast("先保存修改，再进入下一阶段");
    if (to.blockedReason) return toast(to.blockedReason);
    busyRef.current = true;
    setBusy(true);
    setOpen(false);
    try {
      if (["publishing", "published", "archived"].includes(to.status)) {
        const yes = await confirmDialog({
          title: `${label}？`,
          body: to.status === "published"
            ? "请确认这篇稿件已经在平台发布。此操作只记录发布状态。"
            : to.status === "archived"
              ? "归档后这篇稿件会离开当前管线，内容与版本记录会保留。"
              : "将稿件标记为发布中。平台发布仍需在发布工作台继续操作。",
          confirmLabel: label,
          danger: to.status === "archived",
        });
        if (!yes) return;
      }
      const r = await invoke("content:transition", {
        id: props.contentId,
        target_status: to.status,
        from_status: props.currentStatus,
      });
      if (!r.ok) return toast(r.error ?? "阶段切换失败");
      await props.reload();
      // 进了制作就说清在哪一列，看板上那张卡就在那里
      const landed = to.status === "approved" && props.isVideo && props.landedStage ? await props.landedStage() : null;
      toast(landed ? `已进${landed}（看板上能看到这张卡）` : "已进入「" + (VARIANT_STATUS[to.status] ?? to.status) + "」");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="ed-stage-action" ref={rootRef}>
      <div className="ed-stage-action-buttons" title={disabledReason ?? ""}>
        <button className="ed-next-action-button" disabled={busy || !!disabledReason} onClick={() => void advance(chosen)}>
          {busy ? "处理中…" : actionLabel}
        </button>
        <button
          className="ed-stage-menu-button"
          ref={menuButtonRef}
          aria-label="选择下一阶段动作"
          aria-expanded={open}
          aria-controls={`stage-actions-${props.contentId}`}
          disabled={busy}
          onClick={() => setOpen((value) => !value)}
        >⌄</button>
      </div>
      {open && <div className="ed-stage-menu" id={`stage-actions-${props.contentId}`}>
        <div className="ed-stage-menu-heading">选择下一步</div>
        {transitions.map((transition) => <button
          key={transition.status}
          className={transition.status === chosen.status ? "is-selected" : ""}
          disabled={!!transition.blockedReason}
          aria-pressed={transition.status === chosen.status}
          onClick={() => void advance(transition)}
        >
          <span>{actionFor(transition.status, props.currentStatus, props.isVideo)}</span>
          {transition.status === chosen.status && <span aria-hidden="true">✓</span>}
          {transition.blockedReason && <small>{transition.blockedReason}</small>}
        </button>)}
        <p>{props.dirty ? "保存修改后，才能执行下一步。" : "点一下就执行。"}</p>
      </div>}
    </div>
  );
}
