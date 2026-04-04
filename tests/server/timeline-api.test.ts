import { describe, it, expect, vi } from "vitest";
import { createApp, type ServerDeps } from "../../src/server/index.js";
import type { ToolRunner } from "../../src/runtime/tool-runner.js";
import type { EventBus } from "../../src/runtime/events.js";
import type { WorkflowEngine } from "../../src/runtime/workflow-engine.js";

function makeDeps(executeFn: ToolRunner["execute"]): ServerDeps {
  const runner = {
    execute: executeFn,
    getTools: () => [],
    getTool: () => undefined,
  } as unknown as ToolRunner;

  const eventBus = {
    on: () => "sub-1",
    off: () => {},
    emit: () => {},
  } as unknown as EventBus;

  const workflowEngine = {} as unknown as WorkflowEngine;

  return { runner, eventBus, workflowEngine };
}

describe("Timeline API routes", () => {
  it("GET /api/contents/:id/timeline — success", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      content_id: "c1",
      timeline: { version: "2.0" },
    });
    const app = createApp(makeDeps(execute));

    const res = await app.request("/api/contents/c1/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.timeline.version).toBe("2.0");

    expect(execute).toHaveBeenCalledWith("autocrew_timeline", {
      action: "get",
      content_id: "c1",
    });
  });

  it("GET /api/contents/:id/timeline — 404 when not found", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: false,
      error: "timeline.json not found for content c1",
    });
    const app = createApp(makeDeps(execute));

    const res = await app.request("/api/contents/c1/timeline");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("POST /api/contents/:id/timeline — generate with defaults", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      content_id: "c1",
      tts_count: 3,
      visual_count: 2,
    });
    const app = createApp(makeDeps(execute));

    const res = await app.request("/api/contents/c1/timeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    expect(execute).toHaveBeenCalledWith("autocrew_timeline", {
      action: "generate",
      content_id: "c1",
      preset: "knowledge-explainer",
      aspect_ratio: "9:16",
    });
  });

  it("POST /api/contents/:id/timeline — generate with custom preset", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const app = createApp(makeDeps(execute));

    await app.request("/api/contents/c1/timeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "tutorial", aspectRatio: "16:9" }),
    });

    expect(execute).toHaveBeenCalledWith("autocrew_timeline", {
      action: "generate",
      content_id: "c1",
      preset: "tutorial",
      aspect_ratio: "16:9",
    });
  });

  it("PATCH /api/contents/:id/timeline/segments/:segId — success", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      content_id: "c1",
      segment_id: "tts-001",
    });
    const app = createApp(makeDeps(execute));

    const res = await app.request(
      "/api/contents/c1/timeline/segments/tts-001",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready", assetPath: "audio/tts-001.mp3" }),
      },
    );
    expect(res.status).toBe(200);

    expect(execute).toHaveBeenCalledWith("autocrew_timeline", {
      action: "update_segment",
      content_id: "c1",
      segment_id: "tts-001",
      status: "ready",
      asset_path: "audio/tts-001.mp3",
    });
  });

  it("PATCH /api/contents/:id/timeline/segments/:segId — 400 on error", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: false,
      error: "Segment tts-999 not found",
    });
    const app = createApp(makeDeps(execute));

    const res = await app.request(
      "/api/contents/c1/timeline/segments/tts-999",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/contents/:id/timeline/confirm-all", async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      content_id: "c1",
      confirmed_count: 3,
    });
    const app = createApp(makeDeps(execute));

    const res = await app.request("/api/contents/c1/timeline/confirm-all", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.confirmed_count).toBe(3);

    expect(execute).toHaveBeenCalledWith("autocrew_timeline", {
      action: "confirm_all",
      content_id: "c1",
    });
  });

  it("returns 500 when runner throws", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("boom"));
    const app = createApp(makeDeps(execute));

    const res = await app.request("/api/contents/c1/timeline");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("boom");
  });
});

describe("Card Preview API route", () => {
  it("GET /api/cards/preview — returns HTML", async () => {
    const execute = vi.fn();
    const app = createApp(makeDeps(execute));

    const params = new URLSearchParams({
      template: "comparison-table",
      data: JSON.stringify({
        title: "Test",
        rows: [{ name: "A", pros: "Good", cons: "Bad" }],
      }),
      aspectRatio: "9:16",
    });

    const res = await app.request(`/api/cards/preview?${params}`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Test");
    expect(html).toContain("<!DOCTYPE html");
  });

  it("GET /api/cards/preview — 500 on invalid template", async () => {
    const execute = vi.fn();
    const app = createApp(makeDeps(execute));

    const params = new URLSearchParams({
      template: "nonexistent-template",
      data: "{}",
    });

    const res = await app.request(`/api/cards/preview?${params}`);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
