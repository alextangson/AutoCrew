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

/**
 * 阶段：只许前进或停留（重试 = 停在原 phase 重投）。
 * `edit` = 剪辑师 agent 排 B-roll（横屏 spec §3.1）：它必须在 keeps 定稿**之后**跑
 * （plan 用输出域时间），且人要能在组装前删 overlay，所以是独立阶段而不是 assemble 的头部。
 */
export type VideoPhase =
  | "ingest"
  | "transcribe"
  | "cut"
  | "edit"
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
  /**
   * 剪辑师 plan 的版本（`editor-plan.v<N>.json`）。**与 cut 各自计数**：同一版 cut 可以重跑
   * 剪辑师若干次，而版本化产物不可覆盖——共用 cut 号第二次重跑就会撞上已存在的文件。
   */
  editor?: number;
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

/**
 * `video/edit-units.v<K>.json` —— **剪辑单位**（粗剪 spec §4）。K 与 cut revision 同号：
 * 一版剪辑决策配一版单元表，消费方拿 `revisions.cut` 一个数就能同时定位两份产物。
 *
 * 为什么不直接改 transcript：I2「事实与派生分家」——`transcript.vN` 必须原样保留 FunASR
 * 产物，重分出来的单元是派生物，混进去就再也说不清哪些边界是 ASR 给的、哪些是 LLM 划的。
 * segments 与 `TranscriptSegment` 同形，`buildOutputMap` / `projectWordsToOutput` 无差别消费。
 */
export interface VideoEditUnits {
  schemaVersion: 1;
  transcriptRevision: number;
  /** raw = transcript.segments 原样搬运（transcribe 阶段写，兜底）；llm = 按 drop 区间重分 */
  origin: "raw" | "llm";
  segments: TranscriptSegment[];
  /** 建议剔除的 unit id；**是提案不是决定**（I4），最终 keeps 由人裁 */
  suggestedDrops: string[];
  flags: CutFlag[];
  provenance?: { model: string; promptVersion: string; bodyHash: string; generatedAt: string };
  /** 降级可见（I5）：AI 没跑/没采纳时这里写人话原因，面板出横幅 */
  warning?: string;
}

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
// 剪辑师 plan（横屏 spec §3.1）——B-roll 编排的提案，人删完才生效
// ---------------------------------------------------------------------------

/**
 * plan 里的一段覆盖轨。`assetId` 是**本 plan 的目录编号**（b1、b2…），不是素材清单里的
 * assetId：编排时素材还没登记进 `assets.json`（那是 assemble 的活），而短编号比文件名
 * 更不容易被模型抄错。真正的落点由 `ref` 钉住，确认时直接翻成 OverlaySlot。
 */
export interface EditorPlanOverlay {
  overlayId: string;
  assetId: string;
  /** 素材说明快照，面板逐条显示（人靠它判断这一刀切得对不对） */
  label: string;
  filename: string;
  kind: "screen" | "image";
  ref: AssetRef;
  /** 输出时间域（成片时间轴） */
  outputStartMs: number;
  durationMs: number;
  /** 屏录取源素材的哪一段；跨度恒等于 durationMs */
  inMs?: number;
  outMs?: number;
  fit?: OverlayFit;
  transition?: string;
}

/**
 * `video/editor-plan.v<N>.json`。**是提案不是决定**：人在 `edit/awaiting_human` 上删到剩几条
 * （删光也合法，纯口播），确认时才写进 assemble 消费的覆盖轨槽位。
 *
 * 空 plan 的两种成因必须分得开（§3.1）：
 * - `origin:"llm"` + 空 overlays = 剪辑师看过了，认为不需要 B-roll
 * - `origin:"empty"` = 压根没跑（没素材/片子太短 → `note`；调用失败/无 key → `warning`）
 */
export interface VideoEditorPlan {
  schemaVersion: 1;
  /** 这份编排是对哪一版**确认后**的选段算的（输出域时间随 keeps 变，错版即失效） */
  cutRevision: number;
  origin: "llm" | "empty";
  overlays: EditorPlanOverlay[];
  emphasisWords: string[];
  /** 归一化后在成片里找不到的强调词（边界 #14）：面板标出来，不假装它们会亮 */
  unmatchedEmphasis?: string[];
  /** 没写说明、读不出时长、或超预算被截掉的素材（边界 #3 / #9）——面板点名 */
  excludedAssets?: string[];
  /** 非空 = 剪辑师没跑成，面板出横幅（降级必须可见） */
  warning?: string;
  /** 合法空 plan 的原因；不是故障，但也不能什么都不说 */
  note?: string;
  provenance?: {
    model: string;
    promptVersion: string;
    bodyHash: string;
    assetsHash: string;
    generatedAt: string;
  };
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
  /** 图版也吃 fit：宽截图铺满还是留黑边，剪辑师说了算（渲染侧本来就读这个字段） */
  | { type: "image"; assetId: string; fit?: OverlayFit };

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
  /** v2 = 横屏换向（横屏 spec §2.1）；v1 竖屏产物只读归档，不再重渲 */
  schemaVersion: 2;
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

/** bgm 是受管素材（横屏 spec §2.4）：走清单与指纹，混音永不接受裸文件路径 */
export type VideoAssetKind = "aroll" | "screen" | "ai" | "image" | "bgm";

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
  /** v2 = 横屏换向；v1 竖屏 manifest 进渲染会被 render 侧 zod 拒绝（横屏 spec §2.1） */
  schemaVersion: 2;
  contentId: string;
  timelineRevision: number;
  cutRevision: number;
  transcriptRevision: number;
  /** 视频线唯一画幅 = 横屏 1920×1080@30（横屏 spec §0）——字面量即契约 */
  fps: 30;
  width: 1920;
  height: 1080;
  durationMs: number;
  /** 有 BGM 时指 master-audio.v<K>.wav，无 BGM 时指 anchor.v<M>.wav；渲染侧只播这一条 */
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

/**
 * 值得开 job 的五步。cut 从 V0b 起有了计算步（AI 粗剪），所以它也要 lease/心跳/CAS——
 * 人工门是 `cut/awaiting_human`，门前那一道计算跟其它阶段一样要被调度纪律管住。
 * review 仍是纯人工门，ingest 是同步校验，两者不开 job。
 */
export type VideoJobPhase = "transcribe" | "cut" | "edit" | "assemble" | "render";

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
  /** 跑完了但结果没达成（AI 粗剪降级）：status 仍是 succeeded，原因留在台账里可追 */
  warning?: string;
}
