import { Type } from "@sinclair/typebox";
import path from "node:path";
import fs from "node:fs/promises";

/**
 * autocrew_pipeline — manage automated content pipelines (cron schedules).
 *
 * In OpenClaw: registers actual cron jobs via Gateway API.
 * In Claude Code: saves pipeline definitions locally for manual/external cron execution.
 */

export interface PipelineDefinition {
  id: string;
  name: string;
  description: string;
  schedule: string; // cron expression
  steps: PipelineStep[];
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
}

export interface PipelineStep {
  skill: string;
  params: Record<string, unknown>;
}

export const pipelineSchema = Type.Object({
  action: Type.Unsafe<"create" | "list" | "get" | "enable" | "disable" | "delete" | "templates">({
    type: "string",
    enum: ["create", "list", "get", "enable", "disable", "delete", "templates"],
    description:
      "Action: 'create' a pipeline, 'list' all, 'get' by id, 'enable'/'disable' toggle, 'delete' remove, 'templates' show preset pipeline templates.",
  }),
  id: Type.Optional(Type.String({ description: "Pipeline id (for get/enable/disable/delete)" })),
  name: Type.Optional(Type.String({ description: "Pipeline name (for create)" })),
  description: Type.Optional(Type.String({ description: "Pipeline description (for create)" })),
  schedule: Type.Optional(
    Type.String({ description: "Cron expression, e.g. '0 9 * * 1' = every Monday 9am (for create)" }),
  ),
  template: Type.Optional(
    Type.String({ description: "Preset template name: 'daily-research', 'weekly-content', 'daily-publish'" }),
  ),
});

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

async function pipelinesDir(dataDir?: string): Promise<string> {
  const dir = path.join(getDataDir(dataDir), "pipelines");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// --- Templates ---

const PIPELINE_TEMPLATES: Record<string, Omit<PipelineDefinition, "id" | "createdAt" | "enabled">> = {
  "daily-research": {
    name: "每日选题调研",
    description: "每天早上 9 点自动调研 3 个选题，保存到本地。",
    schedule: "0 9 * * *",
    steps: [
      { skill: "spawn-planner", params: { topic_count: 3, direction: "auto" } },
    ],
  },
  "weekly-content": {
    name: "每周内容生产",
    description: "每周一早上 10 点，从已有选题中批量写 5 篇稿子。",
    schedule: "0 10 * * 1",
    steps: [
      { skill: "spawn-batch-writer", params: { batch_count: 5 } },
    ],
  },
  "daily-publish": {
    name: "每日定时发布",
    description: "每天下午 6 点，发布一篇已审核的内容。",
    schedule: "0 18 * * *",
    steps: [
      { skill: "publish-content", params: { count: 1, status_filter: "approved" } },
    ],
  },
  "full-pipeline": {
    name: "全自动内容流水线",
    description: "周一调研选题 → 周二批量写稿 → 周三到周五每天发布一篇。",
    schedule: "0 9 * * 1",
    steps: [
      { skill: "spawn-planner", params: { topic_count: 5, direction: "auto" } },
      { skill: "spawn-batch-writer", params: { batch_count: 5 } },
      { skill: "publish-content", params: { count: 1, status_filter: "approved" } },
    ],
  },
};

export async function executePipeline(params: Record<string, unknown>) {
  const action = params.action as string;
  const dataDir = (params._dataDir as string) || undefined;

  // --- Templates ---
  if (action === "templates") {
    const templates = Object.entries(PIPELINE_TEMPLATES).map(([key, t]) => ({
      template: key,
      name: t.name,
      description: t.description,
      schedule: t.schedule,
      steps: t.steps.map((s) => s.skill).join(" → "),
    }));
    return { ok: true, templates };
  }

  // --- List ---
  if (action === "list") {
    const dir = await pipelinesDir(dataDir);
    const files = await fs.readdir(dir);
    const pipelines: PipelineDefinition[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(dir, f), "utf-8");
      pipelines.push(JSON.parse(raw));
    }
    return { ok: true, pipelines };
  }

  // --- Get ---
  if (action === "get") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required" };
    const dir = await pipelinesDir(dataDir);
    try {
      const raw = await fs.readFile(path.join(dir, `${id}.json`), "utf-8");
      return { ok: true, pipeline: JSON.parse(raw) };
    } catch {
      return { ok: false, error: `Pipeline ${id} not found` };
    }
  }

  // --- Create ---
  if (action === "create") {
    const template = params.template as string | undefined;
    let def: Omit<PipelineDefinition, "id" | "createdAt" | "enabled">;

    if (template && PIPELINE_TEMPLATES[template]) {
      def = { ...PIPELINE_TEMPLATES[template] };
      // Allow overrides
      if (params.name) def.name = params.name as string;
      if (params.description) def.description = params.description as string;
      if (params.schedule) def.schedule = params.schedule as string;
    } else {
      const name = params.name as string;
      const schedule = params.schedule as string;
      if (!name || !schedule) {
        return { ok: false, error: "name and schedule are required (or use template)" };
      }
      def = {
        name,
        description: (params.description as string) || "",
        schedule,
        steps: [],
      };
    }

    const id = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pipeline: PipelineDefinition = {
      ...def,
      id,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    const dir = await pipelinesDir(dataDir);
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(pipeline, null, 2), "utf-8");

    return {
      ok: true,
      pipeline,
      hint: "Pipeline saved locally. In OpenClaw, use 'openclaw cron add' to register with the Gateway for automatic execution.",
    };
  }

  // --- Enable / Disable ---
  if (action === "enable" || action === "disable") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required" };
    const dir = await pipelinesDir(dataDir);
    const filePath = path.join(dir, `${id}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const pipeline: PipelineDefinition = JSON.parse(raw);
      pipeline.enabled = action === "enable";
      await fs.writeFile(filePath, JSON.stringify(pipeline, null, 2), "utf-8");
      return { ok: true, pipeline };
    } catch {
      return { ok: false, error: `Pipeline ${id} not found` };
    }
  }

  // --- Delete ---
  if (action === "delete") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required" };
    const dir = await pipelinesDir(dataDir);
    try {
      await fs.unlink(path.join(dir, `${id}.json`));
      return { ok: true, message: `Pipeline ${id} deleted` };
    } catch {
      return { ok: false, error: `Pipeline ${id} not found` };
    }
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
