/**
 * 内容本体（spec 2026-09-29-content-ontology §2）的落盘形状：一条内容 = 事实 + 决定 + 登记记录。
 * 制作段阶段是它们的纯函数（`modules/production/derive.ts`）；`status` 只是投影缓存。
 *
 * 放在 storage 层：正文写口的冻结检查、认稿决定都要在稿件写锁里读写这份文件，
 * 而 storage 不能在运行时反向依赖 modules。
 */

export type FactKind = "aroll" | "cut" | "srt" | "cover" | "publish" | "chatcut_project";
/** 制作事实：本轮有一条 accepted 就进剪辑中（D4） */
export const PRODUCTION_KINDS: ReadonlySet<FactKind> = new Set(["aroll", "cut", "srt", "cover", "chatcut_project"]);

export type FactState = "accepted" | "candidate" | "pending_match" | "rejected";
/** 业务状态与文件可用性分开（Codex P1-9）：可用性只影响发布资格和告警 */
export type Availability = "present" | "missing" | "unreadable" | "archived";
export type FactSource = "record" | "reconcile" | "founder" | "legacy";
export type CoverRatio = "3:4" | "4:3";

export interface Fact {
  id: string;
  kind: FactKind;
  round: number;
  state: FactState;
  availability: Availability;
  source: FactSource;
  by?: { host: string; session?: string };
  at: string;
  request_id?: string;
  /** 人话依据：「文件名前缀对上标题」「05-cover/v002 里的图」 */
  evidence?: string;
  post_publish?: true;
  /** 落位它的事务：恢复只按它判「已提交」 */
  txn_id?: string;
  /** 文件类：项目内存相对路径；候选 / 被 ChatCut 引用留原位的存绝对路径 */
  path?: string;
  sha256?: string;
  size?: number;
  mtime_ms?: number;
  duration_ms?: number;
  /** 同一路径的字节被外部覆盖：记录的 sha 已被替换，绑它的批准随之失效（E13） */
  replaced_at?: string;
  /** cover */
  ratio?: CoverRatio;
  version?: number;
  text?: string;
  /** srt：所属成片的 sha */
  for_cut?: string;
  /** chatcut_project */
  project_id?: string;
  timeline_id?: string;
  uses_aroll?: string[];
  /** publish（发布回执，§6）：平台、账号、作品身份（url 或 item_id）、提交状态、是否已核实 */
  platform?: string;
  account?: string;
  url?: string;
  item_id?: string;
  pub_state?: PublicationState;
  /** 可信来源（AutoCrew 发布器 / 数据回流 / 创始人确认）= true；模型说的 = false（待核，§13-E） */
  verified?: boolean;
  /** 被驳回的原因 */
  reason?: string;
  /** 回执的作品身份（跨轮去重键） */
  receipt_key?: string;
  note?: string;
}

/** 回执的提交状态（沿用 publish-record.ts 的语义）：scheduled / reviewing / public / overdue 算已投出，rejected 不算 */
export type PublicationState = "scheduled" | "reviewing" | "public" | "overdue" | "rejected";

export type DecisionType =
  | "script_approval" // 认稿：绑正文哈希
  | "script_revoke" // 创始人把认过的稿拉回写稿段
  | "candidate_confirm"
  | "candidate_reject"
  | "cut_approval"
  | "cut_reject"
  | "cover_approval"
  | "cover_reject" // 只进时间线（E15），不影响推导
  | "approval_revoke"
  | "reopen" // 重开文稿：结束本轮
  | "i_published"
  | "publish_confirm" // 创始人确认一条待核回执（模型说的「发了」）
  | "publish_correction";

export interface Decision {
  id: string;
  type: DecisionType;
  round: number;
  at: string;
  /** legacy = 启用本体时由旧状态迁移出来的等价决定（§4.1） */
  source: "founder" | "legacy";
  body_hash?: string;
  fact_id?: string;
  sha256?: string;
  cover_3x4_sha?: string;
  cover_4x3_sha?: string;
  cover_text?: string;
  /** cover_reject：这次打回涉及的封面 sha（整批打回时是当时展示的全部封面） */
  shas?: string[];
  /** approval_revoke / publish_correction 撤的是哪条决定 */
  target_id?: string;
  platform?: string;
  note?: string;
}

/** 登记记录：某一组决定提交成功的不可变凭据（§5）。D2 只认与当前有效批准完全一致的那条 */
export interface Registration {
  id: string;
  round: number;
  at: string;
  source: "commit" | "legacy";
  body_hash: string;
  cut_approval_id?: string;
  cut_sha?: string;
  cover_approval_id?: string;
  cover_3x4_sha?: string;
  cover_4x3_sha?: string;
  cover_text?: string;
  srt_sha?: string;
  srt_for_cut?: string;
  /** 落文件的那次事务（commit 来源） */
  txn_id?: string;
}

export interface StoredReceipt { at: string; receipt: Record<string, unknown> }

export interface ProductionDoc {
  schema: 1;
  /** 每次写 +1；所有写入按它做乐观并发 */
  revision: number;
  /** 制作轮次；重开文稿 +1 */
  round: number;
  /** 时间线单调序号（timeline.jsonl 的 seq） */
  seq: number;
  facts: Fact[];
  decisions: Decision[];
  registrations: Registration[];
  /** 本轮开始的时间（重开文稿时写）：更早的外部发布证据属于历史轮，不算本轮 D1 */
  round_started_at?: string;
  /** 本轮进入剪辑中时冻结的正文 */
  frozen?: { round: number; body_hash: string; path: string; at: string } | null;
  /** record 的 request_id → 上次回执（重放用，只留最近 200 条） */
  requests?: Record<string, StoredReceipt>;
  /** 已提交的文件归属事务 id（恢复按它判提交，只留最近 200 条） */
  txns?: string[];
  /** 登记提交最近一次失败的原因（D3 的 missing） */
  commit_failure?: { round: number; reason: string; at: string } | null;
}

export interface TimelineEvent {
  seq: number;
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

export function emptyProductionDoc(): ProductionDoc {
  return { schema: 1, revision: 0, round: 1, seq: 0, facts: [], decisions: [], registrations: [], frozen: null, requests: {}, txns: [] };
}
