/**
 * render-manifest 的**唯一**构造点（v2 spec §4.1「共享同一个 manifest builder」）。
 *
 * 正式成片与门内预览走的是同一段时间映射：段落投影、字幕 cue、总时长全在这里成形，
 * 两者只差「给不给 overlays / 标题卡 / 混过 BGM 的音轨」。第二套时间映射逻辑是
 * 预览与成片漂移的唯一来源，所以这里就是结构性保证（边界 #16）。
 *
 * 本文件零 IO：素材路径、音轨、identity 由调用方解析好再传进来。
 */
import { OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "./timeline-build.js";
import type { CaptionCue } from "./captions.js";
import type {
  OutputMapEntry,
  RenderManifest,
  RenderManifestIdentity,
  RenderManifestOverlay,
} from "./types.js";

export interface RenderManifestInput {
  contentId: string;
  timelineRevision: number;
  cutRevision: number;
  transcriptRevision: number;
  durationMs: number;
  map: OutputMapEntry[];
  arollFile: string;
  /** 有 BGM 时是 master-audio，无 BGM（含预览）时是 anchor */
  audio: { file: string; durationMs: number };
  cues: CaptionCue[];
  /** 预览不传 = 无覆盖轨 */
  overlays?: RenderManifestOverlay[];
  /** 预览不传 = 无标题卡 */
  titleCard?: { text: string; durationMs: number };
  identity: RenderManifestIdentity;
  provenance?: { hasAiClips: boolean; hasClonedVoice: boolean };
}

export function buildRenderManifest(input: RenderManifestInput): RenderManifest {
  return {
    schemaVersion: 3,
    contentId: input.contentId,
    timelineRevision: input.timelineRevision,
    cutRevision: input.cutRevision,
    transcriptRevision: input.transcriptRevision,
    fps: OUTPUT_FPS,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    durationMs: input.durationMs,
    anchorAudio: { file: input.audio.file, durationMs: input.audio.durationMs },
    arollVideo: {
      file: input.arollFile,
      segments: input.map.map(({ sourceStartMs, sourceEndMs, outputStartMs }) => ({
        sourceStartMs,
        sourceEndMs,
        outputStartMs,
      })),
    },
    overlays: input.overlays ?? [],
    captions: { style: "plain", cues: input.cues },
    ...(input.titleCard
      ? { titleCard: { template: "hook-title" as const, text: input.titleCard.text, durationMs: input.titleCard.durationMs } }
      : {}),
    identity: input.identity,
    // V0a 不采购 AI 镜头、不用克隆音色——发布件的 AI 标注读的就是这两个字段
    provenance: input.provenance ?? { hasAiClips: false, hasClonedVoice: false },
  };
}
