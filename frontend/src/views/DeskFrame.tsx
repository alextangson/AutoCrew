/**
 * 视频稿稿件页的外框：一个发布台读模型（DeskProvider）+ 本体启用时左侧进度栏（吸收 12）。
 * 发布阶段的整页由 VideoPublishSlot 决定：本体启用 → 发布台；影子 / 被排除 → 原来的发布工作台（吸收 7）。
 */
import type { ReactNode } from "react";
import type { VersionLike } from "../version-diff";
import { DeskProvider, useDesk } from "./use-desk";
import { ProgressRail } from "./ProgressRail";
import { DeskSkeleton } from "./PublishDesk";

export function DeskFrame(p: { contentId: string; refreshKey: string; isVideo: boolean; versions: VersionLike[]; children: ReactNode }) {
  if (!p.isVideo) return <>{p.children}</>;
  return <DeskProvider contentId={p.contentId} refreshKey={p.refreshKey}><Shell versions={p.versions}>{p.children}</Shell></DeskProvider>;
}

function Shell(p: { versions: VersionLike[]; children: ReactNode }) {
  const ctx = useDesk();
  const active = Boolean(ctx?.data?.active);
  const versions = p.versions.length ? <p className="muted">版本记录 · {p.versions.length} 版</p> : null;
  // 结构固定（进度栏位置留空也占着下标）：读模型到了不让正文编辑器被重挂
  return <div className={`desk-shell${active ? "" : " is-off"}`}>{active && <ProgressRail versions={versions} />}<div className="desk-main">{p.children}</div></div>;
}

/** 发布阶段：读模型到了再决定用哪张台子；读取中骨架，失败一行原因 + 重试 */
export function VideoPublishSlot(p: { desk: ReactNode; fallback: ReactNode }) {
  const ctx = useDesk();
  if (!ctx?.data) return <DeskSkeleton error={ctx?.error ?? null} retry={() => void ctx?.refresh()} />;
  return <>{ctx.data.active ? p.desk : p.fallback}</>;
}
