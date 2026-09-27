/**
 * 视频稿封面步的纯逻辑（P6 §13.4-G）：只有 3:4、4:3 两种尺寸，各版本都来自产物索引，
 * 新版在前、旧版一直保留；每个尺寸选一张才能「通过封面」。
 */
import type { Artifact, ProjectReview } from "./project-board";

export const COVER_RATIOS = ["3:4", "4:3"] as const;
export type CoverRatio = (typeof COVER_RATIOS)[number];

/** 封面按尺寸分组，新版本在前 */
export function coverGroups(artifacts: readonly Artifact[]): Record<CoverRatio, Artifact[]> {
  const byNewest = (a: Artifact, b: Artifact) => (b.version ?? 0) - (a.version ?? 0) || b.reported_at.localeCompare(a.reported_at);
  return {
    "3:4": artifacts.filter((a) => a.role === "cover:3:4").sort(byNewest),
    "4:3": artifacts.filter((a) => a.role === "cover:4:3").sort(byNewest),
  };
}

/** 当前选中的那一张（选的版本已不在索引里就当没选） */
export function selectedCover(groups: Record<CoverRatio, Artifact[]>, selection: ProjectReview["cover_selection"], ratio: CoverRatio): Artifact | null {
  const sha = selection?.[ratio]?.sha256;
  return groups[ratio].find((a) => a.sha256 === sha) ?? null;
}

/** 「通过封面」置灰原因；null = 可点 */
export function coverApproveBlock(groups: Record<CoverRatio, Artifact[]>, selection: ProjectReview["cover_selection"]): string | null {
  const missing = COVER_RATIOS.filter((r) => groups[r].length === 0);
  if (missing.length) return `还缺 ${missing.join("、")} 封面，等剪辑交上来`;
  const unpicked = COVER_RATIOS.filter((r) => !selectedCover(groups, selection, r));
  if (unpicked.length) return `先在 ${unpicked.join("、")} 里各选一张`;
  return null;
}
