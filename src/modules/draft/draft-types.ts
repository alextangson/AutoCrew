/**
 * 灵感 → 拍 A-roll 的薄路径（docs/2026-10-04-idea-to-aroll-replan.md）共用的形状。
 * 一个会话、一个 agent 写完一篇抖音口播；AutoCrew 只存东西、给数据、核事实。
 */

/** 创始人选定的立意（第 3 步）。主线另记进选题的 founderAngle，存盘入口守卫认的是那一条 */
export interface DraftAngle {
  version: number;
  main_line: string;
  for_whom: string;
  opening: string;
  why_viral: string;
  chain: string[];
  founder_words: string;
  at: string;
}

/** 稿件上的薄路径标记：有它 = 这篇走 autocrew_draft，工作台据此显示定稿清单 */
export interface DraftPathRecord {
  kind: "thin";
  startedAt: string;
  angle?: DraftAngle;
  /** 第一版存下时已自动排过一次 Codex 审稿（之后只在 rerun 时再审） */
  autoReviewQueued?: boolean;
}

/** 创始人在工作台点「定了」的记录：绑定当时的稿件指纹，正文一改即失效 */
export interface DraftFinalRecord {
  draftHash: string;
  finalizedAt: string;
  source: "founder-workbench";
  kept: string[];
}

export const DRAFT_PLATFORM = "douyin";

/** 能在这条路径上写的状态（写稿段）；approved 及以后要先由创始人在看板拉回 */
export const DRAFT_WRITABLE: ReadonlySet<string> = new Set(["topic_saved", "drafting", "revision", "needs_evidence", "draft_ready", "reviewing"]);

export function workbenchUrl(contentId: string): string {
  return `http://127.0.0.1:${Number(process.env.AUTOCREW_PORT) || 4317}/#/editor/${encodeURIComponent(contentId)}`;
}
