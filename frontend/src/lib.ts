/**
 * 共享常量与领域类型(B 期)。平台目录/看板列/状态文案与 vanilla(dom.js/board.js)
 * 同源同值——D 期清场前两边手动同步,清场后这里是唯一事实源。
 */
import { invoke } from "./transport";

export const PLATFORM_CATALOG = [
  { id: "wechat_mp", label: "公众号", group: "cn", gen: true },
  { id: "douyin", label: "抖音", group: "cn", gen: true },
  { id: "xiaohongshu", label: "小红书", group: "cn", gen: true },
  { id: "wechat_video", label: "视频号", group: "cn", gen: true },
  { id: "bilibili", label: "B站", group: "cn", gen: true },
  { id: "toutiao", label: "头条", group: "cn", gen: true },
  { id: "twitter", label: "X (Twitter)", group: "en", gen: true },
  { id: "reddit", label: "Reddit", group: "en", gen: true },
  { id: "instagram", label: "Instagram", group: "en", gen: false },
] as const;

export function platformLabel(p: string | null | undefined): string {
  return PLATFORM_CATALOG.find((c) => c.id === p)?.label ?? p ?? "—";
}

/** 来源标签人话化(V5.6.2):radar:X → 雷达·X;x:@n → X·@n;其余原样 */
export function sourceLabel(s: string | null | undefined): string {
  if (!s) return "";
  if (s.startsWith("radar:")) return "雷达·" + s.slice(6);
  if (s.startsWith("x:")) return "X·" + s.slice(2);
  return s;
}

export const BOARD_COLUMNS = [
  { key: "idea", label: "灵感库", statuses: [] as string[] },
  { key: "writing", label: "在写", statuses: ["topic_saved", "drafting", "draft_ready", "revision"] },
  { key: "review", label: "待审", statuses: ["reviewing"] },
  // 阶段制（spec §0 清扫 2）:editing/cover_pending 是定稿之后的生产阶段,与 approved 同列;
  // 它们不是「待审」——没人在等着审,是片子/封面在做。
  { key: "ready", label: "待发布", statuses: ["approved", "editing", "cover_pending", "publish_ready", "publishing"] },
  { key: "published", label: "已发布", statuses: ["published"] },
] as const;

export const STATUS_COLUMN: Record<string, number> = {};
BOARD_COLUMNS.forEach((c, i) => c.statuses.forEach((s) => (STATUS_COLUMN[s] = i)));

/** 拖到某列 = 流转到该列代表状态(状态机校验,非法拒绝) */
export const DROP_TARGET_STATUS: Record<string, string> = {
  writing: "draft_ready",
  review: "reviewing",
  ready: "publish_ready",
  published: "published",
};

export const VARIANT_STATUS: Record<string, string> = {
  topic_saved: "选题", drafting: "写中", draft_ready: "草稿", revision: "修订",
  reviewing: "待审", approved: "已过审", editing: "剪辑", cover_pending: "封面设计",
  publish_ready: "待发", publishing: "发布中", published: "已发", archived: "归档",
};

/** 稿件阶段 → 工作台（阶段制 spec §2）:打开稿件按状态进对应的那一张台子 */
export type StageWorkspace = "draft" | "editing" | "cover" | "publish";

const WORKSPACE_BY_STATUS: Record<string, StageWorkspace> = {
  editing: "editing",
  cover_pending: "cover",
  publish_ready: "publish",
  publishing: "publish",
  published: "publish",
  archived: "publish",
};

/** 未知状态一律回落文案台:界面不认识的状态也要有地方站,不能白屏 */
export function workspaceForStatus(status: string): StageWorkspace {
  return WORKSPACE_BY_STATUS[status] ?? "draft";
}

export const WORKSPACE_LABEL: Record<StageWorkspace, string> = {
  draft: "文案",
  editing: "剪辑台",
  cover: "封面台",
  publish: "发布台",
};

/**
 * 角度卡(角度卡 spec §1.2)——后端 src/modules/research/brief-store.ts 的 `AngleCard` 对应件,
 * 逐字段同名同义。它约束的是**全稿**不只是开头:thesis 必须被论证,antiScope 是禁区。
 * 证据引用是**位置 id**("ev-1" = 简报 evidence 第 1 条,"tension-1" 同理)。
 */
export interface AngleCard {
  /** "angle-1"…(简报版本内稳定:位置即身份) */
  id: string;
  angle: string;
  thesis: string;
  coreEvidenceIds: string[];
  tensionId?: string;
  antiScope: string;
  audiencePain: string;
  holdTrigger: string;
  hookDraft: string;
}

