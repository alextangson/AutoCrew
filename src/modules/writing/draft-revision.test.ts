import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviseDraft } from "./draft-revision.js";
import { getContent, saveContent } from "../../storage/local-store.js";
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
