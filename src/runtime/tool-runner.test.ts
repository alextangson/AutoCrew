import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRunner, type ToolDefinition } from "../runtime/tool-runner.js";
import { createContext } from "../runtime/context.js";
import { EventBus } from "../runtime/events.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let testDir: string;

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
  const profileDir = path.join(dir, "profiles");
  await fs.mkdir(profileDir, { recursive: true });
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

describe("ToolRunner", () => {
  let runner: ToolRunner;
  let eventBus: EventBus;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-runner-test-"));
    await seedProfile(testDir);
    const ctx = createContext({ data_dir: testDir });
    eventBus = new EventBus();
    runner = new ToolRunner({ ctx, eventBus });
  });

  it("registers and retrieves tools", () => {
    runner.register(makeTool("test_tool"));
    expect(runner.getTool("test_tool")).toBeDefined();
    expect(runner.getTools()).toHaveLength(1);
  });

  it("executes a tool and returns result", async () => {
    runner.register(makeTool("test_tool", { ok: true, value: 42 }));
    const result = await runner.execute("test_tool", {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it("returns error for unknown tool", async () => {
    const result = await runner.execute("nonexistent", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("injects _dataDir via middleware", async () => {
    const tool = makeTool("test_tool");
    runner.register(tool);
    await runner.execute("test_tool", {});
    const passedParams = (tool.execute as any).mock.calls[0][0];
    expect(passedParams._dataDir).toBe(testDir);
  });

  it("catches errors and returns error result", async () => {
    runner.register({
      name: "crash_tool",
      label: "Crash",
      description: "Crashes",
      parameters: { type: "object" as const, properties: {} },
      execute: async () => { throw new Error("boom"); },
    });
    const result = await runner.execute("crash_tool", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("records audit entries", async () => {
    runner.register(makeTool("test_tool"));
    await runner.execute("test_tool", { action: "test" });
    const ctx = runner["ctx"];
    expect(ctx.audit.length).toBeGreaterThanOrEqual(1);
    expect(ctx.audit[0].tool).toBe("test_tool");
    expect(ctx.audit[0].action).toBe("test");
    expect(ctx.audit[0].ok).toBe(true);
    expect(ctx.audit[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks activeContentId in workspace", async () => {
    runner.register(makeTool("autocrew_content", { ok: true, id: "content-123" }));
    await runner.execute("autocrew_content", {});
    const ctx = runner["ctx"];
    expect(ctx.workspace.activeContentId).toBe("content-123");
  });

  it("tracks activeTopicId in workspace", async () => {
    runner.register(makeTool("autocrew_topic", { ok: true, id: "topic-456" }));
    await runner.execute("autocrew_topic", {});
    const ctx = runner["ctx"];
    expect(ctx.workspace.activeTopicId).toBe("topic-456");
  });

  it("emits pre and post events", async () => {
    const handler = vi.fn();
    eventBus.on("*", handler);
    runner.register(makeTool("test_tool"));
    await runner.execute("test_tool", {});
    // Should have pre + post events
    const types = handler.mock.calls.map((c: any) => c[0].type);
    expect(types).toContain("tool:pre_execute");
    expect(types).toContain("tool:post_execute");
  });

  it("emits execute_failed event on error result", async () => {
    const handler = vi.fn();
    eventBus.on("tool:execute_failed", handler);
    runner.register(makeTool("fail_tool", { ok: false, error: "nope" }));
    await runner.execute("fail_tool", {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("injects gemini config for needsGemini tools", async () => {
    const tool: ToolDefinition = {
      ...makeTool("gemini_tool"),
      needsGemini: true,
    };
    runner.register(tool);
    await runner.execute("gemini_tool", {});
    const passedParams = (tool.execute as any).mock.calls[0][0];
    expect("_geminiApiKey" in passedParams).toBe(true);
    expect("_geminiModel" in passedParams).toBe(true);
  });

  it("does NOT inject gemini config for non-gemini tools", async () => {
    const tool = makeTool("normal_tool");
    runner.register(tool);
    await runner.execute("normal_tool", {});
    const passedParams = (tool.execute as any).mock.calls[0][0];
    expect("_geminiApiKey" in passedParams).toBe(false);
  });

  it("onboarding gate blocks tools when no profile exists", async () => {
    // Create a runner with empty dataDir (no profile)
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-empty-"));
    const emptyCtx = createContext({ data_dir: emptyDir });
    const emptyRunner = new ToolRunner({ ctx: emptyCtx, eventBus });

    emptyRunner.register(makeTool("autocrew_content", { ok: true }));
    const result = await emptyRunner.execute("autocrew_content", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("onboarding_required");

    await fs.rm(emptyDir, { recursive: true, force: true });
  });

  it("onboarding gate allows exempt tools without profile", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-empty-"));
    const emptyCtx = createContext({ data_dir: emptyDir });
    const emptyRunner = new ToolRunner({ ctx: emptyCtx, eventBus });

    emptyRunner.register(makeTool("autocrew_init", { ok: true, dataDir: emptyDir }));
    const result = await emptyRunner.execute("autocrew_init", {});
    expect(result.ok).toBe(true);

    await fs.rm(emptyDir, { recursive: true, force: true });
  });

  it("onboarding gate blocks when style not calibrated", async () => {
    const uncalDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-uncal-"));
    const profile = {
      industry: "tech",
      platforms: ["xhs"],
      audiencePersona: { name: "test", age: "25-35", job: "dev" },
      styleCalibrated: false,
      writingRules: [],
      competitorAccounts: [],
      performanceHistory: [],
    };
    await fs.writeFile(path.join(uncalDir, "creator-profile.json"), JSON.stringify(profile));

    const uncalCtx = createContext({ data_dir: uncalDir });
    const uncalRunner = new ToolRunner({ ctx: uncalCtx, eventBus });
    uncalRunner.register(makeTool("autocrew_content", { ok: true }));

    const result = await uncalRunner.execute("autocrew_content", {});
    expect(result.ok).toBe(false);
    // styleCalibrated:false is detected as missing info by detectMissingInfo,
    // so profile_incomplete fires before style_not_calibrated
    expect(["profile_incomplete", "style_not_calibrated"]).toContain(result.error);

    await fs.rm(uncalDir, { recursive: true, force: true });
  });
});