/**
 * 创始人选定的角度(后端 SelectedAngle 对应件)。存指针 + **生效卡快照**两样:
 * 改写版就存改写版,读侧统一走 `card`;指针(briefRevision/angleId)只用来现算过期。
 */
export interface SelectedAngle {
  briefRevision: number;
  angleId: string;
  card: AngleCard;
  selectedAt: string;
}

export interface Topic {
  id: string;
  title: string;
  description?: string;
  reason?: string;
  source?: string;
  link?: string;
  originalTitle?: string;
  score?: number;
  scoreBreakdown?: {
    audienceFit: number;
    materialRichness: number;
    novelty: number;
    timeliness: number;
  };
  angles?: string[];
  /** 创始人点选/改写的角度卡;未选 = 字段不落,写稿走「未经角度点选」 */
  selectedAngle?: SelectedAngle;
  scoredAt?: string;
  createdAt: string;
  /** 续期锚:有动作(如启动深调研)就从那一刻重新计时——过期清理与卡上天龄都按它算 */
  renewedAt?: string;
}

export interface Content {
  id: string;
  title: string;
  body: string;
  digest?: string;
  platform: string;
  status: string;
  topicId?: string;
  hashtags: string[];
  lastError?: string | null;
  adoption?: { verdict: string; reason?: string; reasonNote?: string; derived?: boolean };
  /** AI 审稿结论(审稿 spec §2.5):稿卡徽章读它;旧稿无此字段 = 不显示徽章 */
  review?: {
    status: "passed" | "revised" | "failed" | "skipped" | "stale";
    rounds: number;
    fixed: number;
    issues: Array<{ id: string; severity: "blocker" | "advisory"; quote: string; rule: string; instruction: string }>;
    reviewedAt: string;
  };
  videoKit?: { postTitle: string; caption: string; storyboard: unknown[]; coverText: string };
  performanceData?: Record<string, number>;
  versions?: Array<{ version: number; note?: string; savedAt: string }>;
  publishedAt?: string | null;
  /** 发布后的平台地址(确认已发布时选填);渲染成链接前必须再过一次 isHttpUrl */
  publishUrl?: string | null;
  /** 成片就绪时刻(视频线终点戳):非空 = 片子渲染并审过了,等着进发布流程 */
  videoReadyAt?: string | null;
  /** 当前这一版成片审过了(阶段门唯一认的凭据);重开剪辑即清空 */
  videoDone?: { renderedRevision: number; at: string } | null;
  /** 挂接进本稿的素材(剪辑台按 role 判断 A-roll 齐没齐) */
  assets?: Array<{ filename: string; type: string; description?: string; role?: string }>;
  createdAt: string;
  updatedAt: string;
}

/** 推进下拉的一项:blockedReason 非空 = 形状允许但阶段门拦着,灰显并说清为什么 */
export interface AllowedTransition {
  status: string;
  blockedReason?: string;
}

/** 链接的显示域名(去掉 www.);不是合法 URL 就截前 30 字符——展示用,不做校验 */
export function linkDomain(url: string): string {
  const m = url.match(/https?:\/\/([^/\s]+)/);
  return m ? m[1].replace(/^www\./, "") : url.slice(0, 30);
}

/** 平台链接白名单:只认 http(s)。输入校验与渲染前校验共用它——存量脏数据同样不许变成可点链接 */
export function isHttpUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw.trim()).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 已发布但没有可用链接 → 该出「补记平台链接」入口(spec §5.1)。
 * 存量脏数据(非 http(s) 的旧值)同样算「没链接」:它既渲染不成链接,也解析不出作品 id,
 * 留着只会让人以为已经记过了。
 */
export function needsPublishUrlBackfill(c: { status: string; publishUrl?: string | null }): boolean {
  return c.status === "published" && !(c.publishUrl && isHttpUrl(c.publishUrl));
}

/** 平台 → 发布链接常见域名。用来提醒「贴错平台」,不是白名单——判不准的一律不吭声 */
const PLATFORM_DOMAINS: Record<string, string[]> = {
  wechat_mp: ["mp.weixin.qq.com"],
  douyin: ["douyin.com", "iesdouyin.com"],
  xiaohongshu: ["xiaohongshu.com", "xhslink.com"],
  wechat_video: ["channels.weixin.qq.com", "weixin.qq.com"],
  bilibili: ["bilibili.com", "b23.tv"],
  toutiao: ["toutiao.com"],
  twitter: ["x.com", "twitter.com"],
  reddit: ["reddit.com"],
  instagram: ["instagram.com"],
};

/**
 * 链接域名与稿件平台明显不符时的提示语(否则 null)。**非阻断**:发错平台是用户
 * 要知道的事,不是系统要拦的事——一稿多投、短链、自建域都可能合法。
 */
