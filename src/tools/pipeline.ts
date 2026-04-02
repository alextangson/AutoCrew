import { Type } from "@sinclair/typebox";
import { WorkflowEngine } from "../runtime/workflow-engine.js";
import { getTemplates, getTemplate } from "../modules/workflow/templates.js";
import type { ToolRunner } from "../runtime/tool-runner.js";

/**
 * autocrew_pipeline — workflow orchestration for content pipelines.
 *
 * Manages stateful multi-step workflows with approval gates,
 * parameter interpolation, and persistent state.
 */

export const pipelineSchema = Type.Object({
  action: Type.Unsafe<"create" | "start" | "status" | "approve" | "cancel" | "list" | "templates">({
    type: "string",
    enum: ["create", "start", "status", "approve", "cancel", "list", "templates"],
    description:
      "Action: 'create' workflow from template, 'start' a workflow, 'status' check progress, 'approve' a paused step, 'cancel' a workflow, 'list' all workflows, 'templates' list available templates.",
  }),
  id: Type.Optional(Type.String({ description: "Workflow instance id (for start/status/approve/cancel)" })),
  template: Type.Optional(
    Type.String({ description: "Template id: 'xiaohongshu_full', 'quick_publish'" }),
  ),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Initial parameters for the workflow (e.g. content_id for quick_publish)",
    }),
  ),
});

/** Singleton engine per dataDir — avoids re-creating on every call */
const engines = new Map<string, WorkflowEngine>();

function getEngine(toolRunner: ToolRunner, dataDir: string): WorkflowEngine {
  let engine = engines.get(dataDir);
  if (!engine) {
    engine = new WorkflowEngine(toolRunner, dataDir);
    // Register all built-in templates
    for (const tpl of getTemplates()) {
      engine.registerDefinition(tpl);
    }
    engines.set(dataDir, engine);
  }
  return engine;
}

/**
 * Create the pipeline executor. Needs a ToolRunner reference for workflow step execution.
 */
export function createPipelineExecutor(toolRunner: ToolRunner) {
  return async function executePipeline(params: Record<string, unknown>) {
    const action = params.action as string;
    const dataDir = params._dataDir as string;

    if (!dataDir) {
      return { ok: false, error: "No _dataDir provided" };
    }

    const engine = getEngine(toolRunner, dataDir);

    // --- Templates ---
    if (action === "templates") {
      const templates = getTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        steps: t.steps.map((s) => `${s.name} (${s.tool})${s.requiresApproval ? " ⏸" : ""}`),
      }));
      return { ok: true, templates };
    }

    // --- List ---
    if (action === "list") {
      const instances = await engine.list();
      return {
        ok: true,
        workflows: instances.map((i) => ({
          id: i.id,
          definitionId: i.definitionId,
          status: i.status,
          currentStepIndex: i.currentStepIndex,
          createdAt: i.createdAt,
          error: i.error,
        })),
      };
    }

    // --- Create ---
    if (action === "create") {
      const templateId = params.template as string;
      if (!templateId) {
        return { ok: false, error: "template is required for create" };
      }
      const tpl = getTemplate(templateId);
      if (!tpl) {
        return { ok: false, error: `Unknown template: ${templateId}. Use action='templates' to see available ones.` };
      }
      try {
        const instance = await engine.create(templateId, params.params as Record<string, unknown>);
        return {
          ok: true,
          workflow: instance,
          hint: `Workflow created. Use action='start' with id='${instance.id}' to begin execution.`,
        };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // --- Start ---
    if (action === "start") {
      const id = params.id as string;
      if (!id) return { ok: false, error: "id is required" };
      try {
        const instance = await engine.start(id);
        return { ok: true, workflow: instance };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // --- Status ---
    if (action === "status") {
      const id = params.id as string;
      if (!id) return { ok: false, error: "id is required" };
      const instance = await engine.getStatus(id);
      if (!instance) {
        return { ok: false, error: `Workflow ${id} not found` };
      }
      const def = getTemplate(instance.definitionId);
      const currentStep = def?.steps[instance.currentStepIndex];
      return {
        ok: true,
        workflow: instance,
        currentStep: currentStep
          ? { name: currentStep.name, tool: currentStep.tool, requiresApproval: currentStep.requiresApproval }
          : null,
        totalSteps: def?.steps.length ?? 0,
      };
    }

    // --- Approve ---
    if (action === "approve") {
      const id = params.id as string;
      if (!id) return { ok: false, error: "id is required" };
      try {
        const instance = await engine.approve(id);
        return { ok: true, workflow: instance };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // --- Cancel ---
    if (action === "cancel") {
      const id = params.id as string;
      if (!id) return { ok: false, error: "id is required" };
      try {
        const instance = await engine.cancel(id);
        return { ok: true, workflow: instance };
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    return { ok: false, error: `Unknown action: ${action}` };
  };
}
