/**
 * 内容本体（spec 2026-09-29-content-ontology §2）的落盘形状：一条内容 = 事实 + 决定 + 登记记录。
 * 制作段阶段是它们的纯函数（`modules/production/derive.ts`）；`status` 只是投影缓存。
 *
 * 放在 storage 层：正文写口的冻结检查、认稿决定都要在稿件写锁里读写这份文件，
 * 而 storage 不能在运行时反向依赖 modules。
 */

/** storyboard：脚本生成的分镜审阅页，只显示，不参与阶段推导（不在 PRODUCTION_KINDS 里） */
export type FactKind = "aroll" | "cut" | "srt" | "cover" | "publish" | "chatcut_project" | "storyboard";
/** 制作事实：本轮有一条 accepted 就进剪辑中（D4） */
export const PRODUCTION_KINDS: ReadonlySet<FactKind> = new Set(["aroll", "cut", "srt", "cover", "chatcut_project"]);

export type FactState = "accepted" | "candidate" | "pending_match" | "rejected";
/** 业务状态与文件可用性分开（Codex P1-9）：可用性只影响发布资格和告警 */
export type Availability = "present" | "missing" | "unreadable" | "archived";
/** migration：§6.2 统一准入时从 accepted 转成候选的封面（只改了标签；它们不是创始人要拍板的事） */
export type FactSource = "record" | "reconcile" | "founder" | "legacy" | "migration";
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
  /** 历史原片被创始人改挂到别条稿（归属转移，持久）：这条稿不再拥有它 */
  released_to?: string;
  released_at?: string;
  /** cover */
  ratio?: CoverRatio;
  version?: number;
  text?: string;
  /** cut：导出文件落位前自己的修改时间（克隆进项目后 mtime_ms 是落位时间；抽帧检查拿它比时间线保存时间） */
  export_mtime_ms?: number;
  /** aroll：记录 / 挪入之前的原始绝对路径（ChatCut 工程引用的往往是它；抽帧检查按路径认原片） */
  source_path?: string;
  /** aroll pending_match（1b §3）：核对作业代号、开始时间；落结果时锁内按它认「还是同一次核对」 */
  match_job?: string;
  match_started_at?: string;
  /** aroll：核对结果（前三名与原因）；只存稿件 id / 标题 / 分数，不存转写文本 */
  match?: { winner: string | null; reason: string; top3: Array<{ content_id: string; title: string; l1: string; l2?: number }> };
  /** aroll：卡片挂载后的内容核对（1b §7）。suggest = 听起来更像别条；kept = 创始人点过「就是这条」 */
  attach_check?: { status: "checking" | "ok" | "suggest" | "kept" | "not_ready" | "failed"; job?: string; other_id?: string; other_title?: string; reason?: string; at: string };
  /** aroll：系统自动挂上（pending_match 核对认出 / 1b 段 B 收件箱自动挪），「不是这条」可撤（§4.1） */
  auto_attached?: true;
  /** storyboard：同目录脚本回执的 sha256 */
  receipt_sha256?: string;
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
  /** 回执发布时间不明、又不在第一轮：分不清属于哪一轮，只能等创始人确认，对账永远不自动核实它 */
  round_unsure?: true;
  /** 回执观察的键（来源 | 平台 | 作品身份 | 状态 | 发布时间 | 原因），同键不重写 */
  receipt_key?: string;
  /** 回执观察的来源：plan / metrics_id（可信）、metrics_title / claim（待核） */
  obs_source?: "plan" | "metrics_id" | "metrics_title" | "claim";
  /** 平台上的发布时间（证据），轮次按它盖 */
  published_at?: string;
  /** 这条观察被读到的时间（纠正按它切：纠正之前读到的作废） */
  seen_at?: string;
  /** 计划里的实际提交时间：审核中没定时的回执没有公开时间，靠它认出新提交 */
  submitted_at?: string;
  /** 发布前把关记录（发布审查闸门的 check_id） */
  check_id?: string;
  /** 写入时盖的把关结论 */
  gate?: GateStamp;
  note?: string;
}

/** 回执的提交状态（沿用 publish-record.ts 的语义）：scheduled / reviewing / public / overdue 算已投出，rejected 不算 */
/** 发布回执写入时盖的把关结论（发布审查闸门 §11）：不可变，事后补检抹不掉 */
/**
 * 写入时盖的发布前把关结论。applies = 提交发生在这个资料库有闸门之后（本体启用之后）；
 * 之前的发布没有闸门可跑，不标「发布前未把关」。submitted_at = 用来判的实际提交时间（从不取定时公开时间）。
 */
