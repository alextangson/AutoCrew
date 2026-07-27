/**
 * 视频生产线 · 核心域类型（设计 spec v2 §2 全部数据模型 + §3 job）。
 *
 * 三条纪律写在类型层面，读代码就能看见：
 * 1. **视频状态不进 Content**（§2.1）：`updateContent` 是非原子读改写，并发写必互相覆盖。
 *    本模块的全部状态落 `contents/<id>/video/`，Content 只在终点被盖一次 `videoReadyAt`。
 * 2. **事实与决策分离**（§2.3）：transcript 是不可变 ASR 事实，cut 是可多轮的剪辑决策，
 *    两者各自版本化；LLM 建议与人工终裁都只是新的 cut revision，ASR 数据零复制。
 * 3. **timeline 一律工作在输出时间域**（§2.4）：源时间域只存在于 transcript 与 outputMap 里。
 *    字幕词级时间戳不复制进 timeline，渲染时经 outputMap 投影。
 *
 * 受控枚举（graphic 模板 / 转场 / 字幕样式 / 标题卡）**不在 TS 里复制**：
 * 单一事实源是 `timeline-registry.json`（§2.7），主进程与 render workspace 各读各校验。
 * 所以这里相关字段是 `string`，由 `timeline-validate.ts` 对着 registry 判定。
 */

// ---------------------------------------------------------------------------
// §2.2 video/state.json —— phase × state
// ---------------------------------------------------------------------------

/** 阶段：只许前进或停留（重试 = 停在原 phase 重投） */
export type VideoPhase =
  | "ingest"
  | "transcribe"
  | "cut"
  | "assemble"
  | "render"
  | "review"
  | "done";

/** 运行态：与 phase 正交——「在哪一步」和「这一步怎么样了」是两件事 */
export type VideoRunState =
  | "idle"
  | "queued"
  | "running"
  | "awaiting_human"
  | "blocked"
  | "failed"
  | "done";

/** 阻塞原因：每一个都对应一条人话指引（§10 边界清单 1） */
export type VideoBlockedReason =
  | "asr_not_ready"
  | "ffmpeg_missing"
  | "key_missing"
  | "aroll_drifted"
  | "budget_exceeded";

/** 各产物的当前 revision；缺省 = 该产物尚未产生 */
export interface VideoRevisions {
  transcript?: number;
  cut?: number;
  timeline?: number;
  rendered?: number;
}

/** 生成所用输入的指纹（§2.2）：用没用、用哪版可回溯 */
export interface VideoInputManifest {
  bodyHash: string;
  videoKitHash?: string;
  identityHash: string;
}

/** 输入漂移标注——**只标注不自动重跑**（重跑是人的决定） */
export interface VideoStaleFlags {
  body?: boolean;
  aroll?: boolean;
}