export function publishUrlPlatformWarning(raw: string, platform: string | null | undefined): string | null {
  if (!isHttpUrl(raw) || !platform) return null;
  const domains = PLATFORM_DOMAINS[platform];
  if (!domains) return null;
  const host = new URL(raw.trim()).hostname.toLowerCase();
  if (domains.some((d) => host === d || host.endsWith("." + d))) return null;
  return `这个链接看着不像${platformLabel(platform)}的地址(${host})——确认没贴错平台就继续。`;
}

/** 原子分组(与 vanilla 同构):topicId 为脊椎;孤稿自成原子;纯灵感单列 */
export interface Atom {
  key: string;
  topic: Topic | null;
  members: Content[];
}

export function groupAtoms(topics: Topic[], contents: Content[]): Atom[] {
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const byTopic = new Map<string, Content[]>();
  const solo: Content[] = [];
  for (const c of contents) {
    if (c.topicId && topicById.has(c.topicId)) {
      const list = byTopic.get(c.topicId) ?? [];
      list.push(c);
      byTopic.set(c.topicId, list);
    } else {
      solo.push(c);
    }
  }
  const atoms: Atom[] = [];
  for (const [topicId, members] of byTopic) {
    atoms.push({ key: "t-" + topicId, topic: topicById.get(topicId) ?? null, members });
  }
  for (const c of solo) atoms.push({ key: "c-" + c.id, topic: null, members: [c] });
  for (const t of topics) {
    if (!byTopic.has(t.id)) atoms.push({ key: "t-" + t.id, topic: t, members: [] });
  }
  return atoms;
}

/** 原子代表稿 = 推进最远的成员(决定它落在哪一列) */
export function atomRep(atom: Atom): Content | null {
  let rep: Content | null = null;
  for (const m of atom.members) {
    if (!rep || (STATUS_COLUMN[m.status] ?? 0) > (STATUS_COLUMN[rep.status] ?? 0)) rep = m;
  }
  return rep;
}

export const VIDEO_PLATFORMS = new Set(["douyin", "wechat_video", "xiaohongshu", "bilibili"]);

/**
 * 平台 → 封面比例(首项 = 默认生成比例)。下拉与适配条都读这张表;
 * 与后端 src/modules/cover/platform-ratios.ts 同源同值,改动两边同步。
 * 创始人裁决 2026-07-12:抖音封面同时要 3:4 与 4:3(选用后自动补齐)。
 */
const COVER_RATIOS_BY_PLATFORM: Record<string, string[]> = {
  wechat_mp: ["2.35:1"],
  xiaohongshu: ["3:4"],
  wechat_video: ["3:4"],
  douyin: ["3:4", "4:3"],
  bilibili: ["16:9", "4:3"],
};

export function coverRatiosForPlatform(platform: string | null | undefined): string[] {
  return COVER_RATIOS_BY_PLATFORM[platform ?? ""] ?? ["3:4", "16:9", "4:3"];
}

