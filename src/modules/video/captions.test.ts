/**
 * captions.test.ts —— 字幕 cue 切分的确定性锁（v2 spec §2.1）。
 *
 * 断句是这条线上最容易「看起来差不多其实错了」的一环，所以口径逐条钉死：
 * 切在哪、按什么优先级切、空输入怎么办，全是字面量断言。
 */
import { describe, it, expect } from "vitest";
import {
  CUE_MAX_WIDTH_EM,
  buildCaptionCues,
  estimateWidthEm,
  groupWordsByWidth,
  splitUnitWords,
} from "./captions.js";
import type { OutputMapEntry, TranscriptWord, VideoTranscript } from "./types.js";

const word = (w: string, startMs: number, endMs: number): TranscriptWord => ({ w, startMs, endMs });

/** 每字 200ms、紧挨着排——除非显式给间隙，否则「最大时隙」这条路走不到 */
function chars(text: string, from = 0, step = 200, gapAt?: { index: number; gapMs: number }): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let cursor = from;
  [...text].forEach((c, i) => {
    if (gapAt && i === gapAt.index) cursor += gapAt.gapMs;
    out.push(word(c, cursor, cursor + step));
    cursor += step;
  });
  return out;
}

const text = (words: readonly TranscriptWord[]): string => words.map((w) => w.w).join("");

describe("estimateWidthEm（与 render/src/time.ts 同口径）", () => {
  it("CJK 1em / 数字 0.6em / 拉丁 0.55em / 其余 0.5em", () => {
    expect(estimateWidthEm("今天")).toBe(2);
    expect(estimateWidthEm("12")).toBeCloseTo(1.2, 5);
    expect(estimateWidthEm("ab")).toBeCloseTo(1.1, 5);
    expect(estimateWidthEm(",")).toBe(0.5);
    expect(estimateWidthEm("，")).toBe(1);
    expect(estimateWidthEm("")).toBe(0);
  });
});

describe("splitUnitWords —— 标点 → 最大时隙 → 宽度硬切", () => {
  it("装得下就不切（一个语义单元一屏）", () => {
    const words = chars("今天聊聊怎么把这件事做完");
    expect(splitUnitWords(words)).toHaveLength(1);
  });

  it("优先切标点，且挑最靠中间的那个；切完仍超预算就继续按标点递归", () => {
    // 三个逗号：先切最靠中点的那个，左半仍超预算再切它自己最靠中点的那个
    const unit = chars("一二，三四五六七八，九十一二三四，五六七八");
    expect(splitUnitWords(unit, 8).map(text)).toEqual(["一二，", "三四五六七八，", "九十一二三四，", "五六七八"]);
    // 每块都不带断在标点前的尾巴：标点恒留在前一块末尾
    expect(splitUnitWords(unit, 8).slice(0, 3).every((p) => text(p).endsWith("，"))).toBe(true);
  });

  it("没有标点 → 先切最大词间时隙，剩下的超预算部分再按宽度硬切", () => {
    const unit = chars("一二三四五六七八", 0, 200, { index: 5, gapMs: 900 });
    expect(splitUnitWords(unit, 4).map(text)).toEqual(["一二三四", "五", "六七八"]);
    // 时隙那一刀确实落在停顿处：「六」是停顿之后的第一个字
    expect(splitUnitWords(unit, 6).map(text)).toEqual(["一二三四五", "六七八"]);
  });

  it("既无标点也无时隙 → 宽度预算硬切，切点在超出预算的那个词之前", () => {
    const parts = splitUnitWords(chars("一二三四五六七八"), 3);
    expect(parts.map(text)).toEqual(["一二三", "四五六", "七八"]);
  });

  it("单个词本身超预算 → 不切词，自成一块（交给渲染端下压字号；边界 #7）", () => {
    const parts = splitUnitWords([word("https://example.com/very/long", 0, 2000)], 3);
    expect(parts).toHaveLength(1);
    expect(parts[0]![0]!.w).toContain("example.com");
  });

  it("空输入 / 单词输入不崩", () => {
    expect(splitUnitWords([])).toEqual([[]]);
    expect(splitUnitWords([word("字", 0, 100)], 0.1)).toEqual([[word("字", 0, 100)]]);
  });

  it("默认预算是 40em（≈2 行 × 24em，留出贪心折行的余量）", () => {
    expect(CUE_MAX_WIDTH_EM).toBe(40);
    expect(splitUnitWords(chars("字".repeat(40)))).toHaveLength(1);
    expect(splitUnitWords(chars("字".repeat(41))).length).toBeGreaterThan(1);
  });
});