export interface GateStamp { ok: boolean; check_id?: string; overrides: string[]; note?: string; applies?: boolean; submitted_at?: string }

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
  | "publish_correction"
  | "sliver_waive" // 抽帧缝「这处是故意的」：绑 round + 成片 sha + 结果指纹 + 缝身份
  | "sliver_waive_all" // 抽帧检查没跑成「这条不查了，放行」：绑 round + 成片 sha
  | "auto_attach_undo" // 1b §4.1：撤销系统自动挂上的原片（挪回原处、解冻、回待录制）
  | "attach_check_keep" // 1b §7：卡片挂载核对说「更像别条」，创始人点「就是这条」（记住）
  | "aroll_reassign" // 1b §7：当前轮原片改挂到别条（双内容事务的释放一方）
  // ---- 等你拍板（spec 2026-09-30-review-inbox）----
  | "ask_answer" // 创始人答请示（网页 / 会话窗口）：绑 ask_id + option_id
  | "ask_answer_undo" // 撤回 agent 转述的回答（24 小时内）
  | "storyboard_approval" // 分镜请示答「通过」：只批准请示绑定的那份快照
  | "cover_group_retire" // 「这组不要了」：该组作废，文件不删
  | "publish_check_confirm" // 「发之前再看一眼」点「没问题」：只记一笔，不是硬门
  | "publish_check_revise" // 「有几处要改…」：一句话给 agent
  | "publish_check_void" // 破例被拒、重跑出的检查又删不掉：作废它，不让它成为「当前」检查
  | "script_revise" // 「稿子还要改…」：一句话给 agent
  | "inbox_ack"; // 只确认、不改事实的条目（「对，就是它」自动挂上的原片、「让 agent 补」）

export interface Decision {
  id: string;
  type: DecisionType;
  round: number;
  at: string;
  /** legacy = 启用本体时由旧状态迁移出来的等价决定（§4.1）；chat = 对话里按创始人原话定的（chat-dialog / chat-reported 是修订前的旧值，照旧可读） */
  source: "founder" | "legacy" | "chat" | "chat-dialog" | "chat-reported";
  /** chat*：创始人在对话里的原话（agent 照抄转述，未经核验） */
  founder_words?: string;
  /** chat*：发起的宿主 / 会话 */
  requested_by?: string;
  /** chat：对话拍板的请求号（崩溃找回用） */
  request_id?: string;
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
  /** i_published：点「我发了」时盖的把关结论 */
  gate?: GateStamp;
  /** sliver_waive：放行时那份检查结果的输入指纹 */
  fingerprint?: string;
  /** sliver_waive：缝身份（帧区间 + 前后条目 id） */
  sliver_key?: string;
  /** ask_answer / ask_answer_undo / storyboard_approval */
  ask_id?: string;
  option_id?: string;
  /** cover_group_retire */
  group_id?: string;
  /** publish_check_confirm / publish_check_revise */
  check_id?: string;
  /** storyboard_approval：回执 sha（页面 sha 在 sha256） */
  receipt_sha256?: string;
  /** cover_reject（等你拍板）：打回的是哪几组；有它时只作废这几组的批准，不按共用的图连带别的组 */
  group_ids?: string[];
  /** inbox_ack：确认的是哪个条目 */
  item_id?: string;
}

// ---- 等你拍板（spec 2026-09-30-review-inbox）----

export type AskKind = "粗剪" | "分镜" | "样片" | "花费" | "配乐" | "其他";
export const ASK_KINDS: readonly AskKind[] = ["粗剪", "分镜", "样片", "花费", "配乐", "其他"];

export interface AskOption { id: string; label: string }
/** 附件：项目内相对路径 + 创建时的 sha */
export interface AskAttachment { path: string; sha256: string }
/** 分镜请示绑定的快照（Codex 4）：页面 sha、回执 sha、素材指纹、轮次 */
export interface AskStoryboard { fact_id: string; sha256: string; receipt_sha256: string; assets_fp: string; round: number }
export interface AskAnswer {
  option_id: string;
  note?: string;
  /** founder = 网页 / 会话窗口；agent_reported = agent 转述创始人在聊天里说的（可撤回 24 小时） */
  via: "founder" | "agent_reported";
  /** agent 转述时创始人的原话（逐字） */
  quote?: string;
  host?: string;
  at: string;
  decision_id?: string;
}

