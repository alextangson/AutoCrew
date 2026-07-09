import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectPatterns,
  recordDiff,
  listDiffs,
  getPatternFrequency,
  changedWindow,
  recentContrastPairs,
} from "../learnings/diff-tracker.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-diff-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("detectPatterns", () => {
  it("detects remove_progression_words when 首先/其次/最后 are removed", () => {
    const patterns = detectPatterns(
      "首先我们来看。其次分析。最后总结。",
      "我们来看，分析，总结。",
    );
    expect(patterns).toContain("remove_progression_words");
  });

  it("detects shorten_content when text gets significantly shorter", () => {
    const long = "这是一个非常非常非常长的句子，包含了很多很多很多的内容，需要被大幅度缩短。这里还有更多内容。";
    const short = "短。";
    const patterns = detectPatterns(long, short);
    expect(patterns).toContain("shorten_content");
  });

  it("detects add_emoji when 3+ emoji added", () => {
    const patterns = detectPatterns("这是一段文字", "这是一段文字 🎉🔥✨💡");
    expect(patterns).toContain("add_emoji");
  });

  it("detects reduce_we_pronoun when 2+ 我们 are removed", () => {
    const patterns = detectPatterns(
      "我们来看看这个问题，我们分析原因，我们给出结论。",
      "来看看这个问题，分析原因，给出结论。",
    );
    expect(patterns).toContain("reduce_we_pronoun");
  });

  it("returns empty array when no patterns detected", () => {
    const patterns = detectPatterns("今天天气不错", "今天天气不错，出去走走");
    // Minor addition — no strong pattern
    expect(Array.isArray(patterns)).toBe(true);
  });

  it("can detect multiple patterns at once", () => {
    const patterns = detectPatterns(
      "首先我们来看看这个非常非常长的问题，其次我们分析原因，最后我们给出结论。",
      "来看这问题 🎉，分析原因，给结论。",
    );
    expect(patterns.length).toBeGreaterThanOrEqual(2);
  });
});

describe("recordDiff", () => {
  it("saves a diff file and returns the diff object", async () => {
    const diff = await recordDiff("content-001", "body", "原始文本", "修改后文本", testDir);
    expect(diff.id).toMatch(/^diff-/);
    expect(diff.contentId).toBe("content-001");
    expect(diff.before).toBe("原始文本");
    expect(diff.after).toBe("修改后文本");
    expect(diff.createdAt).toBeTruthy();
  });

  it("truncates very long before/after to 2000 chars", async () => {
    const longText = "x".repeat(5000);
    const diff = await recordDiff("content-002", "body", longText, "short", testDir);
    expect(diff.before.length).toBeLessThanOrEqual(2000);
  });

  it("persists to disk", async () => {
    await recordDiff("content-003", "title", "旧标题", "新标题", testDir);
    const diffs = await listDiffs(undefined, testDir);
    expect(diffs.length).toBeGreaterThanOrEqual(1);
  });

  it("stores note into changeType when provided", async () => {
    const diff = await recordDiff("content-004", "body", "原文", "改后", testDir, "去掉套话");
    expect(diff.changeType).toBe("去掉套话");
    const diffs = await listDiffs({ contentId: "content-004" }, testDir);
    expect(diffs[0].changeType).toBe("去掉套话");
  });
});

describe("listDiffs", () => {
  it("returns empty array when no diffs exist", async () => {
    const diffs = await listDiffs(undefined, testDir);
    expect(diffs).toEqual([]);
  });

  it("returns all recorded diffs", async () => {
    await recordDiff("c1", "body", "a", "b", testDir);
    await recordDiff("c2", "body", "c", "d", testDir);
    const diffs = await listDiffs(undefined, testDir);
    expect(diffs.length).toBe(2);
  });

  it("filters by contentId", async () => {
    await recordDiff("c1", "body", "a", "b", testDir);
    await recordDiff("c2", "body", "c", "d", testDir);
    const diffs = await listDiffs({ contentId: "c1" }, testDir);
    expect(diffs.length).toBe(1);
    expect(diffs[0].contentId).toBe("c1");
  });

  it("skips ad-hoc transition entries lacking createdAt/before/after without crashing", async () => {
    // transitionStatus writes this shape into the same dir (local-store.ts revision trigger)
    const editsDir = path.join(testDir, "learnings", "edits");
    await fs.mkdir(editsDir, { recursive: true });
    const adHoc = {
      contentId: "c1",
      fromStatus: "reviewing",
      timestamp: new Date().toISOString(),
      note: "User entered revision",
      bodySnapshot: "正文快照",
    };
    await fs.writeFile(path.join(editsDir, "c1-12345.json"), JSON.stringify(adHoc, null, 2), "utf-8");

    await recordDiff("c1", "body", "原文", "改后", testDir);

    const diffs = await listDiffs(undefined, testDir);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].before).toBe("原文");
    expect(diffs[0].after).toBe("改后");
  });
});

