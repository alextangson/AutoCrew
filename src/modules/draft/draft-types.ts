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

export interface DraftReviewNote { version: number; notes: string | Record<string, unknown> | unknown[]; at: string }

/** 稿件上的薄路径标记：有它 = 这篇走 autocrew_draft，工作台据此显示定稿清单 */
export interface DraftPathRecord {
  kind: "thin";
  startedAt: string;
  /** start 时创始人的灵感原话：存在稿上，不改共享选题；接手时仍算一手材料 */
  inspiration?: string;
  angle?: DraftAngle;
  /** agent 自己跑的 Codex 审稿意见（或调不通的原因），按版本号附在稿旁；只是参考 */
  reviewNotes?: DraftReviewNote[];
  /** 最近一次 prepare_final 出清单的时间：稿件随之更新，工作台面板据此重读清单 */
  checklistAt?: string;
}

/** 创始人在工作台点「定了」的记录：绑定当时的稿件指纹，正文一改即失效 */
export interface DraftFinalRecord {
  draftHash: string;
  finalizedAt: string;
  source: "founder-workbench";
  kept: string[];
}

export const DRAFT_PLATFORM = "douyin";

/** 版本号 = 已存版本数；乐观并发用它比对 base_version */
export function currentVersion(c: { versions?: unknown[] }): number { return c.versions?.length ?? 0; }

export function workbenchUrl(contentId: string): string {
  return `http://127.0.0.1:${Number(process.env.AUTOCREW_PORT) || 4317}/#/editor/${encodeURIComponent(contentId)}`;
}

export interface DraftState { id: string; status: string; needsAngle: boolean; hasBody: boolean; reviewed: boolean; checklistCurrent: boolean }

/**
 * 回执里的 next_action 随稿件状态走（验收 10-04：附完审稿还在提示去审）。
 * reviewed = 这篇已附过 Codex 审稿（任一版）：技能规定只审第一版，之后按创始人意见改不再重审。
 */
export function draftNextNote(s: DraftState): string {
  if (s.status === "draft_ready" && !s.checklistCurrent) return "稿在「等你认稿」但出处清单缺失或已过期（正文改过）：调 prepare_final 重新出清单";
  if (s.status === "draft_ready") return `稿在「等你认稿」：把工作台链接 ${workbenchUrl(s.id)} 给创始人，请他看清单后点「定了」`;
  if (s.needsAngle) return "按 write-script 技能走：衍生 → 调研（verify_quote）→ 立意（angle）→ 写（save）";
  if (!s.hasBody) return "按选定的立意和论证链写全文，再 save";
  if (!s.reviewed) return "这篇还没附 Codex 审稿：跑一次 Codex 审稿，用 save{同一版正文, review_notes} 附上";
  return "按创始人意见改、只改他说的地方；他说「定了」就调 prepare_final";
}
