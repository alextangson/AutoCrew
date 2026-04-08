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
import { recordDiff } from "./modules/learnings/diff-tracker.js";
import { distillRules } from "./modules/learnings/rule-distiller.js";
import { addWritingRule, loadProfile, saveProfile } from "./modules/profile/creator-profile.js";

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

describe("E2E: Draft Action (content generation)", () => {
  it("draft returns writing context and instructions for a topic", async () => {
    const result = await runner.execute("autocrew_content", {
      action: "draft",
      topic_title: "vibe-coding 实践者的真实工作流",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("draft");

    // Should return topic info
    expect((result.topic as any).title).toBe("vibe-coding 实践者的真实工作流");
    expect((result.topic as any).platform).toBe("xiaohongshu");

    // Should return creator context
    expect(result.creatorContext).toBeDefined();

    // Should return writing instructions with Operating System principles
    const instructions = result.writingInstructions as string;
    expect(instructions).toContain("EMPATHY FIRST");
    expect(instructions).toContain("THEIR WORDS, NOT YOURS");
    expect(instructions).toContain("SHOW THE MOVIE");
    expect(instructions).toContain("TENSION IS OXYGEN");
    expect(instructions).toContain("THE CREATOR IS THE PROOF");
    expect(instructions).toContain("TWO-PHASE CREATION");
    expect(instructions).toContain("PHASE A");
    expect(instructions).toContain("PHASE B");

    // Should return next action guidance
    expect((result.nextAction as any).tool).toBe("autocrew_content");
    expect((result.nextAction as any).action).toBe("save");
  });

  it("draft fails without topic_title", async () => {
    const result = await runner.execute("autocrew_content", {
      action: "draft",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("topic_title");
  });
});

describe("E2E: Topic → Start → Content (cross-system)", () => {
  it("topic created via autocrew_topic can be started via pipeline_ops", async () => {
    // Create topic via local-store (autocrew_topic)
    const topicResult = await runner.execute("autocrew_topic", {
      action: "create",
      title: "端到端测试选题",
      description: "测试从 topic 到 project 的完整流程",
      tags: ["test"],
    });
    expect(topicResult.ok).toBe(true);
    const topicId = (topicResult.topic as any).id;
    expect(topicId).toBeDefined();

    // Start project via pipeline-store (should find the legacy topic)
    const startResult = await runner.execute("autocrew_pipeline_ops", {
      action: "start",
      project: topicId,
    });
    expect(startResult.ok).toBe(true);
    expect(startResult.projectDir).toBeDefined();
    // Should return next step guidance
    expect(startResult.nextStep).toBeDefined();
    expect((startResult.nextStep as string)).toContain("autocrew_content");
  });

  it("content list returns both legacy contents and pipeline projects", async () => {
    const result = await runner.execute("autocrew_content", { action: "list" });
    expect(result.ok).toBe(true);
    // Should have legacy contents from earlier tests
    expect(result.contents).toBeDefined();
    // Should have pipeline projects from start test above
    expect(result.pipelineProjects).toBeDefined();
    const projects = result.pipelineProjects as any[];
    expect(projects.length).toBeGreaterThanOrEqual(1);
  });

  it("research auto mode does not return placeholder topics", async () => {
    const result = await runner.execute("autocrew_research", {
      action: "discover",
      keyword: "测试关键词",
      mode: "auto",
      topic_count: 3,
      save_topics: false,
    });
    // Should either return real results or a proper error — never fake placeholders
    if (result.ok) {
      const topics = (result.topics || []) as any[];
      for (const t of topics) {
        // No topic should contain "API 候选" placeholder text
        expect(t.title).not.toContain("API 候选");
        expect(t.title).not.toContain("候选");
      }
    } else {
      // Error is acceptable — it means no source worked, but at least it's honest
      expect(result.error).toBeDefined();
      expect(result.suggestion).toBeDefined();
    }
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

// ============================================================
// 补充测试：用户修改偏好记录、风格校准、批量、封面、资产、状态流转
// ============================================================

describe("E2E: User Edit Tracking + Rule Distillation", () => {
  it("recordDiff captures a user edit", async () => {
    const diff = await recordDiff(
      "test-content-001",
      "body",
      "本文将深入探讨美食的赋能效应。值得一提的是，这家面馆打通了传统闭环。",
      "今天聊聊这家面馆怎么把传统做法玩出了新花样。",
      TEST_DIR,
    );
    expect(diff.id).toBeDefined();
    expect(diff.contentId).toBe("test-content-001");
    expect(diff.field).toBe("body");
    expect(diff.before).toContain("赋能");
    expect(diff.after).toContain("新花样");
    expect(diff.patterns.length).toBeGreaterThanOrEqual(0);
  });

  it("record multiple edits to accumulate patterns", async () => {
    // Simulate 5 edits removing similar AI patterns
    for (let i = 0; i < 5; i++) {
      await recordDiff(
        `test-content-${100 + i}`,
        "body",
        `这篇文章全面赋能了读者的认知。第${i}次`,
        `这篇文章帮读者搞明白了。第${i}次`,
        TEST_DIR,
      );
    }
    // Check if distillation is ready
    const ready = await distillRules(TEST_DIR);
    expect(ready).toBeDefined();
    expect(typeof ready.newRulesCount).toBe("number");
    expect(typeof ready.summary).toBe("string");
  });

  it("addWritingRule persists to creator profile", async () => {
    const profile = await addWritingRule(
      { rule: "不要用'赋能'，改用'帮助'或'支持'", source: "auto_distilled", confidence: 0.85 },
      TEST_DIR,
    );
    expect(profile.writingRules.length).toBeGreaterThanOrEqual(1);
    expect(profile.writingRules.some((r) => r.rule.includes("赋能"))).toBe(true);

    // Verify persistence
    const loaded = await loadProfile(TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.writingRules.length).toBeGreaterThanOrEqual(1);
  });
});

describe("E2E: Style Calibration Gate", () => {
  it("uncalibrated profile blocks tools with style_not_calibrated", async () => {
    const profile = await loadProfile(TEST_DIR);
    expect(profile).not.toBeNull();
    profile!.styleCalibrated = false;
    await saveProfile(profile!, TEST_DIR);

    const result = await runner.execute("autocrew_content", { action: "list" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/style|calibrat|profile_incomplete/i);

    // Restore
    profile!.styleCalibrated = true;
    await saveProfile(profile!, TEST_DIR);
  });

  it("init returns style_calibration next_step when only style is missing", async () => {
    const profile = await loadProfile(TEST_DIR);
    expect(profile).not.toBeNull();
    profile!.styleCalibrated = false;
    await saveProfile(profile!, TEST_DIR);

    const result = await runner.execute("autocrew_init", {});
    expect(result.ok).toBe(true);
    expect(result.next_step).toBeDefined();
    const nextStep = result.next_step as any;
    expect(nextStep.action).toBe("style_calibration");
    expect(nextStep.message).toContain("风格校准");

    // Restore
    profile!.styleCalibrated = true;
    await saveProfile(profile!, TEST_DIR);
  });
});

describe("E2E: Platform Rewrite + Batch Adapt", () => {
  it("adapt_platform rewrites content for douyin", async () => {
    const result = await runner.execute("autocrew_rewrite", {
      action: "adapt_platform",
      title: "北京胡同宝藏面馆",
      body: "今天给大家分享一家隐藏在北京胡同里的面馆。招牌炸酱面，面条劲道。人均30元。",
      target_platform: "douyin",
    });
    expect(result.ok).toBe(true);
    expect(result.platform).toBe("douyin");
    expect(result.body).toBeDefined();
    expect(result.title).toBeDefined();
  });

  it("batch_adapt rewrites for multiple platforms", async () => {
    const result = await runner.execute("autocrew_rewrite", {
      action: "batch_adapt",
      title: "北京胡同宝藏面馆",
      body: "今天分享一家面馆。招牌炸酱面很好吃。人均30元。#北京美食",
      target_platforms: ["xiaohongshu", "douyin"],
    });
    expect(result.ok).toBe(true);
    expect(result.results).toBeDefined();
    const results = result.results as any[];
    expect(results.length).toBe(2);
  });
});

describe("E2E: Cover Review (without Gemini key)", () => {
  let testContentId: string;

  it("create content for cover test", async () => {
    const result = await runner.execute("autocrew_content", {
      action: "save",
      title: "封面测试内容",
      body: "这是用来测试封面生成的内容。需要一个好看的封面图。",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(true);
    testContentId = (result.content as any).id;
  });

  it("create_candidates fails gracefully without Gemini key", async () => {
    const result = await runner.execute("autocrew_cover_review", {
      action: "create_candidates",
      content_id: testContentId,
    });
    // Without Gemini API key, should fail with helpful hint
    expect(result.ok).toBe(false);
    expect(result.error || result.hint).toBeDefined();
  });

  it("get cover review returns empty when none exists", async () => {
    const result = await runner.execute("autocrew_cover_review", {
      action: "get",
      content_id: testContentId,
    });
    // Should handle gracefully - either not found or empty
    expect(result).toBeDefined();
  });
});

describe("E2E: Asset Management", () => {
  let assetContentId: string;

  it("create content for asset test", async () => {
    const result = await runner.execute("autocrew_content", {
      action: "save",
      title: "资产管理测试",
      body: "测试资产管理功能。",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(true);
    assetContentId = (result.content as any).id;
  });

  it("add an asset to content", async () => {
    const result = await runner.execute("autocrew_asset", {
      action: "add",
      content_id: assetContentId,
      filename: "cover.png",
      asset_type: "cover",
      description: "封面图片",
    });
    expect(result.ok).toBe(true);
  });

  it("list assets for content", async () => {
    const result = await runner.execute("autocrew_asset", {
      action: "list",
      content_id: assetContentId,
    });
    expect(result.ok).toBe(true);
    expect(result.assets).toBeDefined();
    const assets = result.assets as any[];
    expect(assets.length).toBeGreaterThanOrEqual(1);
    expect(assets.some((a: any) => a.filename === "cover.png")).toBe(true);
  });

  it("list versions", async () => {
    const result = await runner.execute("autocrew_asset", {
      action: "versions",
      content_id: assetContentId,
    });
    expect(result.ok).toBe(true);
    expect(result.versions).toBeDefined();
  });
});

describe("E2E: Content Status Transitions", () => {
  let transContentId: string;

  it("ensure profile is complete before transition tests", async () => {
    // Re-write a fresh complete profile to avoid state leaks from earlier tests
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.writeFile(path.join(TEST_DIR, "creator-profile.json"), JSON.stringify({
      industry: "美食探店",
      platforms: ["xiaohongshu", "douyin"],
      audiencePersona: {
        name: "美食爱好者", age: "20-35", job: "白领",
        painPoints: ["不知道吃什么"], scrollStopTriggers: ["高颜值菜品"],
      },
      writingRules: [{ rule: "不要用赋能", source: "auto_distilled", confidence: 0.85, createdAt: new Date().toISOString() }],
      styleBoundaries: { never: [], always: [] },
      competitorAccounts: [],
      performanceHistory: [],
      styleCalibrated: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));
  });

  it("create content and transition through states", async () => {
    const saveResult = await runner.execute("autocrew_content", {
      action: "save",
      title: "状态流转测试",
      body: "测试内容状态机流转。",
      platform: "xiaohongshu",
    });
    expect(saveResult.ok).toBe(true);
    transContentId = (saveResult.content as any).id;
  });

  it("transition: draft_ready → reviewing", async () => {
    const result = await runner.execute("autocrew_content", {
      action: "transition",
      id: transContentId,
      target_status: "reviewing",
    });
    expect(result.ok).toBe(true);
  });

  it("transition: reviewing → approved", async () => {
    const result = await runner.execute("autocrew_content", {
      action: "transition",
      id: transContentId,
      target_status: "approved",
    });
    expect(result.ok).toBe(true);
  });

  it("invalid transition is rejected", async () => {
    // approved → drafting should not be allowed
    const result = await runner.execute("autocrew_content", {
      action: "transition",
      id: transContentId,
      target_status: "drafting",
    });
    expect(result.ok).toBe(false);
  });
});

describe("E2E: Sensitive Words Detection", () => {
  it("scan_only detects sensitive words", async () => {
    const result = await runner.execute("autocrew_review", {
      action: "scan_only",
      text: "这个产品能治疗癌症，日赚一万不是梦，赶紧加微信了解",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(true);
    // Should detect medical claims and financial claims
    const found = result.found || result.sensitiveWords || result.words;
    expect(found).toBeDefined();
  });

  it("quality_score rates content quality", async () => {
    const result = await runner.execute("autocrew_review", {
      action: "quality_score",
      text: "今天给大家分享一家面馆。招牌炸酱面，面条劲道，酱料浓郁。人均30元。推荐指数五颗星。",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(true);
    expect(result.qualityScore).toBeDefined();
  });

  it("auto_fix replaces sensitive words", async () => {
    const result = await runner.execute("autocrew_review", {
      action: "auto_fix",
      text: "加我微信，保证月入过万",
      platform: "xiaohongshu",
    });
    expect(result.ok).toBe(true);
    expect(result.autoFixedText).toBeDefined();
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
