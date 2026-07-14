import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { suggestImagePositions } from "./suggest-images.js";
import { saveContent, getContent } from "../../storage/local-store.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult } from "../../engine/loop.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-suggest-img-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "sk-test", strongModel: "writer-model", fastModel: "fast-model" }),
  );
});
afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const done = (): LoopResult => ({ finalMessage: "done", turns: 2, totalTokens: 30, toolCallCount: 1, stopReason: "no_tool_calls" });

describe("suggestImagePositions", () => {
  it("inserts markers, saves a new version, reports the added count", async () => {
    const c = await saveContent(
      { title: "T", body: "第一段。\n\n第二段。", platform: "wechat_mp", status: "draft_ready", tags: [] },
      testDir,
    );
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      const submit = (opts.tools ?? []).find((t) => t.name === "submit_body")!;
      await submit.execute({ body: "第一段。\n\n[IMAGE: 图一]\n\n第二段。\n\n[IMAGE: 图二]" });
      return done();
    };
    const r = await suggestImagePositions(c.id, testDir, { runLoopImpl });
    expect(r.added).toBe(2);
    const saved = await getContent(c.id, testDir);
    expect(saved?.body).toContain("[IMAGE: 图一]");
    expect(saved?.versions).toHaveLength(2);
  });

  it("throws when the model adds no new markers", async () => {
    const c = await saveContent(
      { title: "T", body: "只有一段。", platform: "wechat_mp", status: "draft_ready", tags: [] },
      testDir,
    );
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      const submit = (opts.tools ?? []).find((t) => t.name === "submit_body")!;
      await submit.execute({ body: "只有一段。" });
      return done();
    };
    await expect(suggestImagePositions(c.id, testDir, { runLoopImpl })).rejects.toThrow();
  });
});
