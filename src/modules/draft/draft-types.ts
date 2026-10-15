/**
 * 灵感 → 拍 A-roll 的薄路径（docs/2026-10-04-idea-to-aroll-replan.md）共用的形状。
 * 一个会话、一个 agent 写完一篇抖音口播；AutoCrew 只存东西、给数据、核事实。
 */
import { createHash } from "node:crypto";
import type { DraftFeedbackRecord } from "./draft-feedback.js";
import type { PlaybookPin } from "../playbook/types.js";
import type { ExemplarPin, MethodPin } from "../exemplar/types.js";

/** 先磨开头（spec 2026-10-15 §7、§15.13）：每一轮 3 个候选；创始人选中（或改一句）才写全文 */
export interface OpeningPick {
  round: number;
  candidates: string[];
  /** 这一轮创始人的原话（不满意的话也记） */
  founder_words?: string;
  /** 选中的开头全文；没有 = 还在等他选 */
  chosen?: string;
  /** 连着两轮都没选中（回过 back_to_angle）：该回立意重选，不再出候选 */
  exhausted?: boolean;
  at: string;
}

/** 观众试读（§7、§15.11、§15.12）：记在它读的那一版上，body_hash 对得上才算这一版的 */
export interface TestReadRecord {
  kind: "viewer_test_read";
  version: number;
  status: "ok" | "failed" | "unsupported";
  body_hash: string;
  notes: string;
  at: string;
}

/** 创始人选定的立意（第 3 步）。主线另记进选题的 founderAngle，存盘入口守卫认的是那一条 */
export interface DraftAngle {
  version: number;
  main_line: string;
  for_whom: string;
  opening: string;
  why_viral: string;
  chain: string[];
  founder_words: string;
  /** 创始人选中的选项当时展示的全文（他只回「B」也看得懂） */
  chosen_option?: string;
  /** 选卡即选体裁：立意时记下的手册与版本（spec 2026-10-13 §2）。没有 = 未归版本的旧立意 */
  playbook?: PlaybookPin;
  /** 立意卡上实际引用的范文（spec 2026-10-15 §15.9）；没有这个字段 = 范文库上线前的旧立意，照旧方式续写 */
  exemplars?: ExemplarPin[];
  /** 范文锁定的时间（换体裁重新选时更新；30 天用量按它算） */
  exemplars_at?: string;
  /** 开写时的「写法」版本（§15.5） */
  method?: MethodPin;
  /** 先磨开头的进度；新流程的立意（有 method）没选开头前不收第一版全文 */
  opening_pick?: OpeningPick;
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
  /** 观众试读记录（按版本） */
  testReads?: TestReadRecord[];
  /** 对话里的改稿意见（save 带 feedback）：每版的创始人原话与概括出的规则去向 */
  feedback?: DraftFeedbackRecord[];
  /** 最近一次 prepare_final 出清单的时间：稿件随之更新，工作台面板据此重读清单 */
  checklistAt?: string;
}

/** 创始人在工作台点「定了」的记录：绑定当时的稿件指纹，正文一改即失效 */
export interface DraftFinalRecord {
  draftHash: string;
  finalizedAt: string;
  source: "founder-workbench";
  kept: string[];
  /** 定稿时立意记的手册版本：统计按它归属（spec 2026-10-13 §9.4） */
  playbook?: PlaybookPin;
}

export const DRAFT_PLATFORM = "douyin";

/** 版本号 = 已存版本数；乐观并发用它比对 base_version */
export function currentVersion(c: { versions?: unknown[] }): number { return c.versions?.length ?? 0; }

export function workbenchUrl(contentId: string): string {
  return `http://127.0.0.1:${Number(process.env.AUTOCREW_PORT) || 4317}/#/editor/${encodeURIComponent(contentId)}`;
}

export interface DraftState {
  id: string; status: string; needsAngle: boolean; hasBody: boolean;
  /** 新流程立意、还没选定开头 */
  needsOpening?: boolean;
  /** 这一轮候选已记下、等创始人选 / 两轮都没中该回立意 */
  opening?: "waiting" | "exhausted";
  /** 这篇已附过观众试读（任何状态）或旧的 Codex 审稿：之后按创始人意见改不再催 */
  reviewed: boolean;
  checklistCurrent: boolean;
}

/**
 * 回执里的 next_action 随稿件状态走（验收 10-04：附完审稿还在提示去审）。
 * 试读失败 / 不支持也算「附过了」（如实附上原因，不反复催），但不算「已审」——统计和工作台另按 status 区分。
 */
export function draftNextNote(s: DraftState): string {
  if (s.status === "draft_ready" && !s.checklistCurrent) return "稿在「等你认稿」但出处清单缺失或已过期（正文改过）：调 prepare_final 重新出清单";
  if (s.status === "draft_ready") return `稿在「等你认稿」：把工作台链接 ${workbenchUrl(s.id)} 给创始人，请他看清单后点「定了」`;
  if (s.needsAngle) return "按 write-script 技能走：衍生 → 调研（verify_quote）→ 立意（exemplars 预览范文 → angle）→ 先磨开头（opening）→ 写（save）";
  if (!s.hasBody && s.needsOpening && s.opening === "exhausted") return "连着两轮开头都没选中：回到立意重选（第 3 步重出立意卡，创始人选了再 angle），不要再出开头候选";
  if (!s.hasBody && s.needsOpening && s.opening === "waiting") return "这一轮候选开头已经记下（progress.opening_pick.candidates）：原样编号列给创始人，等他选；他选了（或改了一句）用 opening{opening, founder_words} 记，不要重出候选";
  if (!s.hasBody && s.needsOpening) return "等创始人选开头：给 3 个不同写法的前 15 秒，用 opening{candidates} 记下；他选了（或改了一句）用 opening{opening, founder_words} 记，之后才写全文";
  if (!s.hasBody) return "按选定的立意、开头和论证链写全文，再 save";
  if (!s.reviewed) return "这篇还没附观众试读：按技能第 5 步起一个只拿正文的小林试读，用 save{同一版正文, test_read} 附上（失败 / 不支持也如实附上）";
  return "按创始人意见改、只改他说的地方；他说「定了」就调 prepare_final";
}

/** 新流程的立意（锁了写法版本）还没选定开头：第一版全文先不收。旧立意（没有 method）不受这条管 */
export function openingState(angle: DraftAngle | undefined): "waiting" | "exhausted" | undefined {
  const p = angle?.opening_pick;
  if (!p || p.chosen) return undefined;
  return p.exhausted ? "exhausted" : "waiting";
}

export function needsOpening(angle: DraftAngle | undefined): boolean {
  return Boolean(angle?.method) && !angle?.opening_pick?.chosen;
}

/** 观众试读绑定的正文指纹 */
export const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);
