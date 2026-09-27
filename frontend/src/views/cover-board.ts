/**
 * 视频稿封面步的纯逻辑（P6 §13.4-G）：Codex 按版本文件夹（v001、v002…）交一对封面（3:4 + 4:3），
 * 页面一版一张卡，新版在前、旧版一直保留；「用这一版」直接把这一对送去批准。
 */
import type { Artifact, GateView, ProjectReview } from "./project-board";

export const COVER_RATIOS = ["3:4", "4:3"] as const;
export type CoverRatio = (typeof COVER_RATIOS)[number];
export const RATIO_LABEL: Record<CoverRatio, string> = { "3:4": "3:4 竖版", "4:3": "4:3 横版" };

export type CoverVersion = { version: number; at: string; pair: Partial<Record<CoverRatio, Artifact>>; missing: CoverRatio[] };
export type ViewerItem = { version: number; ratio: CoverRatio; artifact: Artifact };

const ratioOf = (a: Artifact): CoverRatio | null => (a.role === "cover:3:4" ? "3:4" : a.role === "cover:4:3" ? "4:3" : null);

/** 封面按版本成对，新版在前；同版同尺寸有多张时取最后交的那张 */
export function coverVersions(artifacts: readonly Artifact[]): CoverVersion[] {
  const byVersion = new Map<number, CoverVersion>();
  for (const a of artifacts) {
    const ratio = ratioOf(a);
    if (!ratio) continue;
    const version = a.version ?? 0;
    const v = byVersion.get(version) ?? { version, at: a.reported_at, pair: {}, missing: [] };
    const prev = v.pair[ratio];
    if (!prev || a.reported_at >= prev.reported_at) v.pair[ratio] = a;
    if (a.reported_at > v.at) v.at = a.reported_at;
    byVersion.set(version, v);
  }
  return [...byVersion.values()]
    .map((v) => ({ ...v, missing: COVER_RATIOS.filter((r) => !v.pair[r]) }))
    .sort((a, b) => b.version - a.version || b.at.localeCompare(a.at));
}

export const versionLabel = (version: number) => (version ? `v${String(version).padStart(2, "0")}` : "未标版本");

/** 缺尺寸的那一版怎么说；不缺返回 null */
export function missingNote(v: CoverVersion): string | null {
  if (v.missing.length === 0) return null;
  return v.missing.length === 2 ? "这一版还没有图" : `这一版缺 ${v.missing[0]}，让 Codex 补一张`;
}

/** 已批准的是哪一版：封面门已批准，且选择里两张都正好是这一版的那一对 */
export function approvedVersion(versions: readonly CoverVersion[], selection: ProjectReview["cover_selection"], gate?: GateView): number | null {
  if (gate?.status !== "approved" || !selection) return null;
  const hit = versions.find((v) => COVER_RATIOS.every((r) => v.pair[r] && v.pair[r]!.sha256 === selection[r]?.sha256));
  return hit ? hit.version : null;
}

/** 一版的确认按钮文案；null = 不给按钮（缺尺寸） */
export function confirmLabel(v: CoverVersion, approved: number | null): string | null {
  if (v.missing.length) return null;
  if (approved === v.version) return "已选用";
  return approved === null ? "用这一版" : "改用这一版";
}

/** 批准请求要带的两张（顺序固定 3:4、4:3，服务端据此重算指纹） */
export function approveFiles(v: CoverVersion): Array<{ path: string; sha256: string }> {
  return COVER_RATIOS.map((r) => ({ path: v.pair[r]!.path, sha256: v.pair[r]!.sha256 }));
}

/** 大图浏览顺序：版本从新到旧，每版先 3:4 再 4:3 */
export function viewerOrder(versions: readonly CoverVersion[]): ViewerItem[] {
  return versions.flatMap((v) => COVER_RATIOS.flatMap((ratio) => (v.pair[ratio] ? [{ version: v.version, ratio, artifact: v.pair[ratio]! }] : [])));
}

/** 从当前这张往前/往后走一步，到头停住；当前这张已不在（刷新后被换掉）返回 null */
export function viewerStep(order: readonly ViewerItem[], sha: string, delta: -1 | 1): ViewerItem | null {
  const i = order.findIndex((x) => x.artifact.sha256 === sha);
  if (i < 0) return null;
  return order[Math.min(order.length - 1, Math.max(0, i + delta))];
}
