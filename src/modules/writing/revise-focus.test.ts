import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviseFocus } from "./revise-focus.js";
import { saveContent } from "../../storage/local-store.js";
import { addWritingRule, updateProfile } from "../profile/creator-profile.js";
import type { EngineConfig } from "../../engine/config.js";
import type { LoopOptions, LoopResult, LoopTool } from "../../engine/loop.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-revise-focus-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "sk-test", strongModel: "writer-model", fastModel: "fast-model" }),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const done = (): LoopResult => ({ finalMessage: "done", turns: 2, totalTokens: 42, toolCallCount: 1, stopReason: "no_tool_calls" });

async function mkContent() {
  return saveContent(
    { title: "标题", body: "第一段。\n\n第二段偏书面。\n\n第三段。", platform: "wechat_mp", status: "draft_ready", tags: [] },
    testDir,
  );
}

describe("reviseFocus 的品牌上下文", () => {
  // 改稿与写初稿吃同一块上下文:此前这里只拼全量规则(跨平台污染),受众/风格边界一个字都不给
  it("注入本平台规则+受众+风格边界，别的平台的规则不进上下文", async () => {
    const c = await mkContent();
    await addWritingRule({ rule: "公众号正文用空行分段", source: "user_explicit", confidence: 1, scope: "platform:wechat_mp" }, testDir);
    await addWritingRule({ rule: "小红书标题带 emoji", source: "user_explicit", confidence: 1, scope: "platform:xiaohongshu" }, testDir);
    await updateProfile({ styleBoundaries: { never: ["赋能"], always: ["具体案例"] } }, testDir);

    let systemPrompt = "";
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      systemPrompt = opts.systemPrompt ?? "";
      const submit = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_revision")!;
      await submit.execute({ title: "标题", body: "改过的正文。" });
      return done();
    };
    await reviseFocus(c.id, "口语一点", { scope: "draft" }, testDir, { runLoopImpl });

    expect(systemPrompt).toContain("公众号正文用空行分段");
    expect(systemPrompt).not.toContain("小红书标题带 emoji");
    expect(systemPrompt).toContain("赋能");
    expect(systemPrompt).toContain("具体案例");
  });
});

describe("reviseFocus", () => {
  it("selection scope + clear instruction → returns a revised span only", async () => {
    const c = await mkContent();
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      const submit = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_revision")!;
      expect(submit).toBeDefined();
      await submit.execute({ span: "第二段更口语了。" });
      return done();
    };
    const r = await reviseFocus(c.id, "第二段口语一点", { scope: "selection", selection: "第二段偏书面。" }, testDir, { runLoopImpl });
    expect(r.kind).toBe("revision");
    if (r.kind === "revision") {
      expect(r.span).toBe("第二段更口语了。");
      expect(r.body).toBeUndefined();
      expect(r.title).toBeUndefined();
    }
  });

  it("ambiguous instruction → returns a clarifying question, no revision", async () => {
    const c = await mkContent();
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      const ask = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_question")!;
      expect(ask).toBeDefined();
      await ask.execute({ question: "你说的“更有网感”是指开头更抓人，还是整段口语化？" });
      return done();
    };
    const r = await reviseFocus(c.id, "更有网感", { scope: "selection", selection: "第二段偏书面。" }, testDir, { runLoopImpl });
    expect(r.kind).toBe("question");
    if (r.kind === "question") expect(r.question).toContain("网感");
  });

  it("draft scope + clear instruction → returns full title and body", async () => {
    const c = await mkContent();
    const runLoopImpl = async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
      const submit = (opts.tools ?? []).find((t: LoopTool) => t.name === "submit_revision")!;
      await submit.execute({ title: "新标题", body: "整篇改口语了。" });
      return done();
    };
    const r = await reviseFocus(c.id, "整篇口语一点", { scope: "draft" }, testDir, { runLoopImpl });
    expect(r.kind).toBe("revision");
    if (r.kind === "revision") {
      expect(r.title).toBe("新标题");
      expect(r.body).toBe("整篇改口语了。");
      expect(r.span).toBeUndefined();
    }
  });

  it("throws when the model neither asks nor revises", async () => {
    const c = await mkContent();
    const runLoopImpl = async (): Promise<LoopResult> => done();
    await expect(
      reviseFocus(c.id, "随便改改", { scope: "draft" }, testDir, { runLoopImpl }),
    ).rejects.toThrow();
  });
});
