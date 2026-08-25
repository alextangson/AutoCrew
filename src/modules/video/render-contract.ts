/**
 * render manifest —— **跨 workspace 冻结契约**（设计 spec §2.8）。
 *
 * 单独成文件是因为它不是「本模块的域类型」，而是主进程与 render workspace 之间的协议：
 * render CLI 按同一份形状自己写 zod 并做第二次校验（禁止跨 workspace import TS 源码），
 * 所以改这里等于改协议——要么双侧同改，要么升 schemaVersion。
 *
 * `types.ts` 原样再导出这些名字，消费方不必知道它们住在哪个文件。
 */
import type { OverlayFit, TranscriptWord } from "./types.js";

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

/**
 * 一屏字幕。**assemble 冻结，渲染端只做块内排版**（v2 spec §2.1）——
 * 断句是语义决策，放在渲染端就只剩宽度可依，必然断错。
 */
export interface RenderManifestCue {
  cueId: string;
  /** 输出时间域；显示窗恒等于 [startMs, endMs)，无 linger */
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
}

export interface RenderManifestCaptions {
  style: "plain";
  cues: RenderManifestCue[];
}

export interface RenderManifestIdentity {
  captionTheme: {
    fontFamily?: string;
    primaryColor: string;
    /** 强调色。字幕不再用它（逐词高亮已删），标题卡的色块还在用 */
    accentColor: string;
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
  /**
   * v3 = 字幕改 cue（v2 spec §2.3）；v1/v2 旧 manifest 进渲染会被 render 侧 zod 拒绝，
   * 拒绝时给人话指路：render/failed 走 `video:reassemble` 回组装重出一份。
   */
  schemaVersion: 3;
  contentId: string;
  timelineRevision: number;
  cutRevision: number;
  transcriptRevision: number;
  /**
   * 字幕文字取自哪一版清洗（转写纠错 spec §1 追溯链）。可缺省：历史成片与没有清洗版的稿件
   * 都没有它，缺省即「烧的是 ASR 原文」。渲染端不消费，它是发布后回答「这版字幕哪来的」的凭证。
   */
  cleanRevision?: number;
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
