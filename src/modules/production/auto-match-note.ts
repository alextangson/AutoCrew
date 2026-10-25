import type { AutoMatchEvidence } from "../../storage/production-types.js";
import { platformLabel } from "../../desktop/platform-label.js";

/** 卡片 / 收件箱上那句（北京时间）：自动对上：抖音 10-02 18:00，不对就纠正 */
export function autoMatchNote(e: AutoMatchEvidence): string {
  const d = new Date(Date.parse(e.work_published_at) + 8 * 3600_000).toISOString();
  return `自动对上：${platformLabel(e.platform)} ${d.slice(5, 10)} ${d.slice(11, 16)}，不对就纠正`;
}
