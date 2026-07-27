/**
 * output-map.test.ts —— 双时间域换算（spec §2.4）。
 * 纯函数零 IO：源时间域与输出时间域一旦混用，整条 timeline 不可执行（codex #1），
 * 所以边界（空 keeps / 单段 / 全 keep / 乱序 / 非法引用）在这里必须炸。
 */
import { describe, it, expect } from "vitest";
import {
  buildOutputMap,
  outputDurationMs,
  projectWordsToOutput,
  projectWordsWithDropped,
} from "./output-map.js";
import type { TranscriptSegment, VideoCut, VideoTranscript } from "./types.js";

function seg(id: string, startMs: number, endMs: number, words: string[] = []): TranscriptSegment {
  const step = words.length > 0 ? Math.floor((endMs - startMs) / words.length) : 0;
  return {
    id,
    text: words.join(""),
    startMs,
    endMs,
    words: words.map((w, i) => ({
      w,
      startMs: startMs + i * step,
      endMs: startMs + (i + 1) * step,
    })),
  };
}

/** s1 0-1000 / s2 1000-2500 / s3 3000-4000——s2 与 s3 之间**故意留空档**，
 *  只有真的做了输出域压缩，全 keep 的总长才会是 3500 而不是 4000 */
function transcript(): VideoTranscript {
  return {
    schemaVersion: 1,
    source: "funasr",
    segments: [
      seg("s1", 0, 1000, ["大", "家", "好"]),
      seg("s2", 1000, 2500, ["今", "天"]),
      seg("s3", 3000, 4000, ["讲", "个", "事"]),
    ],
  };
}

function cut(keeps: string[]): VideoCut {
  return { transcriptRevision: 1, keeps, flags: [], origin: "human" };
}

describe("buildOutputMap", () => {
  it("空 keeps：输出映射为空，总时长 0（全删是合法结果，不是错误）", () => {
    const map = buildOutputMap(transcript(), cut([]));
    expect(map).toEqual([]);
    expect(outputDurationMs(map)).toBe(0);
  });

  it("单段：输出起点归零，源起点原样保留", () => {
    const map = buildOutputMap(transcript(), cut(["s2"]));
    expect(map).toEqual([{ segmentId: "s2", sourceStartMs: 1000, sourceEndMs: 2500, outputStartMs: 0 }]);
    expect(outputDurationMs(map)).toBe(1500);
  });

  it("全 keep：段间空档被压缩掉，总时长 = 各段长度之和", () => {
    const map = buildOutputMap(transcript(), cut(["s1", "s2", "s3"]));
    expect(map.map((e) => e.outputStartMs)).toEqual([0, 1000, 2500]);
    expect(outputDurationMs(map)).toBe(3500);
  });

  it("乱序 keeps：一律按 transcript 顺序归一（不会剪出倒放的成片）", () => {
    const shuffled = buildOutputMap(transcript(), cut(["s3", "s1", "s2"]));
    const ordered = buildOutputMap(transcript(), cut(["s1", "s2", "s3"]));
    expect(shuffled).toEqual(ordered);
  });

  it("重复 keeps 只算一次", () => {
    const map = buildOutputMap(transcript(), cut(["s1", "s1", "s1"]));
    expect(map).toHaveLength(1);
    expect(outputDurationMs(map)).toBe(1000);
  });

  it("跳段 keep：中间被剪掉的段不占输出时间", () => {
    const map = buildOutputMap(transcript(), cut(["s1", "s3"]));
    expect(map).toEqual([
      { segmentId: "s1", sourceStartMs: 0, sourceEndMs: 1000, outputStartMs: 0 },
      { segmentId: "s3", sourceStartMs: 3000, sourceEndMs: 4000, outputStartMs: 1000 },
    ]);
  });

  it("非法 segmentId：一次报全部，错误里带得出是哪几个", () => {
    expect(() => buildOutputMap(transcript(), cut(["s1", "s9", "s404"]))).toThrow(/s9.*s404|s404.*s9/);
    expect(() => buildOutputMap(transcript(), cut(["s9"]))).toThrow(/不存在的分句/);
  });

  it("转写时间戳倒挂：直接炸，不产出负长度片段", () => {
    const broken = transcript();
    broken.segments[0] = { ...broken.segments[0], startMs: 900, endMs: 100 };
    expect(() => buildOutputMap(broken, cut(["s1"]))).toThrow(/倒挂/);
  });
});

describe("projectWordsToOutput", () => {
  it("只投影 keep 段内的词，位移 = 输出起点 - 源起点", () => {
    const t = transcript();
    const map = buildOutputMap(t, cut(["s2", "s3"]));
    const words = projectWordsToOutput(t, map);
    expect(words.map((w) => w.w)).toEqual(["今", "天", "讲", "个", "事"]);
    // s2 起点 1000 → 输出 0；s3 起点 3000 → 输出 1500
    expect(words[0]).toEqual({ w: "今", startMs: 0, endMs: 750 });
    expect(words[2].startMs).toBe(1500);
  });

  it("被剪掉的段里的词一个都不出现", () => {
    const t = transcript();
    const words = projectWordsToOutput(t, buildOutputMap(t, cut(["s1"])));
    expect(words.map((w) => w.w)).toEqual(["大", "家", "好"]);
  });

  it("空 map → 空词表", () => {
    expect(projectWordsToOutput(transcript(), [])).toEqual([]);
  });

  it("越段词被丢弃且可数（理论不存在，出现即 ASR 异常）", () => {
    const t = transcript();
    t.segments[0].words.push({ w: "溢", startMs: 900, endMs: 1200 });
    const { words, dropped } = projectWordsWithDropped(t, buildOutputMap(t, cut(["s1"])));
    expect(dropped).toBe(1);
    expect(words.map((w) => w.w)).toEqual(["大", "家", "好"]);
  });

  it("map 与 transcript 版本对不上：报错，不产错字幕", () => {
    const t = transcript();
    const alien = [{ segmentId: "s404", sourceStartMs: 0, sourceEndMs: 100, outputStartMs: 0 }];
    expect(() => projectWordsToOutput(t, alien)).toThrow(/版本不匹配/);
  });
});
