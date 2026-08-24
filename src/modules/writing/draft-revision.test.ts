import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviseDraft } from "./draft-revision.js";
import { getContent, saveContent } from "../../storage/local-store.js";
import { listDiffs } from "../learnings/diff-tracker.js";
import { addWritingRule } from "../profile/creator-profile.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult, LoopTool } from "../../engine/loop.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-revise-draft-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "sk-test", strongModel: "writer-model", fastModel: "fast-model" }),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("reviseDraft", () => {
  it("updates the same content and records the feedback as a new version", async () => {
    const original = await saveContent(
      {
        title: "旧标题",
        body: "这是偏书面的旧正文。",
        platform: "wechat_mp",
        status: "draft_ready",
        tags: [],
      },
      testDir,
    );

    const runLoopImpl = async (_config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      const submit = (options.tools ?? []).find((tool: LoopTool) => tool.name === "submit_revision");
      expect(submit).toBeDefined();
      await submit!.execute({ title: "新标题", body: "这是更口语、更直接的新正文。" });
      return { finalMessage: "done", turns: 2, totalTokens: 88, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    const result = await reviseDraft(original.id, "口语一点，开头直接说结论", testDir, { runLoopImpl });
    expect(result.content.id).toBe(original.id);
    expect(result.content.title).toBe("新标题");
    expect(result.content.body).toContain("更口语");
    expect(result.content.versions).toHaveLength(2);
    expect(result.content.versions[1].note).toContain("口语一点");
    expect(result.tokensUsed).toBe(88);

    const saved = await getContent(original.id, testDir);
    expect(saved?.body).toBe("这是更口语、更直接的新正文。");
    expect(saved?.versions).toHaveLength(2);
  });

  // 整篇改稿此前完全不记 diff——创作者的修改指令这条最直接的风格信号整个丢了
  it("把修改指令记成 diff（changeType = 创作者原话），供下一次蒸馏消化", async () => {
    const original = await saveContent(
      { title: "旧标题", body: "偏书面的旧正文。", platform: "wechat_mp", status: "draft_ready", tags: [] },
      testDir,
    );
    const runLoopImpl = async (_config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      const submit = (options.tools ?? []).find((tool) => tool.name === "submit_revision")!;
      await submit.execute({ title: "新标题", body: "更口语的新正文。" });
      return { finalMessage: "done", turns: 2, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    await reviseDraft(original.id, "口语一点，开头直接说结论", testDir, { runLoopImpl });

    const diffs = await listDiffs({ contentId: original.id }, testDir);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].field).toBe("body");
    expect(diffs[0].before).toBe("偏书面的旧正文。");
    expect(diffs[0].after).toBe("更口语的新正文。");
    expect(diffs[0].changeType).toBe("口语一点，开头直接说结论");
    expect(diffs[0].platform).toBe("wechat_mp");
  });

  it("品牌上下文与写初稿同源：本平台规则进、别的平台规则不进", async () => {
    const original = await saveContent(
      { title: "标题", body: "原正文", platform: "wechat_mp", status: "draft_ready", tags: [] },
      testDir,
    );
    await addWritingRule({ rule: "公众号正文用空行分段", source: "user_explicit", confidence: 1, scope: "platform:wechat_mp" }, testDir);
    await addWritingRule({ rule: "小红书标题带 emoji", source: "user_explicit", confidence: 1, scope: "platform:xiaohongshu" }, testDir);

    let systemPrompt = "";
    const runLoopImpl = async (_config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      systemPrompt = options.systemPrompt ?? "";
      const submit = (options.tools ?? []).find((tool) => tool.name === "submit_revision")!;
      await submit.execute({ title: "标题", body: "改过的正文" });
      return { finalMessage: "done", turns: 2, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    await reviseDraft(original.id, "口语一点", testDir, { runLoopImpl });
    expect(systemPrompt).toContain("公众号正文用空行分段");
    expect(systemPrompt).not.toContain("小红书标题带 emoji");
  });

  it("改稿失败（模型没交稿）不留 diff：没发生的修改不该变成学习信号", async () => {
    const original = await saveContent(
      { title: "标题", body: "原正文", platform: "wechat_mp", status: "draft_ready", tags: [] },
      testDir,
    );
    const runLoopImpl = async (): Promise<LoopResult> => ({
      finalMessage: "只给了建议", turns: 2, totalTokens: 10, toolCallCount: 0, stopReason: "max_turns",
    });

    await expect(reviseDraft(original.id, "再精炼一点", testDir, { runLoopImpl })).rejects.toThrow();
    expect(await listDiffs({ contentId: original.id }, testDir)).toHaveLength(0);
  });

  it("改过的稿不许再顶着「已 AI 审稿」的徽章：review.status 落 stale（spec §2.7）", async () => {
    const original = await saveContent(
      {
        title: "旧标题",
        body: "旧正文。",
        platform: "wechat_mp",
        status: "draft_ready",
        tags: [],
        review: {
          status: "passed",
          rounds: 0,
          fixed: 0,
          issues: [{ id: "r0-1", severity: "advisory", quote: "旧正文", rule: "结尾升华", instruction: "收具体点" }],
          reviewedAt: "2026-08-23T00:00:00.000Z",
        },
      },
      testDir,
    );

    const runLoopImpl = async (_config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      const submit = (options.tools ?? []).find((tool) => tool.name === "submit_revision")!;
      await submit.execute({ title: "新标题", body: "改过的新正文。" });
      return { finalMessage: "done", turns: 2, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    const result = await reviseDraft(original.id, "口语一点", testDir, { runLoopImpl });
    expect(result.content.review?.status).toBe("stale");
    // 结论本身留着：改稿让它过期，不等于那些问题没被指出过
    expect(result.content.review?.issues).toHaveLength(1);
    expect((await getContent(original.id, testDir))?.review?.status).toBe("stale");
  });

  it("没审过的稿改完也不凭空长出 review 字段", async () => {
    const original = await saveContent(
      { title: "标题", body: "原正文", platform: "wechat_mp", status: "draft_ready", tags: [] },
      testDir,
    );
    const runLoopImpl = async (_config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      const submit = (options.tools ?? []).find((tool) => tool.name === "submit_revision")!;
      await submit.execute({ title: "标题", body: "改过的正文" });
      return { finalMessage: "done", turns: 2, totalTokens: 10, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    const result = await reviseDraft(original.id, "再精炼一点", testDir, { runLoopImpl });
    expect(result.content.review).toBeUndefined();
  });

  it("refuses to claim success when the model returns an unchanged draft", async () => {
    const original = await saveContent(
      { title: "标题", body: "原正文", platform: "wechat_mp", status: "draft_ready", tags: [] },
      testDir,
    );
    const runLoopImpl = async (_config: EngineConfig, options: LoopOptions): Promise<LoopResult> => {
      const submit = (options.tools ?? []).find((tool) => tool.name === "submit_revision")!;
      await submit.execute({ title: original.title, body: original.body });
      return { finalMessage: "done", turns: 2, totalTokens: 20, toolCallCount: 1, stopReason: "no_tool_calls" };
    };

    await expect(reviseDraft(original.id, "再精炼一点", testDir, { runLoopImpl })).rejects.toThrow("完全相同");
    expect((await getContent(original.id, testDir))?.versions).toHaveLength(1);
  });
});
