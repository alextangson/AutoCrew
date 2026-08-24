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
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { VARIANT_STATUS, type AllowedTransition } from "../lib";
import { defaultAdvanceTarget } from "./stage-default";

export function StageAdvance(props: {
  contentId: string;
  currentStatus: string;
  transitions: AllowedTransition[];
  /** 有未保存改动时不许推进——先落库再换阶段,否则改的字会留在上一个阶段的界面里 */
  dirty?: boolean;
  reload: () => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  if (props.transitions.length === 0) return null;

  // 默认指向管线前进方向——表序第一位在「待审」恰好是「修订」,推进按钮默认后退是真机踩过的陷阱
  const fallback = defaultAdvanceTarget(props.currentStatus, props.transitions);
  const chosen =
    props.transitions.find((t) => t.status === target) ??
    props.transitions.find((t) => t.status === fallback) ??
    props.transitions[0];
  const blocked = chosen.blockedReason;

  const advance = async () => {
    if (busy) return;
    if (props.dirty) return toast("有未保存的改动——先保存或撤销再推进");
    if (blocked) return toast(blocked);
    setBusy(true);
    try {
      const r = await invoke("content:transition", {
        id: props.contentId,
        target_status: chosen.status,
        from_status: props.currentStatus,
      });
      if (!r.ok) return toast(r.error ?? "推进失败");
      toast("已推进到「" + (VARIANT_STATUS[chosen.status] ?? chosen.status) + "」");
      await props.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <select value={chosen.status} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
        {props.transitions.map((t) => (
          <option key={t.status} value={t.status} disabled={Boolean(t.blockedReason)}>
            {(VARIANT_STATUS[t.status] ?? t.status) + (t.blockedReason ? "（还不行）" : "")}
          </option>
        ))}
      </select>
      <button disabled={busy || Boolean(blocked)} title={blocked ?? ""} onClick={() => void advance()}>
        {busy ? "推进中…" : "推进 →"}
      </button>
      {blocked && <span className="mono muted">{blocked}</span>}
    </>
  );
}
