import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { retrieveKnowledge, knowledgeStatus } from "./knowledge-base.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-knowledge-test-"));
  await fs.mkdir(path.join(testDir, "knowledge"));
  await fs.writeFile(path.join(testDir, "knowledge", "ai-agents.md"), "Agent 的核心是工具调用循环。预算上限很重要。");
  await fs.writeFile(path.join(testDir, "knowledge", "cooking.txt"), "红烧肉要先焯水，冰糖炒糖色。");
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("retrieveKnowledge", () => {
  it("returns excerpts from files matching topic tokens, skips unrelated", async () => {
    const result = await retrieveKnowledge("Agent 工具调用怎么讲", testDir);
    expect(result).not.toBeNull();
    expect(result).toContain("工具调用循环");
    expect(result).not.toContain("红烧肉");
  });

  it("returns null when no knowledge dir or no match", async () => {
    expect(await retrieveKnowledge("量子物理", testDir)).toBeNull();
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-knowledge-empty-"));
    expect(await retrieveKnowledge("任何主题", emptyDir)).toBeNull();
    await fs.rm(emptyDir, { recursive: true, force: true });
  });

  it("caps total excerpt length", async () => {
    await fs.writeFile(path.join(testDir, "knowledge", "big.md"), "Agent " + "知识".repeat(5000));
    const result = await retrieveKnowledge("Agent", testDir, { maxChars: 500 });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(700); // 500 正文 + 头部格式余量
  });
});

describe("knowledgeStatus", () => {
  it("reports dir and file count", async () => {
    const status = await knowledgeStatus(testDir);
    expect(status.count).toBe(2);
    expect(status.dir.endsWith("knowledge")).toBe(true);
  });
});