/** 剪辑途中的请示（§5）。state 只存 agent / 创始人动作的结果；稿重开 / 归档 / 删除时的「关闭」由读方按轮次与稿件状态推出 */
export interface Ask {
  id: string;
  request_id: string;
  round: number;
  kind: AskKind;
  question: string;
  options: AskOption[];
  attachments: AskAttachment[];
  storyboard?: AskStoryboard;
  at: string;
  by?: { host: string; session?: string };
  state: "open" | "answered" | "superseded" | "withdrawn";
  answer?: AskAnswer;
  /** 被撤回的转述回答 */
  history?: AskAnswer[];
  superseded_by?: string;
  ended_at?: string;
}

/** agent 标「可以审了」（§7-1）：独立、幂等的事件，绑 fact / sha / round */
export interface ReadyMark { id: string; fact_id: string; sha256: string; round: number; at: string; by?: { host: string; session?: string } }

/** 封面组 = 一个版本（§6.1）；成员关系单独存（组 ↔ 事实，带历史，不删） */
export interface CoverGroup {
  id: string;
  round: number;
  /** vNNN 的 NNN；final/ 目录的组没有版本号 */
  version?: number;
  label: string;
  at: string;
  source: FactSource | "migration";
  by?: { host: string; session?: string };
  evidence?: string;
}
/**
 * path：这一组文件夹里的那个文件（同一张图可能在几个组里各有一份）；replaced_at：这一份被覆盖了——
 * 只让这一组缺这张，不连累同一张图的别的组（整分支审 4 P2）
 */
export interface CoverMember { group_id: string; fact_id: string; sha256: string; ratio: CoverRatio; at: string; path?: string; replaced_at?: string }

/** 「等你拍板」的 CAS 消费记录（§3.1 R1/R2）：同一条目的同一代次只消费一次，回放按原结果 */
export interface InboxConsumption { item_id: string; gen: string; action: string; fp: string; at: string; result: Record<string, unknown>; /** 锁外还在跑（破例重跑等模型）：这一代已被占住 */ pending?: true }

/** 抽帧缝（spec 2026-09-30-broll-sliver-check）：A-roll 在两段盖住画面的条目之间露出 < 1 秒 */
export interface Sliver {
  /** 时间线帧，[start_frame, end_frame) */
  start_frame: number;
  end_frame: number;
  frames: number;
  start_tc: string;
  prev_item: string;
  next_item: string;
  prev_name?: string;
  next_name?: string;
  /** 缝里有转场帧：转场处可能露出（§12-7） */
  transition?: true;
  suggestion?: string;
}

/** 一次抽帧检查的结果（本轮、针对一版成片）。transient = 没拿到快照或读文件出错：不缓存，下次触发重跑 */
export interface SliverCheck {
  id: string;
  round: number;
  cut_sha: string;
  fingerprint: string;
  snapshot_sha: string | null;
  aroll_ids: string[];
  version: string;
  status: "clean" | "slivers" | "unchecked";
  slivers: Sliver[];
  reason?: string;
  transient?: true;
  checked_at: string;
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

/** args：这次请求的参数指纹；同一 request_id 只在参数一致时回放 */
export interface StoredReceipt { at: string; receipt: Record<string, unknown>; args?: string;
  /** 一对封面里的单张：整对请求的参数指纹，重试续记前核对（整分支审 14 P2） */
  pair_args?: string }

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
  /** 抽帧检查结果（最近 30 条） */
  sliver_checks?: SliverCheck[];
  /** 登记提交最近一次失败的原因（D3 的 missing） */
  commit_failure?: { round: number; reason: string; at: string } | null;
  /** 剪辑途中的请示（§5） */
  asks?: Ask[];
  /** 「可以审了」标记（§7-1） */
  ready_marks?: ReadyMark[];
  /** 封面组与成员关系（§6.1）；cover_schema=1 表示已按 §6.2 统一准入迁移过 */
  cover_groups?: CoverGroup[];
  cover_members?: CoverMember[];
  cover_schema?: 1;
  /** 「等你拍板」CAS 消费记录（最近 200 条） */
  inbox_log?: InboxConsumption[];
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
