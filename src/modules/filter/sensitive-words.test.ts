import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanText, _resetCache } from "../filter/sensitive-words.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-sw-test-"));
  _resetCache();
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  _resetCache();
});

describe("scanText", () => {
  it("returns ok:true and empty hits for clean text", async () => {
    const result = await scanText("今天天气不错，出去走走吧。", undefined, testDir);
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(0);
  });

  it("detects political sensitive words", async () => {
    const result = await scanText("习近平发表讲话", undefined, testDir);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].category).toBeTruthy();
  });

  it("hitCount matches hits array length", async () => {
    const result = await scanText("这是一段普通文字", undefined, testDir);
    expect(result.hitCount).toBe(result.hits.length);
  });

  it("returns a non-empty summary string", async () => {
    const result = await scanText("今天天气不错", undefined, testDir);
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("loads custom words from dataDir", async () => {
    const customPath = path.join(testDir, "sensitive-words", "custom.txt");
    await fs.mkdir(path.dirname(customPath), { recursive: true });
    await fs.writeFile(customPath, "# comment\n自定义敏感词\n", "utf-8");

    _resetCache();
    const result = await scanText("这里有自定义敏感词出现", undefined, testDir);
    const found = result.hits.some((h) => h.word === "自定义敏感词");
    expect(found).toBe(true);
  });

  it("handles empty string without error", async () => {
    const result = await scanText("", undefined, testDir);
    expect(result.ok).toBe(true);
    expect(result.hits).toHaveLength(0);
  });

  it("returns positions array for each hit", async () => {
    const result = await scanText("习近平习近平", undefined, testDir);
    if (result.hits.length > 0) {
      expect(Array.isArray(result.hits[0].positions)).toBe(true);
      expect(result.hits[0].positions.length).toBeGreaterThan(0);
    }
  });

  it("autoFixedText is string or undefined", async () => {
    const result = await scanText("这是一段文字", undefined, testDir);
    expect(result.autoFixedText === undefined || typeof result.autoFixedText === "string").toBe(true);
  });
});