export const COVER_RATIO_LABEL: Record<string, string> = {
  "2.35:1": "2.35:1 公众号横幅",
  "3:4": "3:4 竖屏",
  "16:9": "16:9 横屏",
  "4:3": "4:3 横屏",
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 视频生产线 V0a(设计 spec 2026-07-27 §2 数据模型 / §8.2 IPC / §8.3 SSE)
 *
 * frontend 是独立 workspace,**不 import 主仓库源码**——下面这批类型是照
 * src/modules/video/types.ts 手写的对应件(Content/Topic 同款约定),改一边同步另一边。
 * 只抄界面真正读的字段:timeline / render manifest / asset 清单前端碰不到,不抄。
 * ═══════════════════════════════════════════════════════════════════════════ */

export type VideoPhase = "ingest" | "transcribe" | "cut" | "edit" | "assemble" | "render" | "review" | "done";

export type VideoRunState = "idle" | "queued" | "running" | "awaiting_human" | "blocked" | "failed" | "done";

export type VideoBlockedReason =
  | "asr_not_ready"
  | "ffmpeg_missing"
  | "key_missing"
  | "aroll_drifted"
  | "budget_exceeded";

export interface VideoRevisions {
  transcript?: number;
  cut?: number;
  /** 剪辑师 plan 的版本;确认成片计划时当乐观锁的 base */
  editor?: number;
  timeline?: number;
  rendered?: number;
}

/**
 * 粗剪门内的低规格预览指针(v2 spec §4.1)。**它不是成片**:只用来在门上看一眼自己剪的是什么。
 * requestedRevision > readyRevision = 新的一版正在渲,老的那版还能播。
 */
export interface VideoPreviewState {
  requestedRevision: number;
  readyRevision?: number;
  error?: string;
}

/** done 之后的测试产物清理(lifecycle spec §3.3);warning = 清了但有清不掉的,必须让人看见 */
export interface VideoCleanupState {
  status: "pending" | "done" | "warning";
  approvedRevision: number;
  freedBytes?: number;
  note?: string;
  finishedAt?: string;
}

export interface VideoState {
  schemaVersion: 1;
  entryType: "aroll";
  phase: VideoPhase;
  state: VideoRunState;
  blockedReason?: VideoBlockedReason;
  preview?: VideoPreviewState;
  /** 已确认的成片计划版本;assemble 只读这一版的决策 */
  confirmedEditorRevision?: number;
  cleanup?: VideoCleanupState;
  failedPhase?: VideoPhase;
  errorCode?: string;
  failReason?: string;
  revisions: VideoRevisions;
  /** 输入漂移**只标注不自动重跑**(§2.2)——所以要在卡上说人话,让人决定重不重开 */
  stale?: { body?: boolean; aroll?: boolean };
  updatedAt: string;
}

/** jobs 只用来显示「第几次尝试/错在哪」,字段抄够就行 */
export interface VideoJob {
  jobId: string;
  /** cut_preview 是门内预览的辅助 job,不是 VideoPhase */
  phase: "transcribe" | "cut" | "edit" | "assemble" | "render" | "cut_preview";
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  failReason?: string;
}

export interface VideoStatusData {
  state: VideoState;
  jobs: VideoJob[];
  /** 当前成片版的审片记录;打回后目标门的横幅读它 */
  review?: VideoReviewDecision;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  /** A-roll 源时间域(毫秒) */
  startMs: number;
  endMs: number;
}

export interface VideoTranscript {
  schemaVersion: 1;
  source: "funasr";
  segments: TranscriptSegment[];
  /** 与口播稿的对齐度;< 0.5 说明念得跟稿子差很多,要逐句盯着看(§10 最坏输入) */
  scriptAlignment?: { matchedRatio: number };
}

export type CutFlagKind = "misread" | "repeat" | "offtopic";

export interface CutFlag {
  segmentId: string;
  flag: CutFlagKind;
}

export interface VideoCut {
  transcriptRevision: number;
  keeps: string[];
  flags: CutFlag[];
  origin: "default_all" | "llm" | "human";
  baseCutRevision?: number;
}

/**
 * 剪辑单元表(粗剪 spec §4)。V0b 起 **勾选列表渲染的是它的 segments**,不是 transcript
 * 的 VAD 分句——AI 按词区间重分过,单元边界与分句不再一一对应。老产物没有这份,回落
 * transcript.segments。
 */
export interface VideoEditUnits {
  schemaVersion: 1;
  transcriptRevision: number;
  origin: "raw" | "llm";
  segments: TranscriptSegment[];
  suggestedDrops: string[];
  flags: CutFlag[];
  provenance?: { model: string; promptVersion: string; bodyHash: string; generatedAt: string };
  /** 非空 = AI 粗剪降级了(没 key/词流不健康/建议过激),面板必须原样把这句话摆出来 */
  warning?: string;
}

export interface CutView {
  transcript: VideoTranscript;
  cut: VideoCut;
  editUnits?: VideoEditUnits;
}

/**
 * 覆盖轨的来源(v2 spec §4.2)。asset = 已有素材(快照钉住);
 * generate = 还不存在的画面,人要在门内填素材,或确认时明示跳过。
 */
export type EditorPlanSource =
  | { kind: "asset"; name: string; type: "screen" | "image"; durationMs?: number }
  | { kind: "generate"; description: string; mediaKind: "video" | "image" };

/**
 * 剪辑师排的一段 B-roll(横屏 spec §3)。界面能做的是「删掉这段」与「给待生成槽填素材」,
 * 时间轴拖拽本期不做——摆半成品的交互出来只会让人以为它能用。
 */
export interface EditorPlanOverlay {
  overlayId: string;
  label: string;
  source: EditorPlanSource;
  outputStartMs: number;
  durationMs: number;
  inMs?: number;
  outMs?: number;
  transition?: string;
}

export interface VideoEditorPlan {
  schemaVersion: 1;
  cutRevision: number;
  /** llm = 剪辑师真跑过(空 overlays = 它认为不需要);empty = 压根没跑;human = 人填槽派生的一版 */
  origin: "llm" | "empty" | "human";
  basePlanRevision?: number;
  overlays: EditorPlanOverlay[];
  /** 没写说明/读不出时长/超预算被截的素材——面板必须点名,否则人不知道自己少填了一行字 */
  excludedAssets?: string[];
  warning?: string;
  note?: string;
}

export interface EditorPlanView {
  plan: VideoEditorPlan;
  revision: number;
  /** 非空 = 这份计划是对上一版选段排的,按旧时间排的 overlay 会落错话——挡住确认 */
  staleCutRevision?: number;
}

/** 打回定位的落点(lifecycle spec §2.4):落在覆盖轨上就高亮那一槽,否则高亮那一句 */
export type ReviewLocation =
  | { kind: "overlay"; overlayId: string }
  | { kind: "segment"; segmentId: string };

/**
 * 审片记录(不可变产物 `review-decision.v<K>.json`)。打回的备注刷新不丢就靠它——
 * 纯前端存的备注活不过一次刷新,而人回到门上第一件事就是想知道「我当时说了什么」。
 */
export interface VideoReviewDecision {
  schemaVersion: 1;
  renderedRevision: number;
  verdict: "approve" | "reject";
  target?: "edit" | "cut";
  timestampMs?: number;
  note?: string;
  locate?: ReviewLocation;
  decidedAt: string;
}

/**
 * video:* 的统一返回信封。`conflict:true` 是**一等结果不是故障**
 * (video-handlers.ts 纪律 4):调用方据此提示「版本过期,已为你重载」。
 */
export interface VideoReply<T> {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  data?: T;
}

async function videoInvoke<T>(channel: string, payload: Record<string, unknown> = {}): Promise<VideoReply<T>> {
  return (await invoke(channel, payload)) as VideoReply<T>;
}

// ── 10 条通道(§8.2)。payload 一律 snake_case,与 video-handlers 的解析口对齐 ──

export const videoBuildStart = (contentId: string) =>
  videoInvoke<{ state: VideoState }>("video:build_start", { content_id: contentId });

/** data 为 null = 这篇还没开始剪(不是错误,卡片据此显示「开始构建」) */
export const videoStatus = (contentId: string) =>
  videoInvoke<VideoStatusData | null>("video:status", { content_id: contentId });

export const videoTranscriptGet = (contentId: string) =>
  videoInvoke<CutView | null>("video:transcript_get", { content_id: contentId });

/** 重跑 AI 粗剪(粗剪 spec §3.4);人工确认过的那版后端会拒,错误原样透传 */
export const videoRoughCutRerun = (contentId: string) =>
  videoInvoke<{ state: VideoState }>("video:rough_cut_rerun", { content_id: contentId });

export const videoCutConfirm = (args: {
  contentId: string;
  keeps: string[];
  flags: CutFlag[];
  baseTranscriptRevision: number;
  baseCutRevision: number;
}) =>
  videoInvoke<{ state: VideoState }>("video:cut_confirm", {
    content_id: args.contentId,
    keeps: args.keeps,
    flags: args.flags.map((f) => ({ segment_id: f.segmentId, flag: f.flag })),
    base_transcript_revision: args.baseTranscriptRevision,
    base_cut_revision: args.baseCutRevision,
    // 覆盖轨不在这一步提交:它由剪辑师排、由人在下一步删定(video:editor_confirm)
  });

/** 成片计划;data 为 null = 剪辑师还没跑过(不是错误) */
export const videoEditorPlanGet = (contentId: string) =>
  videoInvoke<EditorPlanView | null>("video:editor_plan_get", { content_id: contentId });

export const videoEditorConfirm = (args: {
  contentId: string;
  planRevision: number;
  keptOverlayIds: string[];
}) =>
  videoInvoke<{ state: VideoState }>("video:editor_confirm", {
    content_id: args.contentId,
    plan_revision: args.planRevision,
    kept_overlay_ids: args.keptOverlayIds,
  });

/** 给待生成槽填素材;返回的是**派生出的新一版 plan**,直接换掉手里那份 */
export const videoEditorSlotFill = (args: {
  contentId: string;
  planRevision: number;
  overlayId: string;
  libraryId: string;
}) =>
  videoInvoke<EditorPlanView>("video:editor_slot_fill", {
    content_id: args.contentId,
    plan_revision: args.planRevision,
    overlay_id: args.overlayId,
    library_id: args.libraryId,
  });

/** 删掉一段编排;与填槽同样派生**新一版 plan**(旧版留档不删),返回的就是新那版 */
export const videoEditorSlotRemove = (args: { contentId: string; planRevision: number; overlayId: string }) =>
  videoInvoke<EditorPlanView>("video:editor_slot_remove", {
    content_id: args.contentId,
    plan_revision: args.planRevision,
    overlay_id: args.overlayId,
  });

/** 门二退回门一(lifecycle §2.2):在成片计划上才发现话说错了 */
export const videoEditorBackToCut = (args: { contentId: string; planRevision: number }) =>
  videoInvoke<{ state: VideoState }>("video:editor_back_to_cut", {
    content_id: args.contentId,
    plan_revision: args.planRevision,
  });

/** 按门上当前勾选重渲一版预览;主状态不动,渲完走 SSE 刷新 */
export const videoCutPreview = (args: {
  contentId: string;
  keeps: string[];
  baseTranscriptRevision: number;
  baseCutRevision: number;
}) =>
  videoInvoke<{ state: VideoState }>("video:cut_preview", {
    content_id: args.contentId,
    keeps: args.keeps,
    base_transcript_revision: args.baseTranscriptRevision,
    base_cut_revision: args.baseCutRevision,
  });

/** 渲染失败在一份废 manifest 上时的出口:回组装重出一份(重试只会重投同一份) */
export const videoReassemble = (contentId: string) =>
  videoInvoke<{ state: VideoState }>("video:reassemble", { content_id: contentId });

/** 重新跑剪辑师(横屏 spec §3.1);只在成片计划的人工门上可用,错误原样透传 */
export const videoEditorRerun = (contentId: string) =>
  videoInvoke<{ state: VideoState }>("video:editor_rerun", { content_id: contentId });

/**
 * 审片裁决。打回带 target(回门二改 B-roll / 回门一改选段)、播放位置与备注——
 * 三样都落进不可变记录,目标门的横幅刷新后照样看得见(lifecycle §2.4)。
 */
export const videoReviewConfirm = (args: {
  contentId: string;
  renderedRevision: number;
  verdict: "approve" | "reject";
  target?: "edit" | "cut";
  timestampMs?: number;
  note?: string;
}) =>
  videoInvoke<{ state: VideoState; videoReadyAt?: string | null; stampWarning?: string }>("video:review_confirm", {
    content_id: args.contentId,
    rendered_revision: args.renderedRevision,
    verdict: args.verdict,
    ...(args.target ? { target: args.target } : {}),
    ...(args.timestampMs !== undefined ? { timestamp_ms: args.timestampMs } : {}),
    ...(args.note ? { note: args.note } : {}),
  });

export const videoRetry = (contentId: string) =>
  videoInvoke<{ state: VideoState }>("video:retry", { content_id: contentId });

export const videoAsrWarmup = () => videoInvoke<{ status: string }>("video:asr_warmup");

/** absent | warming | ready | failed */
export const videoAsrStatus = () => videoInvoke<{ status: string; detail?: string }>("video:asr_status");

export const videoSettingsGet = () =>
  videoInvoke<{ renderConcurrency: number | null; snapshotCopy: boolean }>("video:settings_get");

export const videoSettingsSet = (patch: { renderConcurrency?: number | null; snapshotCopy?: boolean }) =>
  videoInvoke<{ renderConcurrency: number | null; snapshotCopy: boolean }>("video:settings_set", {
    ...(patch.renderConcurrency !== undefined ? { render_concurrency: patch.renderConcurrency } : {}),
    ...(patch.snapshotCopy !== undefined ? { snapshot_copy: patch.snapshotCopy } : {}),
  });

// ── 人话层:phase×state 全枚举都有说法(§10 边界清单 1) ──────────────────────

export const VIDEO_PHASE_LABEL: Record<VideoPhase, string> = {
  ingest: "素材校验",
  transcribe: "转写",
  cut: "选段",
  edit: "成片计划",
  assemble: "组装",
  render: "渲染",
  review: "审片",
  done: "完成",
};

export const CUT_FLAG_LABEL: Record<CutFlagKind, string> = {
  misread: "念错",
  repeat: "重复",
  offtopic: "跑题",
};

export interface VideoBlockedGuide {
  /** 卡在哪 */
  title: string;
  /** 人怎么解掉它 */
  how: string;
  /** 要在终端敲的命令(有就单独一行,可复制) */
  command?: string;
  /** 有专属动作的阻因;其余都是「解掉后重试」 */
  action?: "asr_warmup";
}

const BLOCKED_GUIDES: Record<VideoBlockedReason, VideoBlockedGuide> = {
  asr_not_ready: {
    title: "语音模型还没就绪",
    how: "首次要下载约 1GB 模型。点下面这个按钮开始预热,可以先干别的——好了会自动接着剪。",
    action: "asr_warmup",
  },
  ffmpeg_missing: {
    title: "系统里找不到 ffmpeg",
    how: "抽音轨和渲染都靠它。在终端装好后回来点「重试」:",
    command: "brew install ffmpeg",
  },
  key_missing: {
    title: "缺少必要的密钥",
    how: "去设置页把视频线要用的密钥填上,再回来点「重试」。",
  },
  aroll_drifted: {
    title: "A-roll 素材和开拍时对不上了",
    how: "素材是引用不是拷贝——文件被改名、移动或重新导出过。把原文件放回原处(或重新挂接一遍新素材),再点「重试」。",
  },
  budget_exceeded: {
    title: "这篇的 AI 镜头预算用完了",
    how: "V0a 不采购 AI 镜头,出现这条说明配置里预算被设成了 0——去设置页调整后重试。",
  },
};

/** blocked 但没给原因也要有说法——没说法的红字最劝退 */
export function videoBlockedGuide(reason?: VideoBlockedReason): VideoBlockedGuide {
  return (reason && BLOCKED_GUIDES[reason]) || { title: "卡住了(没给出原因)", how: "先点「重试」;还卡就看任务日志里剪辑师那几条。" };
}

/** 任意 phase×state 组合都有一句人话:状态机可见是验收清单第一条 */
export function videoStateSummary(s: VideoState): string {
  const phase = VIDEO_PHASE_LABEL[s.phase] ?? s.phase;
  switch (s.state) {
    case "idle":
      return "还没开始剪";
    case "queued":
      return `排队中 · ${phase}`;
    case "running":
      return `${phase}中…`;
    case "awaiting_human":
      if (s.phase === "cut") return "转写好了 —— 等你勾选留哪些句子";
      if (s.phase === "edit") return "剪辑师排好 B-roll 了 —— 等你过一遍";
      if (s.phase === "review") return "成片渲染好了 —— 等你审片";
      return `${phase} —— 等你确认`;
    case "blocked":
      return `卡住了 · ${videoBlockedGuide(s.blockedReason).title}`;
    case "failed":
      return `${VIDEO_PHASE_LABEL[s.failedPhase ?? s.phase] ?? phase}失败了`;
    case "done":
      return "成片已完成";
  }
}

/**
 * 成片播放地址(§6.4 / video-media.ts)。鉴权沿用 server 那套 **HttpOnly 同源
 * session cookie**——没有 query token,所以 `<video src>` 写相对路径就够;
 * 端点支持 Range(206),进度条能拖。
 */
export function videoMediaUrl(contentId: string, renderedRevision: number): string {
  return `/api/video/media/${encodeURIComponent(contentId)}/final.v${renderedRevision}.mp4`;
}

/**
 * 门内预览的播放地址(v2 spec §4.1)。与成片同一个媒体端点,但**文件名不同**——
 * 预览永远不冒充成片,拿错名字就播不出来,这是刻意的。
 */
export function videoPreviewUrl(contentId: string, previewRevision: number): string {
  return `/api/video/media/${encodeURIComponent(contentId)}/preview.v${previewRevision}.mp4`;
}

export interface CutPreviewStatus {
  /** 可播的那一版;null = 还没有任何可播预览 */
  playableRevision: number | null;
  /** 有新的一版在后台渲(老的那版若在,照常可播) */
  rendering: boolean;
  /** 非空 = 最近一次预览没渲出来,要摆成横幅;门照常可确认(边界 #1) */
  message: string | null;
}

/**
 * 预览指针 → 门内看片器的三个问题:现在能播哪版、是不是在渲新的、要不要横幅。
 * 预览失败**不算 rendering**——辅助 job 已经 settle 了,再显示「渲染中」是骗人。
 */
export function previewStatus(p?: VideoPreviewState): CutPreviewStatus {
  if (!p) return { playableRevision: null, rendering: false, message: null };
  return {
    playableRevision: p.readyRevision ?? null,
    rendering: !p.error && p.requestedRevision > (p.readyRevision ?? 0),
    message: p.error ? `预览没渲出来:${p.error} —— 不影响确认选段,也可以点「重新生成预览」再试。` : null,
  };
}

/** 成片登记回稿件素材时的文件名(render-exec.ts:`final-v<K>.mp4`,与上面播放名不同源) */
export function videoFinalAssetName(renderedRevision: number): string {
  return `final-v${renderedRevision}.mp4`;
}

/** 毫秒 → mm:ss.s(分句时间码与成片时长共用一套读法) */
export function formatTimecode(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const tenths = Math.floor(safe / 100) / 10;
  const m = Math.floor(tenths / 60);
  return `${String(m).padStart(2, "0")}:${(tenths - m * 60).toFixed(1).padStart(4, "0")}`;
}

/**
 * 提交给 `video:cut_confirm` 的 keeps:**按 transcript 顺序**归一。
 * 后端 buildOutputMap 本来就不看顺序,这里归一只为让每次提交确定可比(排查时 diff 干净)。
 */
export function keepsInTranscriptOrder(segments: TranscriptSegment[], kept: ReadonlySet<string>): string[] {
  return segments.filter((s) => kept.has(s.id)).map((s) => s.id);
}

/**
 * 收尾清理那一行(lifecycle spec §3.3)。**三态三句话**:还没清完 / 清完了释放多少 /
 * 清了但有清不掉的。没有「什么都不说」——静默清理会让人怀疑成片被动过。
 */
export function cleanupSummary(cleanup?: VideoCleanupState): string | null {
  if (!cleanup) return null;
  const freed = cleanup.freedBytes ? `,释放 ${(cleanup.freedBytes / 1024 / 1024).toFixed(1)} MB` : "";
  if (cleanup.status === "pending") return "正在清理测试产物(预览、废弃成片、可重算的音轨)…";
  if (cleanup.status === "warning") return `已清理测试产物${freed},但有清不掉的:${cleanup.note ?? "看任务日志"}`;
  return `已清理测试产物${freed} —— 通过版成片、引用音轨与全部决策记录都留着`;
}

/** 「X 分 Y 秒」——预计成片时长给人的读法,不用 mm:ss(那是时间码,不是时长) */
export function formatMinutesSeconds(ms: number): string {
  const total = Math.round((Number.isFinite(ms) && ms > 0 ? ms : 0) / 1000);
  const m = Math.floor(total / 60);
  return m > 0 ? `${m} 分 ${total - m * 60} 秒` : `${total} 秒`;
}

/**
 * AI 粗剪结果条(粗剪 spec §6)。只有 `origin:"llm"` 才有 AI 结论可报——
 * 全留版(raw)说「AI 剔除 0 段」会让人以为 AI 看过了,而它其实压根没跑。
 */
export function roughCutSummary(units?: VideoEditUnits): string | null {
  if (!units || units.origin !== "llm") return null;
  const dropped = new Set(units.suggestedDrops);
  const keptMs = units.segments.reduce(
    (sum, s) => (dropped.has(s.id) ? sum : sum + Math.max(0, s.endMs - s.startMs)),
    0,
  );
  const head = dropped.size === 0 ? "AI 认为无需剔除" : `剔除 ${dropped.size} 段`;
  const body = `AI 粗剪:${head} / 共 ${units.segments.length} 段,预计成片 ${formatMinutesSeconds(keptMs)}`;
  // 切口是硬切,这一版不做淡入淡出(粗剪 spec §7 #15)——不静默假装无损
  return dropped.size === 0 ? body : `${body}。剔除处是硬切,这一版不做淡入淡出`;
}

/**
 * 成片计划结果条(横屏 spec §3.5)。与 roughCutSummary 同一条纪律:**只有剪辑师真跑过
 * 才把结论记在它头上**——空 plan 要分清「它看过认为不需要」和「压根没排出来」;
 * 人填槽派生的版本(origin:"human")不再说「剪辑师排了」,那已经是人的版本。
 */
export function editorPlanSummary(plan: VideoEditorPlan, outputDurationMs?: number): string {
  if (plan.overlays.length === 0) {
    if (plan.origin === "llm") return "剪辑师看过素材,认为这条不需要 B-roll —— 确认后就是一条纯口播。";
    return plan.note ? `没有可排的 B-roll:${plan.note}` : (plan.warning ?? "这版计划没有 B-roll —— 确认后就是一条纯口播。");
  }
  const coveredMs = plan.overlays.reduce((sum, o) => sum + Math.max(0, o.durationMs), 0);
  const ratio = outputDurationMs && outputDurationMs > 0 ? `,约占成片 ${Math.round((coveredMs / outputDurationMs) * 100)}%` : "";
  const pending = plan.overlays.filter((o) => o.source.kind === "generate").length;
  const head =
    plan.origin === "human"
      ? `这版计划(你填过素材)共 ${plan.overlays.length} 段 B-roll`
      : `剪辑师排了 ${plan.overlays.length} 段 B-roll`;
  const slots = pending > 0 ? `;其中 ${pending} 段是待生成槽,要填素材或确认时明示跳过` : "";
  return `${head},共覆盖 ${formatMinutesSeconds(coveredMs)}${ratio}${slots}。`;
}

/** matchedRatio < 0.5 → 不给建议权,人要逐句盯(§4.4 / §10);没有对齐数据就不吓唬人 */
export function alignmentWarning(t: VideoTranscript | null): string | null {
  const ratio = t?.scriptAlignment?.matchedRatio;
  if (typeof ratio !== "number" || ratio >= 0.5) return null;
  return (
    `转写和口播稿只对上 ${Math.round(ratio * 100)}% —— 可能念得跟稿子差很多(或转写不准)。` +
    "AI 粗剪只给「重复/念错」建议,「跑题」判断已禁用(没有可靠准绳)。请逐句自己复核。"
  );
}