describe("groupWordsByWidth（origin:raw 的回退，边界 #9）", () => {
  it("按宽度分组", () => {
    expect(groupWordsByWidth(chars("一二三四五"), 3, 10_000).map(text)).toEqual(["一二三", "四五"]);
  });

  it("说得慢时按时长也断一刀（没有语义边界可依）", () => {
    const slow = [word("慢", 0, 2000), word("话", 2000, 4000)];
    expect(groupWordsByWidth(slow, 24, 2500)).toHaveLength(2);
  });

  it("空词流 → 没有块", () => {
    expect(groupWordsByWidth([], 24, 2500)).toEqual([]);
  });
});

describe("buildCaptionCues", () => {
  const map: OutputMapEntry[] = [
    { segmentId: "u1", sourceStartMs: 0, sourceEndMs: 1000, outputStartMs: 0 },
    { segmentId: "u2", sourceStartMs: 5000, sourceEndMs: 6000, outputStartMs: 1000 },
  ];
  const transcript = (segments: VideoTranscript["segments"]): VideoTranscript => ({
    schemaVersion: 1,
    source: "funasr",
    segments,
  });
  const seg = (id: string, startMs: number, words: TranscriptWord[]) => ({
    id,
    text: text(words),
    startMs,
    endMs: startMs + 1000,
    words,
  });

  it("origin=llm：一个单元一屏，时间已投影到输出域，cueId 连号", () => {
    const t = transcript([seg("u1", 0, chars("今天聊", 0, 200)), seg("u2", 5000, chars("这样做", 5000, 200))]);
    const cues = buildCaptionCues({ transcript: t, map, origin: "llm" });
    expect(cues.map((c) => c.cueId)).toEqual(["cue-0001", "cue-0002"]);
    expect(cues[0]).toMatchObject({ startMs: 0, endMs: 600 });
    // 第二段源时间 5000 → 输出域 1000（整体前移 4000ms）
    expect(cues[1]).toMatchObject({ startMs: 1000, endMs: 1600 });
  });

  it("origin=raw：整条词流按宽度分组，单元边界不再是块边界", () => {
    const t = transcript([seg("u1", 0, chars("今天聊", 0, 200)), seg("u2", 5000, chars("这样做", 5000, 200))]);
    const cues = buildCaptionCues({ transcript: t, map, origin: "raw" });
    expect(cues).toHaveLength(1);
    expect(text(cues[0]!.words)).toBe("今天聊这样做");
  });

  // 边界 #8
  it("空 words 的单元产不出 cue，跳过而不是崩", () => {
    const t = transcript([seg("u1", 0, []), seg("u2", 5000, chars("这样做", 5000, 200))]);
    const cues = buildCaptionCues({ transcript: t, map, origin: "llm" });
    expect(cues).toHaveLength(1);
    expect(cues[0]!.cueId).toBe("cue-0001");
  });

  it("全是空白词 → 一个 cue 都没有（该段无字幕，不崩）", () => {
    const t = transcript([seg("u1", 0, [word("  ", 0, 100)]), seg("u2", 5000, [word("", 5000, 5100)])]);
    expect(buildCaptionCues({ transcript: t, map, origin: "llm" })).toEqual([]);
    expect(buildCaptionCues({ transcript: t, map, origin: "raw" })).toEqual([]);
  });

  it("cue 之间不重叠（渲染端同一时刻只可能命中一块）", () => {
    const t = transcript([seg("u1", 0, chars("一".repeat(60), 0, 16)), seg("u2", 5000, chars("二二二", 5000, 200))]);
    const cues = buildCaptionCues({ transcript: t, map, origin: "llm" });
    expect(cues.length).toBeGreaterThan(2);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.startMs).toBeGreaterThanOrEqual(cues[i - 1]!.endMs);
    }
  });

  it("确定性：同样的输入两次得到一模一样的 cues", () => {
    const t = transcript([seg("u1", 0, chars("今天，聊聊怎么把这件事做完", 0, 60))]);
    const a = buildCaptionCues({ transcript: t, map: [map[0]!], origin: "llm" });
    const b = buildCaptionCues({ transcript: t, map: [map[0]!], origin: "llm" });
    expect(a).toEqual(b);
  });
});
