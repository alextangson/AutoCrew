import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRunner, type ToolDefinition } from "../runtime/tool-runner.js";
import { createContext } from "../runtime/context.js";
import { EventBus } from "../runtime/events.js";

function makeTool(name: string, result: Record<string, unknown> = { ok: true }): ToolDefinition {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: { type: "object" as const, properties: {} },
    execute: vi.fn(async () => result),
  };
}

describe("ToolRunner", () => {
  let runner: ToolRunner;
  let eventBus: EventBus;

  beforeEach(() => {
    const ctx = createContext({ data_dir: "/tmp/test-autocrew" });
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
    expect(passedParams._dataDir).toBe("/tmp/test-autocrew");
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
});
