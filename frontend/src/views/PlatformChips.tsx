/** 一条视频的平台标签（看板卡、稿件页顶部共用）：每个目标平台一个，状态取服务端推导；可选地挂按平台动作 */
import { ACTION_LABEL, chipText, chipTone, type PublishTarget, type TargetAction } from "./publish-targets";

export function PlatformChips(p: { targets: PublishTarget[]; busy?: boolean; onAction?: (t: PublishTarget, a: TargetAction) => void; label?: string }) {
  if (!p.targets.length) return null;
  return <div className="pchips" aria-label={p.label ?? "各平台状态"}>
    {p.targets.map((t) => <span key={t.platform} className={`pchip pchip-${chipTone(t.state)}`} title={chipText(t)}>
      <span className="pchip-text">{chipText(t)}</span>
      {p.onAction && t.actions.filter((a) => a !== "correct_publish").map((a) =>
        <button key={a} className="pchip-act" disabled={p.busy} onClick={() => p.onAction!(t, a)}>{ACTION_LABEL[a]}</button>)}
    </span>)}
  </div>;
}
