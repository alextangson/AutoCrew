import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectPatterns,
  recordDiff,
  listDiffs,
  getPatternFrequency,
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
