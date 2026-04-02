import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkflowEngine, type WorkflowDefinition } from "./workflow-engine.js";
import { ToolRunner } from "./tool-runner.js";
import { createContext } from "./context.js";
import { EventBus } from "./events.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let testDir: string;

/** Create a complete profile so onboarding gate doesn't block */
async function seedProfile(dir: string) {
  await fs.mkdir(path.join(dir, "profiles"), { recursive: true });
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

function makeToolRunner(dir: string): ToolRunner {
  const ctx = createContext({ data_dir: dir });
  return new ToolRunner({ ctx, eventBus: new EventBus() });
}

/** A simple 3-step workflow: step_a → step_b (approval) → step_c */
function simpleDefinition(): WorkflowDefinition {
  return {
    id: "test_workflow",
    name: "Test Workflow",
    description: "A test workflow",
    steps: [
      { id: "a", name: "Step A", tool: "tool_a", params: {} },
      { id: "b", name: "Step B", tool: "tool_b", params: {}, requiresApproval: true },
      { id: "c", name: "Step C", tool: "tool_c", params: {} },
    ],
  };
}

describe("WorkflowEngine", () => {
  let runner: ToolRunner;
  let engine: WorkflowEngine;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-wf-test-"));
    await seedProfile(testDir);
    runner = makeToolRunner(testDir);
    engine = new WorkflowEngine(runner, testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("creates and starts a workflow that runs to completion", async () => {
    // Register mock tools
    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true, value: "a_result" })),
    });
    runner.register({
      name: "tool_c",
      label: "C",
      description: "c",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true, value: "c_result" })),
    });

    // No approval step — use a definition without approval
    const def: WorkflowDefinition = {
      id: "simple_no_approval",
      name: "Simple",
      description: "No approvals",
      steps: [
        { id: "a", name: "Step A", tool: "tool_a", params: {} },
        { id: "c", name: "Step C", tool: "tool_c", params: {} },
      ],
    };
    engine.registerDefinition(def);

    const instance = await engine.create("simple_no_approval");
    expect(instance.status).toBe("pending");

    const result = await engine.start(instance.id);
    expect(result.status).toBe("completed");
    expect(result.currentStepIndex).toBe(2);
    expect(result.stepResults).toHaveProperty("a");
    expect(result.stepResults).toHaveProperty("c");
  });

  it("pauses at an approval step", async () => {
    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });
    runner.register({
      name: "tool_b",
      label: "B",
      description: "b",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });
    runner.register({
      name: "tool_c",
      label: "C",
      description: "c",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });

    engine.registerDefinition(simpleDefinition());

    const instance = await engine.create("test_workflow");
    const result = await engine.start(instance.id);

    // Should pause at step_b (index 1) which requires approval
    expect(result.status).toBe("paused");
    expect(result.currentStepIndex).toBe(1);
    // step_a should have executed
    expect(result.stepResults).toHaveProperty("a");
    // step_b should NOT have executed yet
    expect(result.stepResults).not.toHaveProperty("b");
  });

  it("resumes after approval", async () => {
    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });
    runner.register({
      name: "tool_b",
      label: "B",
      description: "b",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });
    runner.register({
      name: "tool_c",
      label: "C",
      description: "c",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });

    engine.registerDefinition(simpleDefinition());

    const instance = await engine.create("test_workflow");
    await engine.start(instance.id);

    // Approve the paused step
    const result = await engine.approve(instance.id);

    // Should run step_c and complete
    expect(result.status).toBe("completed");
    expect(result.stepResults).toHaveProperty("c");
  });

  it("cancels a workflow", async () => {
    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });
    runner.register({
      name: "tool_b",
      label: "B",
      description: "b",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });
    runner.register({
      name: "tool_c",
      label: "C",
      description: "c",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });

    engine.registerDefinition(simpleDefinition());

    const instance = await engine.create("test_workflow");
    await engine.start(instance.id);
    // Workflow is paused at step_b

    const cancelled = await engine.cancel(instance.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("sets status to failed when a step fails", async () => {
    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => ({ ok: false, error: "tool_a broke" })),
    });

    const def: WorkflowDefinition = {
      id: "fail_workflow",
      name: "Fail",
      description: "Fails at step a",
      steps: [{ id: "a", name: "Step A", tool: "tool_a", params: {} }],
    };
    engine.registerDefinition(def);

    const instance = await engine.create("fail_workflow");
    const result = await engine.start(instance.id);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Step A");
    expect(result.error).toContain("tool_a broke");
  });

  it("persists state to disk after each step", async () => {
    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true, data: 42 })),
    });
    runner.register({
      name: "tool_b",
      label: "B",
      description: "b",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });
    runner.register({
      name: "tool_c",
      label: "C",
      description: "c",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });

    engine.registerDefinition(simpleDefinition());
    const instance = await engine.create("test_workflow");
    await engine.start(instance.id);
    // Paused at step_b

    // Read directly from disk
    const filePath = path.join(testDir, "workflows", `${instance.id}.json`);
    const raw = await fs.readFile(filePath, "utf-8");
    const persisted = JSON.parse(raw);

    expect(persisted.id).toBe(instance.id);
    expect(persisted.status).toBe("paused");
    expect(persisted.stepResults).toHaveProperty("a");
  });

  it("lists all workflow instances", async () => {
    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });

    const def: WorkflowDefinition = {
      id: "list_test",
      name: "List Test",
      description: "For listing",
      steps: [{ id: "a", name: "Step A", tool: "tool_a", params: {} }],
    };
    engine.registerDefinition(def);

    await engine.create("list_test");
    await engine.create("list_test");

    const instances = await engine.list();
    expect(instances.length).toBe(2);
  });

  it("retries a failed step when retry config is set", async () => {
    let callCount = 0;
    runner.register({
      name: "flaky_tool",
      label: "Flaky",
      description: "Fails first, succeeds second",
      parameters: {},
      execute: vi.fn(async () => {
        callCount++;
        if (callCount < 2) return { ok: false, error: "transient" };
        return { ok: true, value: "recovered" };
      }),
    });

    const def: WorkflowDefinition = {
      id: "retry_workflow",
      name: "Retry",
      description: "Has retry",
      steps: [
        {
          id: "flaky",
          name: "Flaky Step",
          tool: "flaky_tool",
          params: {},
          retry: { maxAttempts: 3, delayMs: 0 },
        },
      ],
    };
    engine.registerDefinition(def);

    const instance = await engine.create("retry_workflow");
    const result = await engine.start(instance.id);

    expect(result.status).toBe("completed");
    expect(callCount).toBe(2);
  });

  it("resolves parameter references from previous step outputs", async () => {
    const capturedParams: Record<string, unknown>[] = [];

    runner.register({
      name: "producer",
      label: "Producer",
      description: "produces",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true, id: "content-123", title: "Hello" })),
    });
    runner.register({
      name: "consumer",
      label: "Consumer",
      description: "consumes",
      parameters: {},
      execute: vi.fn(async (params: Record<string, unknown>) => {
        capturedParams.push({ ...params });
        return { ok: true };
      }),
    });

    const def: WorkflowDefinition = {
      id: "ref_workflow",
      name: "Ref",
      description: "Has param references",
      steps: [
        { id: "step1", name: "Produce", tool: "producer", params: {} },
        {
          id: "step2",
          name: "Consume",
          tool: "consumer",
          params: { content_id: "${step1.id}", label: "${step1.title}" },
        },
      ],
    };
    engine.registerDefinition(def);

    const instance = await engine.create("ref_workflow");
    await engine.start(instance.id);

    // The consumer should have received resolved params
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0].content_id).toBe("content-123");
    expect(capturedParams[0].label).toBe("Hello");
  });

  it("skips a step when condition evaluates to false", async () => {
    const executedTools: string[] = [];

    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => {
        executedTools.push("tool_a");
        return { ok: true, skip_next: false };
      }),
    });
    runner.register({
      name: "tool_b",
      label: "B",
      description: "b",
      parameters: {},
      execute: vi.fn(async () => {
        executedTools.push("tool_b");
        return { ok: true };
      }),
    });
    runner.register({
      name: "tool_c",
      label: "C",
      description: "c",
      parameters: {},
      execute: vi.fn(async () => {
        executedTools.push("tool_c");
        return { ok: true };
      }),
    });

    const def: WorkflowDefinition = {
      id: "cond_workflow",
      name: "Conditional",
      description: "Has conditions",
      steps: [
        { id: "a", name: "Step A", tool: "tool_a", params: {} },
        { id: "b", name: "Step B", tool: "tool_b", params: {}, condition: "a.skip_next" },
        { id: "c", name: "Step C", tool: "tool_c", params: {} },
      ],
    };
    engine.registerDefinition(def);

    const instance = await engine.create("cond_workflow");
    const result = await engine.start(instance.id);

    expect(result.status).toBe("completed");
    expect(executedTools).toEqual(["tool_a", "tool_c"]);
  });

  it("throws when approving a non-paused workflow", async () => {
    runner.register({
      name: "tool_a",
      label: "A",
      description: "a",
      parameters: {},
      execute: vi.fn(async () => ({ ok: true })),
    });

    const def: WorkflowDefinition = {
      id: "no_pause",
      name: "No Pause",
      description: "Completes immediately",
      steps: [{ id: "a", name: "Step A", tool: "tool_a", params: {} }],
    };
    engine.registerDefinition(def);

    const instance = await engine.create("no_pause");
    await engine.start(instance.id);

    await expect(engine.approve(instance.id)).rejects.toThrow("not paused");
  });

  it("throws when starting a nonexistent workflow", async () => {
    await expect(engine.start("nonexistent")).rejects.toThrow("not found");
  });
});
