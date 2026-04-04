/**
 * AutoCrew HTTP Server — lightweight local dashboard backend.
 *
 * Wraps ToolRunner as REST API + EventBus as SSE stream.
 * Start with: autocrew serve --port 3000
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import type { ToolRunner } from "../runtime/tool-runner.js";
import type { EventBus } from "../runtime/events.js";
import type { WorkflowEngine } from "../runtime/workflow-engine.js";

export interface ServerDeps {
  runner: ToolRunner;
  eventBus: EventBus;
  workflowEngine: WorkflowEngine;
}

export function createApp(deps: ServerDeps): Hono {
  const { runner, eventBus, workflowEngine } = deps;
  const app = new Hono();

  // --- CORS (allow all origins for local dev) ---
  app.use("*", cors());

  // --- Health ---
  app.get("/api/health", (c) => {
    return c.json({ ok: true, version: "0.1.0" });
  });

  // --- Status ---
  app.get("/api/status", async (c) => {
    try {
      const result = await runner.execute("autocrew_status", {});
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // --- Tool API ---
  app.get("/api/tools", (c) => {
    const tools = runner.getTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    return c.json({ ok: true, tools });
  });

  app.post("/api/tools/:name", async (c) => {
    const toolName = c.req.param("name");
    const def = runner.getTool(toolName);
    if (!def) {
      return c.json({ ok: false, error: `Unknown tool: ${toolName}` }, 404);
    }
    try {
      const params = await c.req.json();
      const result = await runner.execute(toolName, params);
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // --- Content API (convenience wrappers) ---
  app.get("/api/contents", async (c) => {
    try {
      const result = await runner.execute("autocrew_content", { action: "list" });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/api/contents/:id", async (c) => {
    try {
      const result = await runner.execute("autocrew_content", {
        action: "get",
        content_id: c.req.param("id"),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // --- Timeline API ---
  app.get("/api/contents/:id/timeline", async (c) => {
    try {
      const result = await runner.execute("autocrew_timeline", {
        action: "get",
        content_id: c.req.param("id"),
      });
      if (!result.ok) return c.json(result, 404);
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/api/contents/:id/timeline", async (c) => {
    try {
      const body = await c.req.json();
      const result = await runner.execute("autocrew_timeline", {
        action: "generate",
        content_id: c.req.param("id"),
        preset: body.preset || "knowledge-explainer",
        aspect_ratio: body.aspectRatio || "9:16",
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.patch("/api/contents/:id/timeline/segments/:segId", async (c) => {
    try {
      const body = await c.req.json();
      const result = await runner.execute("autocrew_timeline", {
        action: "update_segment",
        content_id: c.req.param("id"),
        segment_id: c.req.param("segId"),
        status: body.status,
        asset_path: body.assetPath,
      });
      if (!result.ok) return c.json(result, 400);
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/api/contents/:id/timeline/confirm-all", async (c) => {
    try {
      const result = await runner.execute("autocrew_timeline", {
        action: "confirm_all",
        content_id: c.req.param("id"),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // --- Card Preview ---
  app.get("/api/cards/preview", async (c) => {
    try {
      const template = c.req.query("template");
      const data = JSON.parse(c.req.query("data") || "{}");
      const aspectRatio = c.req.query("aspectRatio") || "9:16";

      const { renderCard } = await import("../modules/cards/template-engine.js");
      const html = renderCard(template as any, data, { aspectRatio: aspectRatio as any });
      return c.html(html);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/api/topics", async (c) => {
    try {
      const result = await runner.execute("autocrew_topic", { action: "list" });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // --- Workflow API ---
  app.get("/api/workflows/templates", async (c) => {
    try {
      const result = await runner.execute("autocrew_pipeline", { action: "templates" });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/api/workflows", async (c) => {
    try {
      const result = await runner.execute("autocrew_pipeline", { action: "list" });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/api/workflows", async (c) => {
    try {
      const body = await c.req.json();
      const result = await runner.execute("autocrew_pipeline", {
        action: "create",
        template: body.template,
        params: body.params,
      });
      return c.json(result, result.ok === false ? 400 : 201);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/api/workflows/:id/start", async (c) => {
    try {
      const result = await runner.execute("autocrew_pipeline", {
        action: "start",
        id: c.req.param("id"),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/api/workflows/:id/approve", async (c) => {
    try {
      const result = await runner.execute("autocrew_pipeline", {
        action: "approve",
        id: c.req.param("id"),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/api/workflows/:id/cancel", async (c) => {
    try {
      const result = await runner.execute("autocrew_pipeline", {
        action: "cancel",
        id: c.req.param("id"),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/api/workflows/:id", async (c) => {
    try {
      const result = await runner.execute("autocrew_pipeline", {
        action: "status",
        id: c.req.param("id"),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // --- Events SSE ---
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const subId = eventBus.on("*", (event) => {
        stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        }).catch(() => {});
      });

      // Heartbeat every 30s
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {
          clearInterval(heartbeat);
        });
      }, 30_000);

      // Keep connection open until client disconnects
      stream.onAbort(() => {
        eventBus.off(subId);
        clearInterval(heartbeat);
      });

      // Block until aborted
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    });
  });

  // --- Static files (frontend build) ---
  app.use(
    "/*",
    serveStatic({
      root: "./web/dist",
    }),
  );

  // SPA fallback: serve index.html for unmatched routes
  app.get("*", serveStatic({ root: "./web/dist", path: "index.html" }));

  return app;
}
