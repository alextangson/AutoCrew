/**
 * IPC contract + handler registry tests — all 28 channels.
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

// ── helpers ──────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-ipc-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ── 1. Contract: all 28 channels present ─────────────────────────────────────

describe("IPC_CHANNELS", () => {
  const EXPECTED: IpcChannel[] = [
    "flywheel:report",
    "generate:script",
    "style:distill",
    "style:absorb",
    "style:rules",
    "content:list",
    "content:get",
    "publish:clipboard",
    "publish:confirm",
    "chat:turn",
    "settings:get",
    "settings:set",
    "style:update_rule",
    "onboarding:status",
    "onboarding:init",
    "flywheel:import_csv",
    "dialog:pick_file",
    "knowledge:status",
    "radar:status",
    "radar:refresh",
    "profile:update",
    "content:update",
    "content:transition",
    "content:allowed_transitions",
    "content:versions",
    "content:revert",
    "draft:rewrite_selection",
    "style:record_edit",
  ];

  it("has exactly 28 channels", () => {
    expect(IPC_CHANNELS).toHaveLength(28);
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
    ["generate:script", "script"],
    ["style:distill", "distill"],
    ["style:absorb", "absorb_samples"],
    ["content:list", "list"],
    ["content:get", "get"],
    ["publish:clipboard", "clipboard"],
    ["publish:confirm", "confirm_published"],
    ["flywheel:import_csv", "import_csv"],
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

  it("covers exactly the execute-backed channels (style:rules, chat:turn, settings:get, settings:set, style:update_rule, onboarding:status, onboarding:init, dialog:pick_file, knowledge:status, radar:status, radar:refresh, profile:update, content:versions, content:revert, draft:rewrite_selection, style:record_edit excluded)", () => {
    expect(Object.keys(CHANNEL_ACTIONS).sort()).toEqual(
      IPC_CHANNELS.filter(
        (ch) =>
          ch !== "style:rules" &&
          ch !== "chat:turn" &&
          ch !== "settings:get" &&
          ch !== "settings:set" &&
          ch !== "style:update_rule" &&
          ch !== "onboarding:status" &&
          ch !== "onboarding:init" &&
          ch !== "dialog:pick_file" &&
          ch !== "knowledge:status" &&
          ch !== "radar:status" &&
          ch !== "radar:refresh" &&
          ch !== "profile:update" &&
          ch !== "content:versions" &&
          ch !== "content:revert" &&
          ch !== "draft:rewrite_selection" &&
          ch !== "style:record_edit",
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

  it("rejects empty or missing industry", async () => {
    const handlers = buildIpcHandlers();
    expect((await handlers["profile:update"]({ _dataDir: testDir, industry: "  " })).ok).toBe(false);
    expect((await handlers["profile:update"]({ _dataDir: testDir })).ok).toBe(false);
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
  });
});
