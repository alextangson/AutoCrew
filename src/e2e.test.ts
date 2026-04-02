/**
 * End-to-end integration tests — simulates a real user flow through the full plugin.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createContext } from "./runtime/context.js";
import { ToolRunner } from "./runtime/tool-runner.js";
import { EventBus } from "./runtime/events.js";
import { registerAllTools } from "./tools/registry.js";

const TEST_DIR = path.join(os.tmpdir(), `autocrew-e2e-${Date.now()}`);

let runner: ToolRunner;
let eventBus: EventBus;

beforeAll(async () => {
  const ctx = createContext({ data_dir: TEST_DIR });
  eventBus = new EventBus();
  runner = new ToolRunner({ ctx, eventBus });
  registerAllTools(runner);
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("E2E: Init + Onboarding", () => {
  it("init creates directory structure and returns next_step", async () => {
    const result = await runner.execute("autocrew_init", {});
    expect(result.ok).toBe(true);
    expect(result.dataDir).toBe(TEST_DIR);
    expect(result.next_step).toBeDefined();
    expect((result.next_step as any).action).toBe("onboarding");

    const dirs = ["topics", "contents", "covers/templates", "sensitive-words"];
    for (const dir of dirs) {
      const stat = await fs.stat(path.join(TEST_DIR, dir));
      expect(stat.isDirectory()).toBe(true);
    }

    const style = await fs.readFile(path.join(TEST_DIR, "STYLE.md"), "utf-8");
    expect(style).toContain("尚未校准");
  });

  it("init is idempotent", async () => {
    const result = await runner.execute("autocrew_init", {});
    expect(result.ok).toBe(true);
    expect(result.alreadyExisted).toBe(true);
  });

  it("status is exempt from onboarding gate", async () => {
    const result = await runner.execute("autocrew_status", {});
    expect(result.ok).toBe(true);
  });

  it("content tool blocked before profile setup", async () => {
    const result = await runner.execute("autocrew_content", { action: "list" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/onboarding|profile/i);
  });
});

describe("E2E: Profile Setup", () => {
  it("set up complete profile to unblock tools", async () => {
    await fs.writeFile(path.join(TEST_DIR, "creator-profile.json"), JSON.stringify({
      industry: "美食探店",
      platforms: ["xiaohongshu", "douyin"],
      audiencePersona: {
        name: "美食爱好者", age: "20-35", job: "白领",
        painPoints: ["不知道吃什么"], scrollStopTriggers: ["高颜值菜品"],
      },
      writingRules: [],
      styleBoundaries: { never: [], always: [] },
      competitorAccounts: [],
      performanceHistory: [],
      styleCalibrated: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const result = await runner.execute("autocrew_content", { action: "list" });
    expect(result.ok).toBe(true);
  });

  it("pro_status shows profile completeness", async () => {
    const result = await runner.execute("autocrew_pro_status", {});
    expect(result.ok).toBe(true);
    expect(result.profileExists).toBe(true);
    expect(result.styleCalibrated).toBe(true);
    expect((result.missingInfo as string[]).length).toBe(0);
  });
});

describe("E2E: Content Creation Flow", () => {
  let contentId: string;

  it("save a content draft", async () => {
    const result = await runner.execute("autocrew_content", {
      action: "save",
      title: "北京胡同里的宝藏面馆｜人均30吃到撑",
      body: "今天给大家分享一家隐藏在北京胡同里的面馆。这家面馆已经开了20年了。招牌炸酱面，面条劲道，酱料浓郁。人均消费只要30元。#北京美食 #胡同美食",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(true);
    // content-save returns { ok, content } where content.id is the ID
    const content = result.content as any;
    expect(content).toBeDefined();
    expect(content.id).toBeDefined();
    contentId = content.id;
  });

  it("list contents shows the saved draft", async () => {
    const result = await runner.execute("autocrew_content", { action: "list" });
    expect(result.ok).toBe(true);
    const contents = result.contents as any[];
    expect(contents).toBeDefined();
    expect(contents.length).toBeGreaterThanOrEqual(1);
    expect(contents.some((c: any) => c.title?.includes("宝藏面馆"))).toBe(true);
  });

  it("get content by id", async () => {
    const result = await runner.execute("autocrew_content", {
      action: "get",
      id: contentId,
    });
    expect(result.ok).toBe(true);
  });

  it("humanize text directly", async () => {
    const result = await runner.execute("autocrew_humanize", {
      action: "humanize_zh",
      text: "本文将深入探讨北京胡同美食的赋能效应。值得一提的是，这家面馆打通了传统与现代的闭环。",
    });
    expect(result.ok).not.toBe(false);
    expect(result.humanizedText).toBeDefined();
    expect(result.changeCount).toBeDefined();
  });

  it("review content directly", async () => {
    const result = await runner.execute("autocrew_review", {
      action: "full_review",
      text: "今天给大家分享一家面馆。招牌炸酱面很好吃。人均30元。#北京美食",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(true);
  });

  it("pre-publish checklist", async () => {
    const result = await runner.execute("autocrew_pre_publish", {
      action: "check",
      content_id: contentId,
    });
    expect(result.ok).toBe(true);
  });
});

describe("E2E: Topic Management", () => {
  it("create a topic", async () => {
    const result = await runner.execute("autocrew_topic", {
      action: "create",
      title: "2026年北京新开的宝藏面馆盘点",
      description: "盘点北京今年新开的特色面馆",
      tags: ["美食", "北京", "面馆"],
    });
    expect(result.ok).toBe(true);
    // topic-create returns { ok, topic } where topic.id is the ID
    const topic = result.topic as any;
    expect(topic).toBeDefined();
    expect(topic.id).toBeDefined();
  });

  it("list topics", async () => {
    const result = await runner.execute("autocrew_topic", { action: "list" });
    expect(result.ok).toBe(true);
    expect((result.topics as any[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe("E2E: Pipeline & Workflow", () => {
  let workflowId: string;

  it("list templates", async () => {
    const result = await runner.execute("autocrew_pipeline", { action: "templates" });
    expect(result.ok).toBe(true);
    const templates = result.templates as any[];
    expect(templates.length).toBeGreaterThanOrEqual(2);
    expect(templates.some((t: any) => t.id === "xiaohongshu_full")).toBe(true);
    expect(templates.some((t: any) => t.id === "quick_publish")).toBe(true);
  });

  it("create a workflow from template", async () => {
    const result = await runner.execute("autocrew_pipeline", {
      action: "create",
      template: "quick_publish",
    });
    expect(result.ok).toBe(true);
    const workflow = result.workflow as any;
    expect(workflow).toBeDefined();
    expect(workflow.id).toBeDefined();
    workflowId = workflow.id;
  });

  it("get workflow status", async () => {
    const result = await runner.execute("autocrew_pipeline", {
      action: "status",
      id: workflowId,
    });
    expect(result.ok).toBe(true);
  });

  it("list workflows shows created one", async () => {
    const result = await runner.execute("autocrew_pipeline", { action: "list" });
    expect(result.ok).toBe(true);
    expect((result.workflows as any[]).length).toBeGreaterThanOrEqual(1);
  });
});

describe("E2E: Publish Tools (error handling)", () => {
  it("xiaohongshu_publish fails gracefully without cookie", async () => {
    const result = await runner.execute("autocrew_publish", {
      action: "xiaohongshu_publish",
      title: "test",
      description: "test",
      images: ["/tmp/nonexistent.png"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("douyin_publish returns not-yet-implemented", async () => {
    const result = await runner.execute("autocrew_publish", {
      action: "douyin_publish",
      title: "test",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("relay_publish returns info message", async () => {
    const result = await runner.execute("autocrew_publish", {
      action: "relay_publish",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("E2E: Memory", () => {
  it("capture feedback", async () => {
    const result = await runner.execute("autocrew_memory", {
      action: "capture_feedback",
      signal: "general",
      feedback: "写的内容太正式了，需要更口语化",
    });
    expect(result.ok).toBe(true);
  });

  it("get memory after feedback", async () => {
    const result = await runner.execute("autocrew_memory", {
      action: "get_memory",
    });
    expect(result.ok).toBe(true);
    // memory tool returns { ok, memoryPath, content }
    expect(result.content).toBeDefined();
  });
});

describe("E2E: Status Dashboard", () => {
  it("status shows correct counts", async () => {
    const result = await runner.execute("autocrew_status", {});
    expect(result.ok).toBe(true);
    // status returns { topics, contents } as count numbers
    expect(typeof result.topics).toBe("number");
    expect(typeof result.contents).toBe("number");
    expect(result.topics).toBeGreaterThanOrEqual(1);
    expect(result.contents).toBeGreaterThanOrEqual(1);
  });
});

describe("E2E: EventBus Integration", () => {
  it("tool execution emits events", async () => {
    const events: any[] = [];
    const subId = eventBus.on("*", (e) => events.push(e));

    await runner.execute("autocrew_topic", {
      action: "create",
      title: "事件测试选题",
      tags: ["test"],
    });

    eventBus.off(subId);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "tool:pre_execute")).toBe(true);
  });
});
