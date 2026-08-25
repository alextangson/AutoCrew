/**
 * IPC contract + handler registry tests — 通道总数以「has exactly N channels」为准。
 *
 * Action-injection testability design:
 *   `wrapExecute(fn, action)` is exported. Tests call it directly with a spy
 *   `fn` to confirm the handler injects the right `action` field — without
 *   needing to replace the full handler via deps.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  IPC_CHANNELS,
  CHANNEL_ACTIONS,
  buildIpcHandlers,
  wrapExecute,
  type IpcChannel,
} from "./ipc.js";
import { recordOutcome } from "../modules/flywheel/outcome-store.js";
import { createConversation, appendTurn } from "../storage/conversation-store.js";
import { addAssets as libAddAssets } from "../storage/library-store.js";
import { saveContent } from "../storage/local-store.js";
import { claimJob, releaseJob, isJobClaimed, GENERATE_JOB_KEY } from "./job-claims.js";

// ── helpers ──────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ipc-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ── 1. Contract: channel registry ────────────────────────────────────────────

describe("IPC_CHANNELS", () => {
  const EXPECTED: IpcChannel[] = [
    "flywheel:report",
    "generate:script",
    "generate:retry",
    "style:distill",
    "style:absorb",
    "style:rules",
    "content:list",
    "content:get",
    "publish:clipboard",
    "publish:digest",
    "publish:confirm",
    "publish:pre_check",
    "publish:request_wechat",
    "publish:wechat_draft",
    "article_images:get",
    "article_images:generate",
    "article_images:regenerate",
    "article_images:remove",
    "chat:turn",
    "settings:get",
    "settings:set",
    "settings:search_get",
    "settings:search_set",
    "settings:publish_get",
    "settings:publish_set",
    "style:update_rule",
    "persona:generate",
    "persona:save",
    "cover:create",
    "cover:get",
    "cover:approve",
    "cover:revise",
    "cover:ratios",
    "settings:cover_get",
    "settings:cover_set",
    "logs:list",
    "logs:get_run",
    "skills:list",
    "goal:get",
    "goal:set",
    "retro:generate",
    "retro:list",
    "retro:get",
    "onboarding:status",
    "onboarding:init",
    "flywheel:import_csv",
    "flywheel:pull_status",
    "flywheel:pull_now",
    "flywheel:pull_toggle",
    "flywheel:hypotheses_list",
    "dialog:pick_file",
    "knowledge:status",
    "radar:status",
    "radar:refresh",
    "radar:more",
    "radar:rescore",
    "profile:update",
    "content:update",
    "content:transition",
    "content:allowed_transitions",
    "content:versions",
    "content:revert",
    "draft:rewrite_selection",
    "style:record_edit",
    "conversations:list",
    "conversations:get",
    "conversations:delete",
    "library:list",
    "library:add",
    "library:update",
    "library:remove",
    "library:folder_create",
    "library:folder_remove",
    "dialog:pick_media",
    "content:asset_add",
    "content:asset_remove",
    "content:adoption",
    "today:summary",
    "events:recent",
    "campaign:list",
    "campaign:get",
    "campaign:create",
    "campaign:plan_team",
    "campaign:transition",
    "campaign:run_ready",
    "campaign:retry_task",
    "campaign:artifact_get",
    "campaign:set_autonomy",
    "campaign:patch_propose",
    "campaign:patch_decide",
    "campaign:replan",
    "topics:list",
    "topic:create",
    "topic:delete",
    "topic:restore",
    "topic:select_angle",
    "topic:clear_angle",
    "content:delete",
    "content:restore",
    "content:open_folder",
    "trash:list",
    "research:deep_dive",
    "research:status",
    "research:brief_get",
    "research:list_assets",
    "research:import_asset",
  ];

  // 这个数字是「注册链完整性」的闸门:改通道必须动到这里,迫使作者核对
  // channels.ts / channel-contracts.ts / buildIpcHandlers / renderer 调用四处
  // 是否同步。历史教训:a5eddc8 在 122 上加了 10 个 video 通道却把断言写成
  // 127 且改坏语法,套件停摆近一个月——bump 前先确认四处齐全,别只改数字。
  it("has exactly 159 channels", () => {
    expect(IPC_CHANNELS).toHaveLength(159);
  });

  it.each(EXPECTED)("contains %s", (ch) => {
    expect(IPC_CHANNELS).toContain(ch);
  });

  it("buildIpcHandlers returns a handler for every channel", () => {
    const handlers = buildIpcHandlers();
    for (const ch of IPC_CHANNELS) {
      expect(typeof handlers[ch]).toBe("function");
    }
  });
});

// ── 2. Action-injection verification via wrapExecute ─────────────────────────

describe("wrapExecute — action injection", () => {
  it("injects the action field into the execute fn call", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const handler = wrapExecute(spy, "report");
    await handler({ foo: "bar" });
    expect(spy).toHaveBeenCalledWith({ action: "report", foo: "bar" });
  });

  it("publish:confirm maps to action=confirm_published", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const handler = wrapExecute(spy, "confirm_published");
    await handler({ content_id: "x" });
    expect(spy).toHaveBeenCalledWith({ action: "confirm_published", content_id: "x" });
  });

  it("style:absorb maps to action=absorb_samples", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const handler = wrapExecute(spy, "absorb_samples");
    await handler({ samples: ["a"] });
    expect(spy).toHaveBeenCalledWith({ action: "absorb_samples", samples: ["a"] });
  });

  it("payload cannot override the injected action — channel whitelist holds", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const handler = wrapExecute(spy, "list");
    await handler({ action: "update", id: "x", body: "mutated" });
    expect(spy).toHaveBeenCalledWith({ action: "list", id: "x", body: "mutated" });
  });
});

// ── 2b. Channel→action table (single source for buildIpcHandlers) ─────────────

describe("CHANNEL_ACTIONS — channel→action bindings", () => {
  const EXPECTED_BINDINGS: [keyof typeof CHANNEL_ACTIONS, string][] = [
    ["flywheel:report", "report"],
    ["style:distill", "distill"],
    ["style:absorb", "absorb_samples"],
    ["content:list", "list"],
    ["content:get", "get"],
    ["publish:clipboard", "clipboard"],
    ["publish:digest", "digest"],
    ["publish:confirm", "confirm_published"],
    ["publish:pre_check", "check"],
    ["flywheel:import_csv", "import_csv"],
    ["content:adoption", "adoption"],
    ["content:delete", "delete"],
    ["content:restore", "restore"],
  ];

  it.each(EXPECTED_BINDINGS)("%s → action=%s", (channel, action) => {
    expect(CHANNEL_ACTIONS[channel]).toBe(action);
  });

  it("content:update → action=update", () => {
    expect(CHANNEL_ACTIONS["content:update"]).toBe("update");
  });

  it("content:transition → action=transition", () => {
    expect(CHANNEL_ACTIONS["content:transition"]).toBe("transition");
  });

  it("content:allowed_transitions → action=allowed_transitions", () => {
    expect(CHANNEL_ACTIONS["content:allowed_transitions"]).toBe("allowed_transitions");
  });

  // 排除清单 = 走专用 handler/门面而非 wrapExecute 的通道。新通道若不是
  // execute-backed,必须显式加进来——这迫使作者说清它由哪个专用 handler 承接,
  // 防止「通道注册了但 action 绑定悄悄漏掉」。
  it("covers exactly the execute-backed channels (dedicated-handler channels excluded)", () => {
    expect(Object.keys(CHANNEL_ACTIONS).sort()).toEqual(
      IPC_CHANNELS.filter(
        (ch) =>
          ch !== "style:rules" &&
          ch !== "generate:script" &&
          // 中断稿原地重写：ipc.ts 的 generateRetryHandler（带 job-claims 防双击）
          ch !== "generate:retry" &&
          ch !== "publish:request_wechat" &&
          ch !== "publish:wechat_draft" &&
          ch !== "article_images:get" &&
          ch !== "article_images:generate" &&
          ch !== "article_images:regenerate" &&
          ch !== "article_images:remove" &&
          ch !== "article_images:suggest" &&
          ch !== "article_images:add_slot" &&
          ch !== "article_images:remove_slot" &&
          ch !== "article_images:upload" &&
          ch !== "flywheel:wechat_pull" &&
          ch !== "flywheel:pull_status" &&
          ch !== "flywheel:pull_now" &&
          ch !== "flywheel:pull_toggle" &&
          ch !== "flywheel:hypotheses_list" &&
          ch !== "chat:turn" &&
          // 对话控制面 §Phase 3:ipc.ts 内的专用 handler(中止链路/断线恢复/模型切换器)
          ch !== "chat:abort" &&
          ch !== "chat:turn_status" &&
          ch !== "chat:model_options" &&
          ch !== "settings:get" &&
          ch !== "settings:set" &&
          // 端点配置逃生门:settings-providers.ts 的 openEngineConfigFile
          ch !== "settings:open_config" &&
          // 配置面反馈闭环:settings-probe.ts 的 testEngineRoute
          ch !== "settings:test_route" &&
          ch !== "settings:search_get" &&
          ch !== "settings:search_set" &&
          ch !== "settings:publish_get" &&
          ch !== "settings:publish_set" &&
          ch !== "style:update_rule" &&
          ch !== "persona:generate" &&
          ch !== "persona:save" &&
          ch !== "cover:create" &&
          ch !== "cover:get" &&
          ch !== "cover:approve" &&
          ch !== "cover:revise" &&
          ch !== "cover:ratios" &&
          ch !== "settings:cover_get" &&
          ch !== "settings:cover_set" &&
          ch !== "logs:list" &&
          ch !== "logs:get_run" &&
          ch !== "skills:list" &&
          ch !== "goal:get" &&
          ch !== "goal:set" &&
          ch !== "retro:generate" &&
          ch !== "retro:list" &&
          ch !== "retro:get" &&
          ch !== "content:open_folder" &&
          ch !== "onboarding:status" &&
          ch !== "onboarding:init" &&
          ch !== "dialog:pick_file" &&
          ch !== "knowledge:status" &&
          ch !== "radar:status" &&
          ch !== "radar:refresh" &&
          ch !== "radar:more" &&
          ch !== "radar:rescore" &&
          ch !== "radar:sources_set" &&
          ch !== "profile:update" &&
          ch !== "content:versions" &&
          ch !== "content:revert" &&
          ch !== "draft:rewrite_selection" &&
          ch !== "draft:adopt_revision" &&
          ch !== "style:record_edit" &&
          ch !== "conversations:list" &&
          ch !== "conversations:get" &&
          ch !== "conversations:delete" &&
          ch !== "library:list" &&
          ch !== "library:add" &&
          ch !== "library:update" &&
          ch !== "library:remove" &&
          ch !== "library:folder_create" &&
          ch !== "library:folder_remove" &&
          ch !== "dialog:pick_media" &&
          ch !== "content:asset_add" &&
          ch !== "content:asset_remove" &&
          ch !== "today:summary" &&
          ch !== "dashboard:summary" &&
          ch !== "events:recent" &&
          ch !== "workspace:list" &&
          ch !== "workspace:create" &&
          ch !== "workspace:switch" &&
          ch !== "campaign:list" &&
          ch !== "campaign:get" &&
          ch !== "campaign:create" &&
          ch !== "campaign:plan_team" &&
          ch !== "campaign:transition" &&
          ch !== "campaign:run_ready" &&
          ch !== "campaign:retry_task" &&
          ch !== "campaign:artifact_get" &&
          ch !== "campaign:set_autonomy" &&
          ch !== "campaign:patch_propose" &&
          ch !== "campaign:patch_decide" &&
          ch !== "campaign:replan" &&
          ch !== "topics:list" &&
          ch !== "topic:create" &&
          ch !== "topic:update" &&
          ch !== "topic:delete" &&
          ch !== "topic:restore" &&
          // 角度点选：ipc.ts 的 topicSelectAngleHandler / topicClearAngleHandler
          ch !== "topic:select_angle" &&
          ch !== "topic:clear_angle" &&
          ch !== "trash:list" &&
          ch !== "doctor:inbox" &&
          ch !== "inbox:list" &&
          ch !== "inbox:retry" &&
          ch !== "inbox:delete" &&
          ch !== "inbox:reingest" &&
          ch !== "inbox:settings_get" &&
          ch !== "inbox:settings_set" &&
          ch !== "inbox:status" &&
          ch !== "patterns:list" &&
          ch !== "patterns:update" &&
          ch !== "patterns:delete" &&
          ch !== "research:deep_dive" &&
          ch !== "research:status" &&
          ch !== "research:brief_get" &&
          ch !== "research:list_assets" &&
          ch !== "research:import_asset" &&
          ch !== "library:set_reusable" &&
          ch !== "cover:identity" &&
          // 视频线全部走 video-handlers（service 门面），没有一个是 execute-backed
          !ch.startsWith("video:"),
      ).sort(),
    );
  });
});

// ── 3. deps injection replaces the whole handler ─────────────────────────────

describe("buildIpcHandlers — deps injection", () => {
  it("deps override replaces the named channel's handler", async () => {
    const mockHandler = vi.fn().mockResolvedValue({ ok: true, data: "injected" });
    const handlers = buildIpcHandlers({ "flywheel:report": mockHandler });
    const result = await handlers["flywheel:report"]({ anything: 1 });
    expect(mockHandler).toHaveBeenCalledWith({ anything: 1 });
    expect(result).toEqual({ ok: true, data: "injected" });
  });

  it("non-overridden channels still have real handlers", () => {
    const mockHandler = vi.fn().mockResolvedValue({ ok: true });
    const handlers = buildIpcHandlers({ "flywheel:report": mockHandler });
    for (const ch of IPC_CHANNELS) {
      if (ch !== "flywheel:report") {
        expect(typeof handlers[ch]).toBe("function");
      }
    }
  });
});

// ── 3b. generate:retry — 中断稿原地重写的投递闸 ───────────────────────────────
//
// 真正的重写逻辑在 generate-script 有专测；这里只守住 IPC 这一层的两件事：
// 参数不齐不投、同一篇在跑时不投第二条（「重新生成」是个按钮，连点两下是常态）。

describe("generate:retry — 投递闸", () => {
  it("缺 content_id → {ok:false}，不投任务", async () => {
    const handlers = buildIpcHandlers();
    expect(await handlers["generate:retry"]({})).toMatchObject({ ok: false });
    expect(await handlers["generate:retry"]({ content_id: "  " })).toMatchObject({ ok: false });
  });

  it("同一篇已经在跑 → 拒绝并照实说「已经在写了」", async () => {
    const handlers = buildIpcHandlers();
    const key = GENERATE_JOB_KEY("content-busy");
    expect(claimJob(key)).toBe(true); // 模拟上一条 run 还占着
    try {
      const res = await handlers["generate:retry"]({ content_id: "content-busy", _dataDir: testDir });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain("已经在写");
    } finally {
      releaseJob(key);
    }
  });

  it("没有中断记录的稿件 → 原因原样透出，claim 当场释放（不许卡住后续重试）", async () => {
    const c = await saveContent(
      { title: "好稿", body: "正文", platform: "douyin", status: "draft_ready", tags: [] },
      testDir,
    );
    const handlers = buildIpcHandlers();
    const res = await handlers["generate:retry"]({ content_id: c.id, _dataDir: testDir });

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("中断记录");
    expect(isJobClaimed(GENERATE_JOB_KEY(c.id))).toBe(false);
  });
});

// ── 4. Error guard: non-object payload → {ok:false} ──────────────────────────

describe("handler — non-object payload guard", () => {
  it("null payload → {ok:false} without calling the execute fn", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    const h = wrapExecute(spy, "report");
    const result = await h(null as unknown as Record<string, unknown>);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(spy).not.toHaveBeenCalled();
  });

  it("string payload → {ok:false}", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    const h = wrapExecute(spy, "report");
    const result = await h("bad" as unknown as Record<string, unknown>);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(spy).not.toHaveBeenCalled();
  });

  it("style:rules: non-object payload → {ok:false}", async () => {
    const handlers = buildIpcHandlers();
    const result = await handlers["style:rules"](null as unknown as Record<string, unknown>);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
  });
});

// ── 5. Thrown errors caught → {ok:false} ──────────────────────────────────────

describe("handler — thrown error → {ok:false}", () => {
  it("synchronous throw becomes {ok:false, error}", async () => {
    const bomb = vi.fn().mockRejectedValue(new Error("boom"));
    const h = wrapExecute(bomb, "report");
    const result = await h({});
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("non-Error throw still becomes {ok:false, error}", async () => {
    const bomb = vi.fn().mockRejectedValue("string error");
    const h = wrapExecute(bomb, "report");
    const result = await h({});
    expect(result).toEqual({ ok: false, error: "string error" });
  });
});

// ── 6. flywheel:report real temp-dataDir round-trip ──────────────────────────

describe("flywheel:report — real temp dataDir round-trip", () => {
  it("returns ok:true with works/avgMetrics/baselineInsights shape after seeding", async () => {
    // Seed one outcome via the real recordOutcome
    await recordOutcome(
      {
        contentId: "test-001",
        platform: "douyin",
        platformTitle: "IPC test post",
        publishedAt: null,
        metrics: { views: 1000, completionRate: 55 },
        metricDate: "2026-06-11",
      },
      testDir,
    );

    const handlers = buildIpcHandlers();
    const result = (await handlers["flywheel:report"]({ _dataDir: testDir })) as {
      ok: boolean;
      data?: {
        works: { total: number };
        avgMetrics: Record<string, number>;
        baselineInsights: string[];
      };
    };

    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data!.works.total).toBe("number");
    expect(result.data!.works.total).toBeGreaterThanOrEqual(1);
    expect(result.data!.avgMetrics).toBeDefined();
    expect(Array.isArray(result.data!.baselineInsights)).toBe(true);
  });

  it("returns ok:true with empty data dir (no outcomes)", async () => {
    const handlers = buildIpcHandlers();
    const result = (await handlers["flywheel:report"]({ _dataDir: testDir })) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
  });
});

// ── 7. style:rules — loadProfile-based handler ───────────────────────────────

describe("style:rules", () => {
  it("returns ok:true with empty rules when no profile exists", async () => {
    const handlers = buildIpcHandlers();
    const result = (await handlers["style:rules"]({ _dataDir: testDir })) as {
      ok: boolean;
      data?: { rules: unknown[]; boundaries: { never: string[]; always: string[] } };
    };
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.rules).toEqual([]);
    expect(result.data!.boundaries).toEqual({ never: [], always: [] });
  });

  it("returns ok:true with profile data when profile exists", async () => {
    // Write a minimal profile
    const profileDir = testDir;
    await fs.writeFile(
      path.join(profileDir, "creator-profile.json"),
      JSON.stringify({
        industry: "tech",
        platforms: ["douyin"],
        audiencePersona: null,
        writingRules: [{ rule: "keep it short", source: "user_explicit", confidence: 1, createdAt: "2026-01-01T00:00:00Z" }],
        styleBoundaries: { never: ["clickbait"], always: ["authentic"] },
        competitorAccounts: [],
        performanceHistory: [],
        styleCalibrated: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );

    const handlers = buildIpcHandlers();
    const result = (await handlers["style:rules"]({ _dataDir: testDir })) as {
      ok: boolean;
      data?: { rules: unknown[]; boundaries: { never: string[]; always: string[] } };
    };
    expect(result.ok).toBe(true);
    expect(result.data!.rules).toHaveLength(1);
    expect(result.data!.boundaries.never).toEqual(["clickbait"]);
  });

  it("deps injection works for style:rules too", async () => {
    const mockRules = vi.fn().mockResolvedValue({ ok: true, data: { rules: ["injected"], boundaries: {} } });
    const handlers = buildIpcHandlers({ "style:rules": mockRules });
    await handlers["style:rules"]({ _dataDir: testDir });
    expect(mockRules).toHaveBeenCalled();
  });
});

// ── 8. chat:turn handler ──────────────────────────────────────────────────────

describe("chat:turn handler", () => {
  it("rejects empty message", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["chat:turn"]({ message: "   " });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("message");
  });

  it("rejects non-object payload", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["chat:turn"](null as unknown as Record<string, unknown>);
    expect(res.ok).toBe(false);
  });

  it("deps override replaces the handler (renderer contract)", async () => {
    const spy = vi.fn(async () => ({ ok: true, data: { reply: "hi", cards: [], tokensUsed: 1 } }));
    const handlers = buildIpcHandlers({ "chat:turn": spy });
    const res = await handlers["chat:turn"]({ message: "你好" });
    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalled();
  });
});

// ── 9. style:update_rule handler ─────────────────────────────────────────────

describe("style:update_rule handler", () => {
  it("validates index and patch presence", async () => {
    const handlers = buildIpcHandlers();
    expect((await handlers["style:update_rule"]({ index: -1 })).ok).toBe(false);
    expect((await handlers["style:update_rule"]({ index: 0 })).ok).toBe(false);
  });
});

// ── 10. dialog:pick_file default handler ─────────────────────────────────────

describe("dialog:pick_file default handler", () => {
  it("fails outside the Electron main process（main.ts 用 deps 覆盖真实现）", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["dialog:pick_file"]({});
    expect(res.ok).toBe(false);
  });
});

// ── 11. knowledge:status handler ─────────────────────────────────────────────

describe("knowledge:status handler", () => {
  it("returns dir and count", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["knowledge:status"]({ _dataDir: testDir });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).count).toBe(0);
  });
});

// ── 12. chat:turn progress forwarding ────────────────────────────────────────

describe("chat:turn progress forwarding", () => {
  it("accepts a ctx second argument and stays silent on the needsSetup path", async () => {
    const handlers = buildIpcHandlers();
    const events: unknown[] = [];
    const res = await handlers["chat:turn"](
      { message: "你好", _dataDir: testDir },
      { onProgress: (e: unknown) => events.push(e) },
    );
    expect(res.ok).toBe(false); // testDir 无 engine.json → needsSetup，不应有任何事件
    expect(events).toEqual([]);
  });
});

// ── 13. profile:update handler ────────────────────────────────────────────────

describe("profile:update handler", () => {
  it("updates industry only and preserves platforms", async () => {
    const handlers = buildIpcHandlers();
    await handlers["onboarding:init"]({ _dataDir: testDir, industry: "旧定位", platforms: ["douyin", "xiaohongshu"] });
    const res = await handlers["profile:update"]({ _dataDir: testDir, industry: "新定位" });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).industry).toBe("新定位");

    const status = await handlers["onboarding:status"]({ _dataDir: testDir });
    expect((status.data as Record<string, unknown>).industry).toBe("新定位");
    // platforms 不被覆盖（直接读 profile 文件验证）
    const fs2 = await import("node:fs/promises");
    const path2 = await import("node:path");
    const profile = JSON.parse(await fs2.readFile(path2.join(testDir, "creator-profile.json"), "utf-8"));
    expect(profile.platforms).toEqual(["douyin", "xiaohongshu"]);
  });

  it("updates platforms only and preserves industry (席位编辑不必带定位)", async () => {
    const handlers = buildIpcHandlers();
    await handlers["onboarding:init"]({ _dataDir: testDir, industry: "定位不动", platforms: ["wechat_mp"] });
    const res = await handlers["profile:update"]({ _dataDir: testDir, platforms: ["wechat_mp", "douyin"] });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).platforms).toEqual(["wechat_mp", "douyin"]);

    const status = await handlers["onboarding:status"]({ _dataDir: testDir });
    expect((status.data as Record<string, unknown>).industry).toBe("定位不动"); // 定位不被覆盖
    expect((status.data as Record<string, unknown>).platforms).toEqual(["wechat_mp", "douyin"]);
  });

  it("rejects when neither industry nor platforms provided", async () => {
    const handlers = buildIpcHandlers();
    expect((await handlers["profile:update"]({ _dataDir: testDir })).ok).toBe(false);
    // 空 industry 但带 platforms → 通过（platforms 独立生效）
    await handlers["onboarding:init"]({ _dataDir: testDir, industry: "x", platforms: ["wechat_mp"] });
    expect((await handlers["profile:update"]({ _dataDir: testDir, platforms: ["douyin"] })).ok).toBe(true);
  });
});

// ── 14. content versions / revert handlers ────────────────────────────────────

describe("content versions / revert handlers", () => {
  it("lists versions and reverts after an update", async () => {
    const handlers = buildIpcHandlers();
    const saved = await handlers["content:list"]({ _dataDir: testDir }); // 触发目录初始化
    void saved;
    // 直接经 update 路径覆盖：先用 content-save 的 save action 建一篇
    const { executeContentSave } = await import("../tools/content-save.js");
    const made = await executeContentSave({
      action: "save", title: "T", body: "v1 正文", platform: "douyin", status: "draft_ready", _dataDir: testDir,
    } as never);
    const id = ((made as Record<string, unknown>).content as Record<string, unknown>).id as string;

    await handlers["content:update"]({ _dataDir: testDir, id, body: "v2 正文" });
    const versions = await handlers["content:versions"]({ _dataDir: testDir, id });
    expect(versions.ok).toBe(true);
    expect(((versions.data as Record<string, unknown>).versions as unknown[]).length).toBe(2);

    const reverted = await handlers["content:revert"]({ _dataDir: testDir, id, version: 1 });
    expect(reverted.ok).toBe(true);
    const got = await handlers["content:get"]({ _dataDir: testDir, id });
    expect(((got as Record<string, unknown>).content as Record<string, unknown>).body).toBe("v1 正文");
  });

  it("revert validates params", async () => {
    const handlers = buildIpcHandlers();
    expect((await handlers["content:revert"]({ _dataDir: testDir })).ok).toBe(false);
    expect((await handlers["content:revert"]({ _dataDir: testDir, id: "x" })).ok).toBe(false);
    expect((await handlers["content:revert"]({ _dataDir: testDir, id: "nonexistent", version: 1 })).ok).toBe(false);
  });
});

// ── 15. style:record_edit handler ─────────────────────────────────────────────

describe("style:record_edit handler", () => {
  it("records an accepted rewrite as edit signal", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["style:record_edit"]({
      _dataDir: testDir, content_id: "c1", before: "原句子", after: "新句子",
    });
    expect(res.ok).toBe(true);
  });

  it("validates before/after presence", async () => {
    const handlers = buildIpcHandlers();
    expect((await handlers["style:record_edit"]({ _dataDir: testDir, before: "x" })).ok).toBe(false);
    expect((await handlers["style:record_edit"]({ _dataDir: testDir, before: "x", after: "" })).ok).toBe(false);
  });
});

// ── 13. conversations:* handlers ─────────────────────────────────────────────

describe("conversations handlers", () => {
  it("list returns persisted conversations newest-first", async () => {
    const handlers = buildIpcHandlers();
    const a = await createConversation("会话A", testDir);
    await appendTurn(a.id, { content: "会话A" }, { content: "好" }, testDir);
    const res = await handlers["conversations:list"]({ _dataDir: testDir });
    expect(res.ok).toBe(true);
    const convs = (res.data as { conversations: Array<{ id: string }> }).conversations;
    expect(convs[0].id).toBe(a.id);
  });

  it("get returns full messages; missing id errors", async () => {
    const handlers = buildIpcHandlers();
    const a = await createConversation("会话B", testDir);
    await appendTurn(a.id, { content: "会话B" }, { content: "回", cards: [{ type: "draft", data: {} }] }, testDir);
    const res = await handlers["conversations:get"]({ id: a.id, _dataDir: testDir });
    expect(res.ok).toBe(true);
    expect((res.data as { messages: unknown[] }).messages).toHaveLength(2);
    const miss = await handlers["conversations:get"]({ id: "conv-1-gone", _dataDir: testDir });
    expect(miss.ok).toBe(false);
    const noId = await handlers["conversations:get"]({ _dataDir: testDir });
    expect(noId.ok).toBe(false);
  });

  it("delete removes; unknown id errors; list guards bad payload", async () => {
    const handlers = buildIpcHandlers();
    const a = await createConversation("会话C", testDir);
    const del = await handlers["conversations:delete"]({ id: a.id, _dataDir: testDir });
    expect(del.ok).toBe(true);
    const again = await handlers["conversations:delete"]({ id: a.id, _dataDir: testDir });
    expect(again.ok).toBe(false);
    const bad = await handlers["conversations:list"](null as unknown as Record<string, unknown>);
    expect(bad.ok).toBe(false);
  });

  it("chat:turn forwards conversation_id (deps spy sees it untouched)", async () => {
    const spy = vi.fn(async (p: Record<string, unknown>) => ({ ok: true, echo: p.conversation_id }));
    const handlers = buildIpcHandlers({ "chat:turn": spy });
    const res = await handlers["chat:turn"]({ message: "hi", conversation_id: "conv-1-abc" });
    expect(res.echo).toBe("conv-1-abc");
  });

  it("chat:turn default handler maps conversation_id to the store lookup", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["chat:turn"]({ message: "hi", conversation_id: "conv-1-gone", _dataDir: testDir });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("会话不存在"); // id 到达 runPersistedChatTurn 的查找，零网络
  });
});

// ── 14. library:* / content:asset_* handlers ────────────────────────────────

describe("library handlers", () => {
  async function seedFile(name: string): Promise<string> {
    const p = path.join(testDir, name);
    await fs.writeFile(p, "0123456789", "utf-8");
    return p;
  }

  it("add → list roundtrip with missing flag", async () => {
    const handlers = buildIpcHandlers();
    const p = await seedFile("clip.mp4");
    const add = await handlers["library:add"]({ paths: [p], _dataDir: testDir });
    expect(add.ok).toBe(true);
    const list = await handlers["library:list"]({ _dataDir: testDir });
    const assets = (list.data as { assets: Array<Record<string, unknown>> }).assets;
    expect(assets).toHaveLength(1);
    expect(assets[0].missing).toBe(false);
  });

  it("add guards: missing/empty paths → error", async () => {
    const handlers = buildIpcHandlers();
    expect((await handlers["library:add"]({ _dataDir: testDir })).ok).toBe(false);
    expect((await handlers["library:add"]({ paths: [], _dataDir: testDir })).ok).toBe(false);
  });

  it("update renames and edits tags; unknown id errors", async () => {
    const handlers = buildIpcHandlers();
    const p = await seedFile("a.png");
    const { added } = await libAddAssets([p], null, testDir);
    const res = await handlers["library:update"]({ id: added[0].id, name: "封面A", tags: ["封面"], _dataDir: testDir });
    expect(res.ok).toBe(true);
    expect((res.data as { asset: { name: string } }).asset.name).toBe("封面A");
    expect((await handlers["library:update"]({ id: "asset-1-gone", name: "x", _dataDir: testDir })).ok).toBe(false);
    expect((await handlers["library:update"]({ id: added[0].id, _dataDir: testDir })).ok).toBe(false); // 空 patch
  });

  it("remove deletes record only; folder create/remove works", async () => {
    const handlers = buildIpcHandlers();
    const p = await seedFile("b.mp3");
    const { added } = await libAddAssets([p], null, testDir);
    expect((await handlers["library:remove"]({ id: added[0].id, _dataDir: testDir })).ok).toBe(true);
    await expect(fs.access(p)).resolves.toBeUndefined();
    const fc = await handlers["library:folder_create"]({ name: "素材夹", _dataDir: testDir });
    expect(fc.ok).toBe(true);
    const fid = (fc.data as { folder: { id: string } }).folder.id;
    expect((await handlers["library:folder_remove"]({ id: fid, _dataDir: testDir })).ok).toBe(true);
    expect((await handlers["library:folder_remove"]({ id: fid, _dataDir: testDir })).ok).toBe(false);
  });

  it("dialog:pick_media default stub errors (real impl lives in main.ts)", async () => {
    const handlers = buildIpcHandlers();
    expect((await handlers["dialog:pick_media"]({})).ok).toBe(false);
  });
});

describe("content asset attach", () => {
  it("attaches a library asset by copy and detaches it", async () => {
    const handlers = buildIpcHandlers();
    const src = path.join(testDir, "cover.png");
    await fs.writeFile(src, "img-bytes", "utf-8");
    const { added } = await libAddAssets([src], null, testDir);
    const content = await saveContent(
      { title: "测试稿", body: "正文", status: "draft_ready", tags: [], topicId: undefined, platform: "douyin" },
      testDir,
    );
    const res = await handlers["content:asset_add"]({ content_id: content.id, library_id: added[0].id, _dataDir: testDir });
    expect(res.ok).toBe(true);
    const copied = path.join(testDir, "contents", content.id, "assets", "cover.png");
    await expect(fs.access(copied)).resolves.toBeUndefined();
    const rm = await handlers["content:asset_remove"]({ content_id: content.id, filename: "cover.png", _dataDir: testDir });
    expect(rm.ok).toBe(true);
    await expect(fs.access(src)).resolves.toBeUndefined(); // 库内原文件不受影响
  });

  it("attach fails when the original file is missing", async () => {
    const handlers = buildIpcHandlers();
    const src = path.join(testDir, "gone.mp4");
    await fs.writeFile(src, "x", "utf-8");
    const { added } = await libAddAssets([src], null, testDir);
    await fs.unlink(src);
    const content = await saveContent(
      { title: "稿", body: "b", status: "draft_ready", tags: [], topicId: undefined, platform: "douyin" },
      testDir,
    );
    const res = await handlers["content:asset_add"]({ content_id: content.id, library_id: added[0].id, _dataDir: testDir });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("重新定位");
  });

  it("rejects traversal filename on detach and bad ids", async () => {
    const handlers = buildIpcHandlers();
    expect((await handlers["content:asset_remove"]({ content_id: "content-1-x", filename: "../meta.json", _dataDir: testDir })).ok).toBe(false);
    expect((await handlers["content:asset_add"]({ content_id: "../../etc", library_id: "asset-1-x", _dataDir: testDir })).ok).toBe(false);
  });

  it("rejects re-attaching the same library asset (filename collision)", async () => {
    const handlers = buildIpcHandlers();
    const src = path.join(testDir, "dup.png");
    await fs.writeFile(src, "bytes", "utf-8");
    const { added } = await libAddAssets([src], null, testDir);
    const content = await saveContent(
      { title: "稿", body: "b", status: "draft_ready", tags: [], topicId: undefined, platform: "douyin" },
      testDir,
    );
    const first = await handlers["content:asset_add"]({ content_id: content.id, library_id: added[0].id, _dataDir: testDir });
    expect(first.ok).toBe(true);
    const second = await handlers["content:asset_add"]({ content_id: content.id, library_id: added[0].id, _dataDir: testDir });
    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain("同名素材已挂接");
  });

  it("rejects attaching two different library files sharing a basename", async () => {
    const handlers = buildIpcHandlers();
    const dirA = path.join(testDir, "a");
    const dirB = path.join(testDir, "b");
    await fs.mkdir(dirA);
    await fs.mkdir(dirB);
    const srcA = path.join(dirA, "cover.png");
    const srcB = path.join(dirB, "cover.png");
    await fs.writeFile(srcA, "bytes-A", "utf-8");
    await fs.writeFile(srcB, "bytes-B", "utf-8");
    const { added } = await libAddAssets([srcA, srcB], null, testDir);
    expect(added).toHaveLength(2);
    const content = await saveContent(
      { title: "稿", body: "b", status: "draft_ready", tags: [], topicId: undefined, platform: "douyin" },
      testDir,
    );
    const first = await handlers["content:asset_add"]({ content_id: content.id, library_id: added[0].id, _dataDir: testDir });
    expect(first.ok).toBe(true);
    const second = await handlers["content:asset_add"]({ content_id: content.id, library_id: added[1].id, _dataDir: testDir });
    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain("同名素材已挂接");
    // 第一份字节未被第二次挂接覆盖
    const copied = await fs.readFile(path.join(testDir, "contents", content.id, "assets", "cover.png"), "utf-8");
    expect(copied).toBe("bytes-A");
  });
});

// ── 15. today:summary handler ────────────────────────────────────────────────

describe("today:summary handler", () => {
  it("returns ok with the summary shape on an empty project", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["today:summary"]({ _dataDir: testDir });
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d).toHaveProperty("industry");
    expect(d).toHaveProperty("radar");
    expect(d).toHaveProperty("pipeline");
    expect(d).toHaveProperty("lastOutcome");
  });

  it("counts a seeded draft in the pipeline", async () => {
    const handlers = buildIpcHandlers();
    await saveContent(
      { title: "稿A", body: "b", status: "draft_ready", tags: [], topicId: undefined, platform: "douyin" },
      testDir,
    );
    const res = await handlers["today:summary"]({ _dataDir: testDir });
    const pipeline = (res.data as { pipeline: { draft: number } }).pipeline;
    expect(pipeline.draft).toBeGreaterThanOrEqual(1);
  });

  it("guards a non-object payload", async () => {
    const handlers = buildIpcHandlers();
    const res = await handlers["today:summary"](null as unknown as Record<string, unknown>);
    expect(res.ok).toBe(false);
  });
});
