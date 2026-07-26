import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gateTopicCandidate, saveRejects } from "./intake-gate.js";
import type { TopicCandidate } from "./intake-gate.js";
import { saveTopic, listTopics, getTopic, softDeleteTopic } from "../../storage/local-store.js";

let testDir: string;

function candidate(over: Partial<TopicCandidate> = {}): TopicCandidate {
  return {
    title: "AI Agent 调试有可视化工具了",
    summary: "一款面向 AI Agent 的可视化调试工具发布。",
    source: "inbox:telegram",
    reason: "收件箱 · 转发 · 正中调试痛点",
    link: "https://a.example/1",
    ...over,
  };
}

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-gate-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("gateTopicCandidate — happy path", () => {
  it("saves the candidate and passes reason/link/summary/angle through", async () => {
    const result = await gateTopicCandidate(candidate({ angle: "实测首个调试流程" }), testDir);

    expect(result).toEqual({ saved: true, topicId: expect.stringMatching(/^topic-/) });
    if (!result.saved) throw new Error("unreachable");
    const topic = await getTopic(result.topicId, testDir);
    expect(topic).toMatchObject({
      title: "AI Agent 调试有可视化工具了",
      description: "一款面向 AI Agent 的可视化调试工具发布。",
      reason: "收件箱 · 转发 · 正中调试痛点",
      link: "https://a.example/1",
      source: "inbox:telegram",
      angles: ["实测首个调试流程"],
      tags: ["inbox"],
    });
  });

  it("omits link and angles when the candidate has none", async () => {
    const result = await gateTopicCandidate(
      { title: "纯文字灵感", summary: "创始人随手记的一句", source: "inbox:telegram", reason: "收件箱 · 转发" },
      testDir,
    );

    expect(result.saved).toBe(true);
    const [topic] = await listTopics(testDir);
    expect(topic.link).toBeUndefined();
    expect(topic.angles).toBeUndefined();
  });
});

describe("gateTopicCandidate — duplicate", () => {
  it("blocks a title already in the topics library and reports the existing id", async () => {
    const existing = await saveTopic(
      { title: "AI Agent 调试有可视化工具了", description: "d", tags: [] },
      testDir,
    );

    const result = await gateTopicCandidate(candidate({ link: "https://other.example/9" }), testDir);

    expect(result).toEqual({ saved: false, code: "duplicate", existingId: existing.id });
    expect(await listTopics(testDir)).toHaveLength(1);
  });

  it("blocks a link already in the trash — deleted ideas stay dead", async () => {
    const trashed = await saveTopic(
      { title: "别的标题", description: "d", tags: [], link: "https://a.example/1" },
      testDir,
    );
    await softDeleteTopic(trashed.id, testDir);

    const result = await gateTopicCandidate(candidate(), testDir);

    expect(result).toEqual({ saved: false, code: "duplicate", existingId: trashed.id });
    expect(await listTopics(testDir)).toHaveLength(0);
  });

  it("second submission of the same link is a duplicate of the first", async () => {
    const first = await gateTopicCandidate(candidate(), testDir);
    const second = await gateTopicCandidate(candidate({ title: "同一条链接换个标题" }), testDir);

    expect(first.saved).toBe(true);
    if (!first.saved) throw new Error("unreachable");
    expect(second).toEqual({ saved: false, code: "duplicate", existingId: first.topicId });
    expect(await listTopics(testDir)).toHaveLength(1);
  });
});

describe("gateTopicCandidate — reject memory", () => {
  it("blocks a candidate rejected within the 7-day window", async () => {
    await saveRejects(
      [{ title: "AI Agent 调试有可视化工具了", link: "https://a.example/1", at: new Date().toISOString() }],
      testDir,
    );

    const result = await gateTopicCandidate(candidate(), testDir);

    expect(result).toEqual({ saved: false, code: "reject_memory" });
    expect(await listTopics(testDir)).toHaveLength(0);
  });

  it("blocks on a link match even when the title differs", async () => {
    await saveRejects(
      [{ title: "当时的标题", link: "https://a.example/1", at: new Date().toISOString() }],
      testDir,
    );

    const result = await gateTopicCandidate(candidate({ title: "换了个说法的标题" }), testDir);

    expect(result).toEqual({ saved: false, code: "reject_memory" });
  });

  it("lets the candidate through once the reject entry is older than 7 days", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    await saveRejects(
      [{ title: "AI Agent 调试有可视化工具了", link: "https://a.example/1", at: eightDaysAgo }],
      testDir,
    );

    const result = await gateTopicCandidate(candidate(), testDir);

    expect(result.saved).toBe(true);
    expect(await listTopics(testDir)).toHaveLength(1);
  });
});
