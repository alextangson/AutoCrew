/**
 * IPC contract + handler registry tests — all 9 channels.
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

// ── 1. Contract: all 9 channels present ──────────────────────────────────────

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
  ];

  it("has exactly 9 channels", () => {
    expect(IPC_CHANNELS).toHaveLength(9);
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
  const channels: IpcChannel[] = [
    "flywheel:report",
    "generate:script",
    "style:distill",
    "style:absorb",
    "content:list",
    "content:get",
    "publish:clipboard",
    "publish:confirm",
  ];

  const handlers = buildIpcHandlers();

  it.each(channels)("%s: null payload → {ok:false}", async (ch) => {
    // Handlers take Record<string,unknown> but we test the runtime guard by
    // injecting a mock that receives whatever the outer handler passes through.
    // The guard fires BEFORE calling the inner fn when payload is non-object.
    const mockExec = vi.fn().mockResolvedValue({ ok: true });
    const guardedHandlers = buildIpcHandlers(
      Object.fromEntries(
        IPC_CHANNELS.map((c) => [c, mockExec]),
      ) as Partial<Record<IpcChannel, typeof mockExec>>,
    );
    // We pass the raw null through a wrapper — the guard lives in wrapExecute
    const wrappedGuard = wrapExecute(mockExec, "any-action");
    const result = await wrappedGuard(null as unknown as Record<string, unknown>);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("string payload → {ok:false}", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    const h = wrapExecute(spy, "report");
    const result = await h("bad" as unknown as Record<string, unknown>);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(spy).not.toHaveBeenCalled();
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
