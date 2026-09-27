/**
 * 交接—登记两根线的形状（P6 spec §3.4）。
 *
 * Claude 会话 `handoff` 出、Codex 剪辑工位 `register` 回，中间不聊天；两边之间的全部事实
 * 落在 `Content.video` 上。这里只定形状与错误码，判定在 handoff.ts / register.ts。
 */

/** 交接产物清单：`manifest_hash = sha256(JSON.stringify(本对象))`，键序即下面的声明顺序 */
export interface HandoffManifest {
  v2?: {
    version: 2; library_id: string; workspace_id: string; project_id: string; binding_revision: number;
    files: Array<{ path: string; sha256: string }>;
  };
  content_id: string;
  /** 交接代次：从 1 起，每次新交接 +1；撤回过的代次永久失效 */
  generation: number;
  /** 交出去的那一版稿（与 editorial draft_hash 同一算法） */
  draft_hash: string;
  /** A-roll 全文件 sha256：内容变了必须是新代次（codex #7：前 1 MiB 哈希漏改动） */
  aroll_sha256: string;
  project_root: string;
  notes: string;
}

/** 当前交接（`content.video.handoff`）：清单 + 哈希 + 落点，重放直接从这里还原回执 */
export interface VideoHandoffRecord extends HandoffManifest {
  supersedes?: { hash: string; generation: number; reason: "storage-relocation" };
  hash: string;
  at: string;
  /** 交接的宿主（撤回时认领还给它） */
  by: string;
  /** 会话归因（诊断用，不做门禁；P6 §3.8） */
  session?: string;
  /** 交接时稿件的版本号（versions 条数） */
  version: number;
  aroll_path: string;
  /** A-roll 挪进项目之前的原路径（§13.4-F）：撤回时按日志挪回；推送重放在源已挪走时认它 */
  aroll_source_path?: string;
  handoff_path: string;
  project_handoff_path: string;
}

export interface RegisterApproval {
  artifact_sha256: string;
  approved_at: string;
  /** 原话照记，不校验（产品验不了） */
  user_message: string;
}

export interface RegisterApprovals {
  final_cut: RegisterApproval;
  covers: RegisterApproval;
}

/** 一次登记（`content.video.final`；被新登记顶掉的进 `history[]`） */
export interface VideoFinalRecord {
  /** Codex 项目里的成片原路径 */
  path: string;
  /** 登记进稿件素材的那份拷贝（`contents/<id>/assets/<asset_filename>`，ego-lite 读它） */
  asset_filename: string;
  sha256: string;
  duration_ms: number;
  /** Codex 项目里的两张封面原路径 */
  covers: { "3:4": string; "4:3": string };
  /** 封面评审单里指向的拷贝（`contents/<id>/assets/covers/…`） */
  cover_copies: { "3:4": string; "4:3": string };
  srt_path?: string;
  jianying_draft?: string;
  approvals: RegisterApprovals;
  registered_by: string;
  at: string;
  generation: number;
  manifest_hash: string;
  register_hash: string;
  video_ready_at: string | null;
}

/** `Content.video`：交接—登记线在稿件上的全部状态 */
export interface ContentVideoLink {
  handoff?: VideoHandoffRecord;
  /** 撤回过的清单哈希：带它们的 `register` 一律 `stale_handoff` */
  revoked?: string[];
  final?: VideoFinalRecord;
  history?: VideoFinalRecord[];
}

/** 拒绝码（宿主据此决定停下还是改参数重来；人话在 error 里） */
export type HandoffCode =
  | "project_binding_conflict"
  | "not_accepted"
  | "not_handoffable"
  | "aroll_invalid"
  | "roots_unavailable"
  | "path_not_whitelisted"
  | "path_symlink"
  | "path_missing"
  | "project_owned_by_other"
  | "handoff_file_exists"
  | "handoff_too_large"
  | "nothing_to_revoke"
  | "stale_handoff"
  | "not_editing"
  | "invalid_params"
  | "final_invalid"
  | "cover_invalid"
  | "approval_mismatch"
  | "register_failed"
  | "handoff_failed"
  | "missing_decisions"
  | "missing_citations"
  | "handoff_rejected"
  | "handoff_not_committed"
  | "handoff_pending_recovery"
  | "confirmation_required"
  | "confirmation_invalid"
  | "confirmation_used"
  | "aroll_in_use"
  | "project_migration_required";

export type HandoffResult = Record<string, unknown>;

export function handoffFail(code: HandoffCode, error: string, extra: Record<string, unknown> = {}): HandoffResult {
  return { ok: false, code, error, ...extra };
}
