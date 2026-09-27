/** 封面大图：页面内浮层，←/→ 翻所有封面，Esc 或点外面关，浮层里也能「用这一版」 */
import { useEffect } from "react";
import { artifactUrl } from "./board-parts";
import { RATIO_LABEL, versionLabel, viewerStep, type ViewerItem } from "./cover-board";

export function CoverViewer(props: {
  contentId: string; order: ViewerItem[]; item: ViewerItem; confirm: string | null; busy: boolean;
  onMove: (sha: string) => void; onClose: () => void; onConfirm: () => void;
}) {
  const { order, item, onMove, onClose } = props;
  const move = (delta: -1 | 1) => { const next = viewerStep(order, item.artifact.sha256, delta); if (next) onMove(next.artifact.sha256); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { const next = viewerStep(order, item.artifact.sha256, e.key === "ArrowLeft" ? -1 : 1); if (next) onMove(next.artifact.sha256); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, item, onMove, onClose]);
  const i = order.findIndex((x) => x.artifact.sha256 === item.artifact.sha256);
  return <div className="pb-viewer" role="dialog" aria-modal="true" aria-label="封面大图" onClick={onClose}>
    <div className="pb-viewer-body" onClick={(e) => e.stopPropagation()}>
      <img src={artifactUrl(props.contentId, item.artifact)} alt={`${versionLabel(item.version)} ${item.ratio}`} />
      <div className="pb-viewer-bar">
        <button disabled={i <= 0} onClick={() => move(-1)} aria-label="上一张">←</button>
        <span>{versionLabel(item.version)} · {RATIO_LABEL[item.ratio]} · {i + 1}/{order.length}</span>
        <button disabled={i >= order.length - 1} onClick={() => move(1)} aria-label="下一张">→</button>
        {props.confirm && <button className="primary" disabled={props.busy || props.confirm === "已选用"} onClick={props.onConfirm}>{props.confirm}</button>}
        <button className="pb-link" onClick={onClose}>关闭</button>
      </div>
    </div>
  </div>;
}