export interface VideoState {
  schemaVersion: 1;
  entryType: "aroll";
  phase: VideoPhase;
  state: VideoRunState;
  blockedReason?: VideoBlockedReason;
  /**
   * 失败恢复点：重试 = 重投 failedPhase，回到其前置人工门产物。
   * spec 原文写的是 `string`，这里收紧成 VideoPhase——`video:retry` 要拿它直接投递，
   * 一个拼错的字符串会变成投不出去的死状态。
   */
  failedPhase?: VideoPhase;
  errorCode?: string;
  failReason?: string;
  revisions: VideoRevisions;
  inputManifest?: VideoInputManifest;
  stale?: VideoStaleFlags;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// §2.3 transcript（不可变事实）与 cut（可多轮决策）
// ---------------------------------------------------------------------------

/** 词级时间戳。源时间域用于 transcript，投影后同结构用于输出时间域 */
export interface TranscriptWord {
  w: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  /** A-roll **源**时间域 */
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
}

/** `video/transcript.v<N>.json` —— 重跑 ASR 才产生新 revision，永不就地改写 */
export interface VideoTranscript {
  schemaVersion: 1;
  source: "funasr";
  segments: TranscriptSegment[];
  /** 与口播稿的对齐度；< 0.5 时不给 LLM 建议权（§4.4） */
  scriptAlignment?: { matchedRatio: number };
}

/** 分句标注：给人看的问题标记，不影响 keep 判定 */
export type CutFlagKind = "misread" | "repeat" | "offtopic";

export interface CutFlag {
  segmentId: string;
  flag: CutFlagKind;
}

/** 决策来源：default_all = V0a 首版全 keep；llm = 建议；human = 人工终裁 */
export type CutOrigin = "default_all" | "llm" | "human";

/** `video/cut.v<M>.json` —— 只存决策，不复制任何 ASR 数据 */
export interface VideoCut {
  /** 这份决策是对哪一版转写做的（乐观锁与漂移判定都靠它） */
  transcriptRevision: number;
  keeps: string[];
  flags: CutFlag[];
  origin: CutOrigin;
  /** 基于哪一版 cut 改的（人工在 LLM 建议上再改时非空） */
  baseCutRevision?: number;
}

// ---------------------------------------------------------------------------
// §2.4 EDL：源时间域 → 输出时间域
// ---------------------------------------------------------------------------

/** keep 段按 transcript 顺序拼接后的一条映射；成片时间轴的唯一事实源 */
export interface OutputMapEntry {
  segmentId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  outputStartMs: number;
}

// ---------------------------------------------------------------------------
// §2.5 timeline（底轨 + 覆盖轨，全部工作在输出时间域）
// ---------------------------------------------------------------------------

export interface TimelineAnchor {
  /** V1 加 kind:"tts"——换 TTS 锚不改 timeline 结构 */
  kind: "aroll";
  transcriptRevision: number;
  cutRevision: number;
}

/** 底轨恒全程覆盖输出域——黑屏空洞按构造不可能（§2.5） */
export interface TimelineBase {
  type: "aroll";
}

export type OverlayFit = "cover" | "contain";

/**
 * 覆盖轨素材来源。判别联合的 tag 是 `type`；
 * `template` 与 props 形状由 registry 判定，TS 只保证「是个字符串/对象」。
 */
export type OverlaySource =
  | { type: "screen"; assetId: string; inMs?: number; outMs?: number; fit?: OverlayFit }
  | { type: "graphic"; template: string; props: Record<string, unknown> }
  | { type: "ai"; assetId: string }
  | { type: "image"; assetId: string };

export interface TimelineOverlay {
  clipId: string;
  /** 输出时间域 */
  outputStartMs: number;
  durationMs: number;
  source: OverlaySource;
  /** registry.transitions 之一 */
  transition?: string;
}

export interface TimelineCaptions {
  /** registry.captions 之一 */
  style: string;
  emphasisWords?: string[];
}

/** 语义 = 输出域开头的覆盖层，**不前插、不改总时长** */
export interface TimelineTitleCard {
  /** registry.titles 之一 */
  template: string;
  text: string;
  durationMs: number;
}

export interface TimelineAudio {
  anchorGainDb: number;
  /** BGM 是 V1 能力，V0 结构预留 */
  bgm?: { file: string; gainDb: number; duckDb: number };
}

export interface VideoTimeline {
  schemaVersion: 1;
  fps: number;
  width: number;
  height: number;
  anchor: TimelineAnchor;
  base: TimelineBase;
  /** 互不重叠；z-order 固定 base < overlay < captions */
  overlays: TimelineOverlay[];
  captions: TimelineCaptions;
  titleCard?: TimelineTitleCard;
  audio: TimelineAudio;
}

// ---------------------------------------------------------------------------
// §2.6 素材清单与 AssetRef
// ---------------------------------------------------------------------------

/**
 * 三种引用各有归宿：
 * - library：素材库记录（引用不复制，原文件留原地）
 * - content：稿件 `assets/` 下已登记文件
 * - video：`contents/<id>/video/assets/` 下的生成物
 */
export type AssetRef =
  | { kind: "library"; id: string }
  | { kind: "content"; filename: string }
  | { kind: "video"; file: string };

export type VideoAssetKind = "aroll" | "screen" | "ai" | "image";

/** 五态：pending/generating 尚无文件，ready 可用，confirmed 人工确认过，failed 出局 */
export type VideoAssetStatus = "pending" | "generating" | "ready" | "failed" | "confirmed";

/**
 * 可复现性指纹（§4.2）。`quickHash = sha256(首1MB + 末1MB + size)`——
 * 全量 hash 对 2GB 素材太贵，这是显式取舍，代价写在 fingerprint.ts 的注释里。
 */
export interface AssetFingerprint {
  size: number;
  /** spec 写的是 `mtime`；这里落成毫秒数（fs.Stats.mtimeMs），单位歧义就此消灭 */
  mtimeMs: number;
  quickHash: string;
}

/** AI 采购溯源（V0b 起写入；V0a 恒为空） */
export interface AssetProvenance {
  prompt: string;
  provider: string;
  taskId?: string;
  requestId: string;
  costYuan: number;
}

export interface VideoAssetEntry {
  assetId: string;
  kind: VideoAssetKind;
  ref: AssetRef;
  status: VideoAssetStatus;
  /** pending/generating 时文件还不存在，故可缺省；ready/confirmed 必须有 */
  fingerprint?: AssetFingerprint;
  provenance?: AssetProvenance;
}

// ---------------------------------------------------------------------------
// §2.8 render manifest —— 冻结点
// ---------------------------------------------------------------------------

/**
 * assemble 终点冻结的渲染契约。**render 只消费这份 manifest**，绝不回头读 timeline；
 * 发布件的 AI 标注判定只读被审那版的 `provenance`（§2.8 / codex #24）。
 *
 * 字段形状是跨 workspace 契约：render CLI 按它自类型化并做第二次校验，
 * 改这里等于改协议——要么双侧同改，要么升 schemaVersion。
 */
export interface RenderManifestArollSegment {
  sourceStartMs: number;
  sourceEndMs: number;
  outputStartMs: number;
}

export interface RenderManifestOverlay {
  clipId: string;
  outputStartMs: number;
  durationMs: number;
  kind: "screen" | "graphic" | "ai" | "image";
  /** screen/ai/image：已解析的绝对路径 */
  file?: string;
  inMs?: number;
  outMs?: number;
  fit?: OverlayFit;
  /** graphic：registry 模板名与其 props */
  template?: string;
  props?: Record<string, unknown>;
  transition?: "cut" | "fade";
}

export interface RenderManifestCaptions {
  style: "word-highlight";
  /** 已投影到输出时间域的词级时间戳 */
  words: TranscriptWord[];
  emphasisWords: string[];
}

export interface RenderManifestIdentity {
  captionTheme: {
    fontFamily?: string;
    primaryColor: string;
    emphasisColor: string;
  };
  /** 代码块配色。形状与 render workspace 的 CodeThemeSchema 对齐（那边 `.strict()`，写成字符串会被拒） */
  codeTheme?: {
    background?: string;
    foreground?: string;
    accent?: string;
    fontFamily?: string;
  };
}

export interface RenderManifest {
  schemaVersion: 1;
  contentId: string;
  timelineRevision: number;
  cutRevision: number;
  transcriptRevision: number;
  /** V0 只出竖屏 1080×1920@30（§10「竖屏以外画幅」不做）——字面量即契约 */
  fps: 30;
  width: 1080;
  height: 1920;
  durationMs: number;
  anchorAudio: { file: string; durationMs: number };
  arollVideo: { file: string; segments: RenderManifestArollSegment[] };
  overlays: RenderManifestOverlay[];
  captions: RenderManifestCaptions;
  titleCard?: { template: "hook-title"; text: string; durationMs: number };
  identity: RenderManifestIdentity;
  provenance: { hasAiClips: boolean; hasClonedVoice: boolean };
}

// ---------------------------------------------------------------------------
// §3 执行模型 —— video/jobs.jsonl
// ---------------------------------------------------------------------------

/** 只有这三步值得开 job：cut/review 是人工门，ingest 是同步校验 */
export type VideoJobPhase = "transcribe" | "assemble" | "render";

export type VideoJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface VideoJob {
  jobId: string;
  contentId: string;
  phase: VideoJobPhase;
  /**
   * `{transcript|cut|timeline}Revision` 组合。读视图按 `{contentId, phase, inputKey}`
   * latest-wins——同输入重复投递自动合并，不同输入各自成队（codex #6）。
   */
  inputKey: string;
  status: VideoJobStatus;
  attempts: number;
  /** pid + launchId：settle 时 CAS 校验「还是不是我」 */
  leaseOwner?: string;
  claimedAt?: string;
  /** 60 秒续租；过期 10 分钟即可回收（§3） */
  heartbeatAt?: string;
  startedAt?: string;
  settledAt?: string;
  outputRevision?: number;
  errorCode?: string;
  failReason?: string;
}