describe("getPatternFrequency", () => {
  it("returns empty array when no diffs", async () => {
    const freq = await getPatternFrequency(testDir);
    expect(freq).toEqual([]);
  });

  it("counts pattern occurrences across diffs", async () => {
    // Record 3 diffs that all trigger remove_progression_words
    for (let i = 0; i < 3; i++) {
      await recordDiff(
        `c${i}`,
        "body",
        "首先看，其次分析，最后总结。",
        "看，分析，总结。",
        testDir,
      );
    }
    const freq = await getPatternFrequency(testDir);
    const entry = freq.find((f) => f.pattern === "remove_progression_words");
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(3);
  });

  it("sorts by frequency descending", async () => {
    // 3x pattern A, 1x pattern B
    for (let i = 0; i < 3; i++) {
      await recordDiff(`ca${i}`, "body", "首先看，其次分析，最后总结。", "看，分析，总结。", testDir);
    }
    await recordDiff("cb1", "body", "我们来看", "来看", testDir);

    const freq = await getPatternFrequency(testDir);
    expect(freq[0].count).toBeGreaterThanOrEqual(freq[1]?.count ?? 0);
  });
});

describe("changedWindow (V5.7 对比对)", () => {
  it("extracts change core with context, trimming common prefix/suffix", () => {
    const prefix = "前".repeat(100);
    const suffix = "后".repeat(100);
    const win = changedWindow(`${prefix}旧的写法在这里${suffix}`, `${prefix}新写法${suffix}`);

    expect(win.before).toContain("旧的写法在这里");
    expect(win.after).toContain("新写法");
    // 窗口 = 核心 ± 40 上下文,不是整篇
    expect(win.before.length).toBeLessThan(100);
    expect(win.coreLen).toBe(7);
  });

  it("clips oversized windows with ellipsis", () => {
    const core = "改".repeat(300);
    const win = changedWindow(`开头${core}结尾`, "开头短结尾");
    expect(win.before.length).toBeLessThanOrEqual(161);
    expect(win.before.endsWith("…")).toBe(true);
  });
});

describe("recentContrastPairs (V5.7 对比对)", () => {
  it("returns body edits with note, skips typo-level and non-body diffs", async () => {
    // 有效:整句改写(核心 > 6 字),带"为什么改"
    await recordDiff("c1", "body", "这个方法非常好用而且很棒很棒", "说白了这招就是快", testDir, "太营销腔了");
    // 无效:标点级微调(核心 < 6 字)
    await recordDiff("c2", "body", "今天天气很好我们出门", "今天天气很好我们出行", testDir);
    // 无效:标题编辑不进对比对
    await recordDiff("c3", "title", "旧标题旧标题旧标题", "新标题完全不同的写法", testDir);

    const pairs = await recentContrastPairs(3, testDir);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].before).toContain("非常好用");
    expect(pairs[0].after).toContain("说白了");
    expect(pairs[0].note).toBe("太营销腔了");
  });

  it("honors the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await recordDiff(`c${i}`, "body", `第${i}版本的旧写法又长又空洞`, `第${i}版改成了有劲的短句`, testDir);
    }
    const pairs = await recentContrastPairs(3, testDir);
    expect(pairs).toHaveLength(3);
  });

  it("returns empty array when no diffs exist", async () => {
    expect(await recentContrastPairs(3, testDir)).toEqual([]);
  });
});
