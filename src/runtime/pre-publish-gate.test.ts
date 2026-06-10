import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRunner, type ToolDefinition } from "./tool-runner.js";
import { createContext } from "./context.js";
import { executePrePublish, type PrePublishResult } from "../tools/pre-publish.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../tools/pre-publish.js", () => ({
  executePrePublish: vi.fn(),
}));

const mockCheck = vi.mocked(executePrePublish);

function makeTool(name: string, result: Record<string, unknown> = { ok: true }): ToolDefinition {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: { type: "object" as const, properties: {} },
    execute: vi.fn(async () => result),
  };
}

/** Create a complete profile so onboarding gate doesn't block */
async function seedProfile(dir: string) {
  const profile = {
    industry: "tech",
    platforms: ["xhs"],
    audiencePersona: { name: "test", age: "25-35", job: "dev" },
    styleCalibrated: true,
    writingRules: [],
    competitorAccounts: [],
    performanceHistory: [],
  };
  await fs.writeFile(path.join(dir, "creator-profile.json"), JSON.stringify(profile));
}

function passedCheck(): PrePublishResult {
  return {
    ok: true,
    contentId: "c-1",
    platform: "xhs",
    checks: [],
    allPassed: true,
    passCount: 6,
    failCount: 0,
    summary: "🟢 全部通过，可以发布！",
  };
}

function failedCheck(): PrePublishResult {
  return {
    ok: true,
    contentId: "c-1",
    platform: "xhs",
    checks: [{ name: "Hashtags", status: "fail", detail: "无标签" }],
    allPassed: false,
    passCount: 5,
    failCount: 1,
    summary: "🔴 1 项需要关注（1 项未通过），请先修复再发布。",
  };
}

describe("prePublishGateMiddleware", () => {
  let runner: ToolRunner;
  let testDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-prepub-test-"));
    await seedProfile(testDir);
    const ctx = createContext({ data_dir: testDir });
    runner = new ToolRunner({ ctx });
  });

  it("blocks autocrew_publish when pre-publish checks fail", async () => {
    mockCheck.mockResolvedValue(failedCheck());
    const tool = makeTool("autocrew_publish");
    runner.register(tool);

    const result = await runner.execute("autocrew_publish", {
      action: "clipboard",
      content_id: "c-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("pre_publish_check_failed");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(mockCheck).toHaveBeenCalledWith(
      expect.objectContaining({ action: "check", content_id: "c-1", _dataDir: testDir }),
    );
  });

  it("allows autocrew_publish when all checks pass", async () => {
    mockCheck.mockResolvedValue(passedCheck());
    const tool = makeTool("autocrew_publish", { ok: true, data: "formatted" });
    runner.register(tool);

    const result = await runner.execute("autocrew_publish", {
      action: "clipboard",
      content_id: "c-1",
    });

    expect(result.ok).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it("bypasses the gate when force=true", async () => {
    mockCheck.mockResolvedValue(failedCheck());
    const tool = makeTool("autocrew_publish");
    runner.register(tool);

    const result = await runner.execute("autocrew_publish", {
      action: "clipboard",
      content_id: "c-1",
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("skips the gate for confirm_published (content already out)", async () => {
    mockCheck.mockResolvedValue(failedCheck());
    const tool = makeTool("autocrew_publish");
    runner.register(tool);

    const result = await runner.execute("autocrew_publish", {
      action: "confirm_published",
      content_id: "c-1",
    });

    expect(result.ok).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("blocks when the checker returns an error result (fail closed)", async () => {
    mockCheck.mockResolvedValue({ ok: false, error: "Content c-1 not found" });
    const tool = makeTool("autocrew_publish");
    runner.register(tool);

    const result = await runner.execute("autocrew_publish", {
      action: "clipboard",
      content_id: "c-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("pre_publish_check_failed");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("blocks when the checker throws (fail closed)", async () => {
    mockCheck.mockRejectedValue(new Error("disk on fire"));
    const tool = makeTool("autocrew_publish");
    runner.register(tool);

    const result = await runner.execute("autocrew_publish", {
      action: "clipboard",
      content_id: "c-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("pre_publish_check_failed");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("allows wechat_mp_draft without content_id (unmanaged article_path flow)", async () => {
    mockCheck.mockResolvedValue(failedCheck());
    const tool = makeTool("autocrew_publish");
    runner.register(tool);

    const result = await runner.execute("autocrew_publish", {
      action: "wechat_mp_draft",
      article_path: "/tmp/article.md",
    });

    expect(result.ok).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("does not gate other tools", async () => {
    mockCheck.mockResolvedValue(failedCheck());
    const tool = makeTool("autocrew_content");
    runner.register(tool);

    const result = await runner.execute("autocrew_content", {
      action: "save",
      content_id: "c-1",
    });

    expect(result.ok).toBe(true);
    expect(mockCheck).not.toHaveBeenCalled();
  });
});
