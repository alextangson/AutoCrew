/**
 * 确定性 timeline 构造（设计 spec §2.5 / 横屏 spec §2.1、§2.3）。
 *
 * 这一层**没有 LLM、没有 IO**：给定同样的选段与槽位，永远算出同样的 timeline。
 * 覆盖轨的智能编排是 P1 剪辑师 agent 的活，它产出的也只是这里的输入，不是这里的替代。
 *
 * 与 `assemble.ts` 的分工：那边管流程与冻结（复检指纹、合音轨、写 manifest），
 * 这边只管「timeline 长什么样」——形状与流程分开，形状才测得动。
 */
import type { AssetRef, OverlayFit, TimelineOverlay, VideoTimeline } from "./types.js";
import { readVersioned, videoDir, writeVersioned } from "./video-store.js";

/** 视频线唯一画幅 = 横屏 1920×1080@30（横屏 spec §0 创始人裁决；竖屏路径已删除，不留开关） */
export const OUTPUT_FPS = 30;
export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;

/** 标题卡时长（横屏 spec §2.3 定值）；成片比它还短就按成片总长走，不出一张盖满全片的卡 */
export const TITLE_CARD_MS = 3000;

/** 人工指定的覆盖轨转场恒 cut；fade 在 registry 里，留给剪辑师 agent 用 */
export const DEFAULT_TRANSITION = "cut";

/**
 * 人确认后的覆盖轨槽位。**按 cutRevision 存**，因为它是这一版剪辑决策的一部分：
 * 覆盖轨用输出域时间，keeps 一改时间轴就全变，钉在 cut 上才不会张冠李戴。
 *
 * 剪辑师 plan 自己的版本号（`revisions.editor`）与它无关——同一版 cut 可以重跑 N 次
 * 剪辑师，但只会有一次「确认」，所以确认产物按 cut 编号恰好一份，与 assemble 的读法对齐。
 */
export interface OverlaySlot {
  kind: "screen" | "image";
  ref: AssetRef;
  outputStartMs: number;
  durationMs: number;
  /** 屏录取源素材的哪一段（横屏 spec §3.3 阻断项）；跨度恒等于 durationMs */
  inMs?: number;
  outMs?: number;
  fit?: OverlayFit;
  /** registry.transitions 之一；不给按 DEFAULT_TRANSITION */
  transition?: string;
}

export function writeOverlaySlots(
  dataDir: string,
  contentId: string,
  cutRevision: number,
  slots: OverlaySlot[],
): Promise<string> {
  return writeVersioned(videoDir(dataDir, contentId), "overlays", cutRevision, slots);
}

/** 没写过覆盖轨 = 没有覆盖轨，不是错误 */
export async function readOverlaySlots(
  dataDir: string,
  contentId: string,
  cutRevision: number,
): Promise<OverlaySlot[]> {
  const slots = await readVersioned<OverlaySlot[]>(videoDir(dataDir, contentId), "overlays", cutRevision);
  return Array.isArray(slots) ? slots : [];
}

/**
 * 人确认后的强调词，与覆盖轨槽位同版本口径（都按 cutRevision）。
 * 单独一份产物而不是塞进 overlays：删光 overlay 只留强调词是常见的合法结果，
 * 两者的存在与否互不牵连。
 */
export function writeEmphasisWords(
  dataDir: string,
  contentId: string,
  cutRevision: number,
  words: string[],
): Promise<string> {
  return writeVersioned(videoDir(dataDir, contentId), "emphasis", cutRevision, words);
}

export async function readEmphasisWords(
  dataDir: string,
  contentId: string,
  cutRevision: number,
): Promise<string[]> {
  const words = await readVersioned<string[]>(videoDir(dataDir, contentId), "emphasis", cutRevision);
  return Array.isArray(words) ? words.filter((w): w is string => typeof w === "string") : [];
}

export interface DeterministicTimelineInput {
  transcriptRevision: number;
  cutRevision: number;
  /** 已登记进素材清单的覆盖轨（assetId 由 registerOverlayAssets 产出） */
  overlays: { assetId: string; slot: OverlaySlot }[];
  /** 片头大字 = `videoKit.coverText`；没有发布件就没有标题卡（合法状态，§2.3） */
  titleText?: string;
  /** 字幕点亮的概念词，数据源是剪辑师 plan 里人留下的那些（横屏 spec §2.7 / §3.5） */
  emphasisWords?: string[];
  /** 成片输出域总长，用来给标题卡封顶——它是盖在开头的覆盖层，不许比片子还长 */
  outputDurationMs?: number;
}

/** 标题卡不前插也不改总时长，所以它最长只能是成片本身（§2.5 语义 + §2.3 时长） */
function titleCardOf(input: DeterministicTimelineInput): VideoTimeline["titleCard"] {
  const text = input.titleText?.trim();
  if (!text) return undefined;
  const cap = input.outputDurationMs ?? TITLE_CARD_MS;
  return { template: "hook-title", text, durationMs: Math.min(TITLE_CARD_MS, cap) };
}

/**
 * timeline 形状是固定的：底轨全程 A-roll + 逐词字幕 + 0-N 个人工覆盖轨 + 可选标题卡。
 */
export function buildDeterministicTimeline(input: DeterministicTimelineInput): VideoTimeline {
  const overlays: TimelineOverlay[] = input.overlays.map(({ assetId, slot }, i) => ({
    clipId: `clip-${String(i + 1).padStart(2, "0")}`,
    outputStartMs: slot.outputStartMs,
    durationMs: slot.durationMs,
    source:
      slot.kind === "screen"
        ? {
            type: "screen",
            assetId,
            ...(slot.inMs !== undefined ? { inMs: slot.inMs } : {}),
            ...(slot.outMs !== undefined ? { outMs: slot.outMs } : {}),
            ...(slot.fit ? { fit: slot.fit } : {}),
          }
        : { type: "image", assetId, ...(slot.fit ? { fit: slot.fit } : {}) },
    transition: slot.transition ?? DEFAULT_TRANSITION,
  }));
  const titleCard = titleCardOf(input);
  const emphasisWords = input.emphasisWords?.filter((w) => w.trim()) ?? [];
  return {
    schemaVersion: 2,
    fps: OUTPUT_FPS,
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    anchor: { kind: "aroll", transcriptRevision: input.transcriptRevision, cutRevision: input.cutRevision },
    base: { type: "aroll" },
    overlays,
    captions: { style: "word-highlight", ...(emphasisWords.length > 0 ? { emphasisWords } : {}) },
    ...(titleCard ? { titleCard } : {}),
    audio: { anchorGainDb: 0 },
  };
}
