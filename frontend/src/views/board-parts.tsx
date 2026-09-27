/** 看板各步共用的小件：产物地址（哈希校验）与门状态徽标 */
import { clockLabel } from "../time-format";
import { GATE_STATUS_LABEL, type GateView } from "./project-board";

/** 本地时区的「今天 17:50」 */
export const when = (iso?: string | null) => clockLabel(iso);

export function artifactUrl(contentId: string, a: { path: string; sha256: string }) {
  return `/api/project-artifact?content_id=${encodeURIComponent(contentId)}&path=${encodeURIComponent(a.path)}&sha256=${a.sha256}`;
}

export function GateBadge({ view }: { view?: GateView }) {
  if (!view) return <span className="muted">—</span>;
  const extra = view.status === "approved" ? ` · ${when(view.approval?.approved_at)}` : view.status === "rejected" ? ` · 「${view.rejection?.note}」` : view.reason ? ` · ${view.reason}` : "";
  return <span>{GATE_STATUS_LABEL[view.status]}{extra}</span>;
}
