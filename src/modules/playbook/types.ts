/**
 * 体裁手册（docs/2026-10-13-genre-playbooks-spec.md）共用的形状。
 * 存储：<dataDir>/playbooks/manifest.json（唯一提交点）+ <id>/v<N>.md（每版全文，只写一次）。
 */

export const PLAYBOOK_IDS = ["ganhuo", "shiyan", "fanchangshi", "xinxicha", "renwu"] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];
export const isPlaybookId = (v: unknown): v is PlaybookId => typeof v === "string" && (PLAYBOOK_IDS as readonly string[]).includes(v);

/** 每本上限（字，按 Unicode 字符数）；超过的提案直接拒 */
export const PLAYBOOK_MAX_CHARS = 4000;

/** 立意 / 意见 / 定稿上记的手册版本 */
export interface PlaybookPin { id: PlaybookId; version: number }

export interface PlaybookVersion {
  version: number;
  at: string;
  author: "founder" | "agent";
  kind: "seed" | "edit" | "rollback";
  founder_words?: string;
  reason?: string;
  based_on?: number;
  rolled_back_to?: number;
  proposal_id?: string;
}

export type ProposalStatus = "pending" | "approved" | "rejected" | "stale";

export interface PlaybookProposal {
  id: string;
  /** lesson = 写稿意见自动挂的补充；revision = agent 交的整本修订 */
  kind: "lesson" | "revision";
  based_on: number;
  /** 批准后成为新版本的全文 */
  text: string;
  /** lesson：意见原文（去重 / 墓碑按它比） */
  lesson?: string;
  founder_words: string;
  /** founder_words 只是选项代号（「A」「2」）时：那个选项的全文 */
  chosen_option?: string;
  reason: string;
  /** hash(id, based_on, text)：「等你拍板」的代次 */
  gen: string;
  status: ProposalStatus;
  at: string;
  decided_at?: string;
  /** 从哪篇稿的哪一版意见来 */
  origin?: { content_id: string; version: number };
  /** 之后又有别的稿提了同一条（duplicate）：也算来源 */
  origins?: Array<{ content_id: string; version: number }>;
}

export interface PlaybookEntry {
  id: PlaybookId;
  name: string;
  current: number;
  versions: PlaybookVersion[];
  proposals: PlaybookProposal[];
}

/** 决定日志：eventId 幂等（chat-<request_id> / 工作台 eventId / 回滚 rollback-<request_id>） */
export interface PlaybookEvent {
  eventId: string;
  type: "approve" | "reject" | "rollback";
  playbook: PlaybookId;
  /** 同一 eventId 重放时比对内容 */
  fp: string;
  proposal_id?: string;
  /** 合并批（spec 2026-10-15 §A4）：这一次一起定的几份提案 */
  proposal_ids?: string[];
  to_version?: number;
  expected_current_version?: number;
  /** 这次决定产生的版本（approve / rollback） */
  version?: number;
  source: "chat" | "workbench" | "tool";
  founder_words?: string;
  requested_by?: string;
  at: string;
}

export interface PlaybookManifest {
  schema: 1;
  playbooks: PlaybookEntry[];
  events: PlaybookEvent[];
}

export class PlaybookError extends Error {
  constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}
