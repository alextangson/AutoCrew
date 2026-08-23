/**
 * EDL：源时间域 → 输出时间域（设计 spec §2.4）。
 *
 * 剪掉片段后「A-roll 源时间」≠「成片输出时间」，混用就是不可执行的 timeline（codex #1）。
 * 这里是全线唯一的换算入口：**确定性纯函数、零 IO**，timeline / 字幕 / A-roll 切割
 * 三条链路共用同一份 outputMap，谁也不许自己再算一遍。
 */
import type {
  OutputMapEntry,
  TranscriptWord,
  VideoCut,
  VideoTranscript,
} from "./types.js";

/**
 * keep 段**按 transcript 顺序**拼接成输出时间轴。
 *
 * - keeps 的书写顺序无关紧要：顺序一律按 transcript 归一（乱序 keeps 不会产出乱序成片）。
 * - keeps 重复引用同一段只算一次。
 * - 引用不存在的 segmentId 直接抛错：LLM/UI 传错必须打回自纠，绝不静默跳过——
 *   静默跳过 = 用户以为留了那句话、成片里却没有。
 */
export function buildOutputMap(transcript: VideoTranscript, cut: VideoCut): OutputMapEntry[] {
  assertKeepsResolvable(transcript, cut);
  const keeps = new Set(cut.keeps);
  const map: OutputMapEntry[] = [];
  let outputStartMs = 0;
  for (const seg of transcript.segments) {
    if (!keeps.has(seg.id)) continue;
    if (seg.endMs < seg.startMs) {
      throw new Error(
        `分句 ${seg.id} 的时间戳倒挂（${seg.startMs}ms → ${seg.endMs}ms），转写文件已损坏，请重跑 ASR`,
      );
    }
    map.push({
      segmentId: seg.id,
      sourceStartMs: seg.startMs,
      sourceEndMs: seg.endMs,
      outputStartMs,
    });
    outputStartMs += seg.endMs - seg.startMs;
  }
  return map;
}

/** keeps 必须全部能在转写里找到；一次报全部非法 id，不让调用方挤牙膏式修 */
function assertKeepsResolvable(transcript: VideoTranscript, cut: VideoCut): void {
  const known = new Set(transcript.segments.map((s) => s.id));
  const unknown = [...new Set(cut.keeps)].filter((id) => !known.has(id));
  if (unknown.length === 0) return;
  throw new Error(
    `剪辑决策引用了转写里不存在的分句：${unknown.join("、")}` +
      `（转写 v${cut.transcriptRevision} 共 ${transcript.segments.length} 句）`,
  );
}

/** 输出域总时长 = 最后一段的起点 + 它自己的长度；空 keeps → 0 */
export function outputDurationMs(map: OutputMapEntry[]): number {
  if (map.length === 0) return 0;
  const last = map[map.length - 1];
  return last.outputStartMs + (last.sourceEndMs - last.sourceStartMs);
}

/** 投影结果 + 丢弃计数：丢弃必须可数，否则「字幕少了几个词」查无可查 */
export interface WordProjection {
  words: TranscriptWord[];
  /** 跨越 keep 段边界、无法归属到唯一输出位置的词（理论上 ASR 不产出这种） */
  dropped: number;
}

/** 一个 keep 单元投影后的词流；字幕 cue 按单元切分，边界不能在这一步被拍平 */
export interface SegmentWords {
  segmentId: string;
  words: TranscriptWord[];
}

/**
 * 把词级时间戳从源时间域投影到输出时间域，**保留单元边界**。
 * 只投影 keep 段内的词——被剪掉的话不该出现在字幕里。
 *
 * 词级时间戳**不复制进 timeline**（§2.4），渲染前经这里现算，
 * 所以这个函数的正确性由单测锁定，不由肉眼审 JSON 保证。
 */
export function projectWordsBySegment(
  transcript: VideoTranscript,
  map: OutputMapEntry[],
): { segments: SegmentWords[]; dropped: number } {
  const segById = new Map(transcript.segments.map((s) => [s.id, s]));
  const segments: SegmentWords[] = [];
  let dropped = 0;
  for (const entry of map) {
    const seg = segById.get(entry.segmentId);
    if (!seg) {
      // outputMap 与 transcript 对不上：调用方拿错了版本，宁可报错不产错字幕
      throw new Error(`outputMap 引用了转写里不存在的分句 ${entry.segmentId}，两者版本不匹配`);
    }
    const shift = entry.outputStartMs - entry.sourceStartMs;
    const words: TranscriptWord[] = [];
    for (const word of seg.words) {
      if (word.startMs < entry.sourceStartMs || word.endMs > entry.sourceEndMs) {
        dropped += 1;
        continue;
      }
      words.push({ w: word.w, startMs: word.startMs + shift, endMs: word.endMs + shift });
    }
    segments.push({ segmentId: entry.segmentId, words });
  }
  return { segments, dropped };
}

/** 拍平形态（丢弃计数照给）。单元边界要保留请走 projectWordsBySegment */
export function projectWordsWithDropped(
  transcript: VideoTranscript,
  map: OutputMapEntry[],
): WordProjection {
  const { segments, dropped } = projectWordsBySegment(transcript, map);
  return { words: segments.flatMap((s) => s.words), dropped };
}

/** 常用形态：只要词。要丢弃计数走 projectWordsWithDropped */
export function projectWordsToOutput(
  transcript: VideoTranscript,
  map: OutputMapEntry[],
): TranscriptWord[] {
  return projectWordsWithDropped(transcript, map).words;
}
