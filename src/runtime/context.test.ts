import { describe, it, expect } from "vitest";
import {
  createContext,
  getActiveContext,
  updateWorkspace,
  recordAudit,
  resolveGeminiKey,
  resolveGeminiModel,
} from "../runtime/context.js";

describe("createContext", () => {
  it("creates a context with defaults", () => {
    const ctx = createContext();
    expect(ctx.sessionId).toMatch(/^session-/);
    expect(ctx.dataDir).toContain(".autocrew");
    expect(ctx.workspace).toEqual({});
    expect(ctx.audit).toEqual([]);
  });

  it("uses data_dir from config", () => {
    const ctx = createContext({ data_dir: "/tmp/test-autocrew" });
    expect(ctx.dataDir).toBe("/tmp/test-autocrew");
  });

  it("sets active context", () => {
    const ctx = createContext();
    expect(getActiveContext()).toBe(ctx);
  });
});

describe("updateWorkspace", () => {
  it("merges partial updates", () => {
    const ctx = createContext();
    updateWorkspace(ctx, { activeContentId: "c1" });
    expect(ctx.workspace.activeContentId).toBe("c1");

    updateWorkspace(ctx, { activeTopicId: "t1" });
    expect(ctx.workspace.activeContentId).toBe("c1");
    expect(ctx.workspace.activeTopicId).toBe("t1");
  });
});

describe("recordAudit", () => {
  it("adds audit entries", () => {
    const ctx = createContext();
    recordAudit(ctx, {
      tool: "autocrew_content",
      action: "save",
      timestamp: new Date().toISOString(),
      durationMs: 42,
      ok: true,
    });
    expect(ctx.audit).toHaveLength(1);
    expect(ctx.audit[0].tool).toBe("autocrew_content");
  });

  it("caps at 100 entries", () => {
    const ctx = createContext();
    for (let i = 0; i < 120; i++) {
      recordAudit(ctx, {
        tool: `tool-${i}`,
        timestamp: new Date().toISOString(),
        durationMs: 1,
        ok: true,
      });
    }
    expect(ctx.audit.length).toBeLessThanOrEqual(100);
  });
});

describe("resolveGeminiKey", () => {
  it("returns config key first", () => {
    const ctx = createContext({ gemini_api_key: "from-config" });
    expect(resolveGeminiKey(ctx)).toBe("from-config");
  });

  it("returns undefined when no key", () => {
    const ctx = createContext();
    // Clear env var if set
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(resolveGeminiKey(ctx)).toBeUndefined();
    if (orig) process.env.GEMINI_API_KEY = orig;
  });
});

describe("resolveGeminiModel", () => {
  it("returns config model", () => {
    const ctx = createContext({ gemini_model: "imagen-4" });
    expect(resolveGeminiModel(ctx)).toBe("imagen-4");
  });

  it("defaults to auto", () => {
    const ctx = createContext();
    expect(resolveGeminiModel(ctx)).toBe("auto");
  });
});
