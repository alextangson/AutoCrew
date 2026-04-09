/**
 * WorkflowEngine — stateful workflow orchestration for AutoCrew.
 *
 * Runs multi-step tool pipelines with:
 * - Sequential step execution via ToolRunner
 * - Approval gates (pauses workflow for user confirmation)
 * - Retry logic per step
 * - Parameter interpolation (${stepId.field} references)
 * - Persistent state to disk after every step
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ToolRunner, ToolResult } from "./tool-runner.js";

// --- Interfaces ---

export interface WorkflowStep {
  id: string;
  name: string;
  /** Tool to call */
  tool: string;
  /** Parameters (can reference previous step outputs via ${stepId.field}) */
  params: Record<string, unknown>;
  /** If true, workflow pauses here for user approval */
  requiresApproval?: boolean;
  /** Condition: only run if this evaluates true */
  condition?: string;
  /** Retry config */
  retry?: { maxAttempts: number; delayMs: number };
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  /** Optional: inject restatement context every N steps to combat attention decay */
  restatement?: {
    /** Inject restatement every N steps */
    intervalSteps: number;
    /** The context string to restate (key rules, current goal, quality constraints) */
    context: string;
  };
}

export type WorkflowStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface WorkflowInstance {
  id: string;
  definitionId: string;
  status: WorkflowStatus;
  currentStepIndex: number;
  stepResults: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** Initial params passed at creation (merged into each step) */
  params?: Record<string, unknown>;
}

// --- Helpers ---

function generateId(): string {
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve parameter references like ${stepId.field} against stepResults.
 */
function resolveParams(
  params: Record<string, unknown>,
  stepResults: Record<string, unknown>,
  instanceParams?: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_match, ref: string) => {
        const [stepId, ...fieldParts] = ref.split(".");
        const field = fieldParts.join(".");
        // Try stepResults first, then instanceParams
        const stepResult = stepResults[stepId] as Record<string, unknown> | undefined;
        if (stepResult && field in stepResult) {
          return String(stepResult[field]);
        }
        if (instanceParams && stepId in instanceParams && !field) {
          return String(instanceParams[stepId]);
        }
        return `\${${ref}}`; // Leave unresolved
      });
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Evaluate a simple condition string against stepResults.
 * Supports: "stepId.field === value", "stepId.ok", "stepId.field !== value"
 */
function evaluateCondition(condition: string, stepResults: Record<string, unknown>): boolean {
  try {
    // Simple evaluator for "stepId.field" truthiness
    const trimmed = condition.trim();

    // Handle "stepId.field === value"
    const eqMatch = trimmed.match(/^(\S+)\s*===?\s*(.+)$/);
    if (eqMatch) {
      const val = resolveFieldPath(eqMatch[1], stepResults);
      const expected = eqMatch[2].replace(/^["']|["']$/g, "");
      return String(val) === expected;
    }

    // Handle "stepId.field !== value"
    const neqMatch = trimmed.match(/^(\S+)\s*!==?\s*(.+)$/);
    if (neqMatch) {
      const val = resolveFieldPath(neqMatch[1], stepResults);
      const expected = neqMatch[2].replace(/^["']|["']$/g, "");
      return String(val) !== expected;
    }

    // Simple truthiness: "stepId.field"
    const val = resolveFieldPath(trimmed, stepResults);
    return !!val;
  } catch {
    return true; // If condition can't be evaluated, proceed
  }
}

function resolveFieldPath(fieldPath: string, stepResults: Record<string, unknown>): unknown {
  const [stepId, ...parts] = fieldPath.split(".");
  let current: unknown = stepResults[stepId];
  for (const part of parts) {
    if (current && typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- WorkflowEngine ---

export class WorkflowEngine {
  private toolRunner: ToolRunner;
  private dataDir: string;
  private definitions = new Map<string, WorkflowDefinition>();

  constructor(toolRunner: ToolRunner, dataDir: string) {
    this.toolRunner = toolRunner;
    this.dataDir = dataDir;
  }

  /** Register a workflow definition (template) */
  registerDefinition(def: WorkflowDefinition): void {
    this.definitions.set(def.id, def);
  }

  /** Get a registered definition */
  getDefinition(id: string): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  /** List all registered definitions */
  listDefinitions(): WorkflowDefinition[] {
    return Array.from(this.definitions.values());
  }

  private async workflowsDir(): Promise<string> {
    const dir = path.join(this.dataDir, "workflows");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async persistInstance(instance: WorkflowInstance): Promise<void> {
    const dir = await this.workflowsDir();
    await fs.writeFile(
      path.join(dir, `${instance.id}.json`),
      JSON.stringify(instance, null, 2),
      "utf-8",
    );
  }

  private async loadInstance(id: string): Promise<WorkflowInstance | null> {
    const dir = await this.workflowsDir();
    try {
      const raw = await fs.readFile(path.join(dir, `${id}.json`), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Create a workflow instance from a registered definition */
  async create(definitionId: string, params?: Record<string, unknown>): Promise<WorkflowInstance> {
    const def = this.definitions.get(definitionId);
    if (!def) {
      throw new Error(`Workflow definition not found: ${definitionId}`);
    }

    const now = new Date().toISOString();
    const instance: WorkflowInstance = {
      id: generateId(),
      definitionId,
      status: "pending",
      currentStepIndex: 0,
      stepResults: {},
      createdAt: now,
      updatedAt: now,
      params,
    };

    await this.persistInstance(instance);
    return instance;
  }

  /** Start (or resume) a workflow instance */
  async start(instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.loadInstance(instanceId);
    if (!instance) {
      throw new Error(`Workflow instance not found: ${instanceId}`);
    }

    if (instance.status === "completed" || instance.status === "cancelled") {
      return instance;
    }

    const def = this.definitions.get(instance.definitionId);
    if (!def) {
      instance.status = "failed";
      instance.error = `Definition not found: ${instance.definitionId}`;
      instance.updatedAt = new Date().toISOString();
      await this.persistInstance(instance);
      return instance;
    }

    instance.status = "running";
    instance.updatedAt = new Date().toISOString();
    await this.persistInstance(instance);

    return this.executeSteps(instance, def);
  }

  /** Approve a paused workflow step and continue execution */
  async approve(instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.loadInstance(instanceId);
    if (!instance) {
      throw new Error(`Workflow instance not found: ${instanceId}`);
    }

    if (instance.status !== "paused") {
      throw new Error(`Workflow is not paused (status: ${instance.status})`);
    }

    const def = this.definitions.get(instance.definitionId);
    if (!def) {
      instance.status = "failed";
      instance.error = `Definition not found: ${instance.definitionId}`;
      instance.updatedAt = new Date().toISOString();
      await this.persistInstance(instance);
      return instance;
    }

    // Move past the approval step
    instance.currentStepIndex++;
    instance.status = "running";
    instance.updatedAt = new Date().toISOString();
    await this.persistInstance(instance);

    return this.executeSteps(instance, def);
  }

  /** Cancel a workflow */
  async cancel(instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.loadInstance(instanceId);
    if (!instance) {
      throw new Error(`Workflow instance not found: ${instanceId}`);
    }

    instance.status = "cancelled";
    instance.updatedAt = new Date().toISOString();
    await this.persistInstance(instance);
    return instance;
  }

  /** Get current status of a workflow */
  async getStatus(instanceId: string): Promise<WorkflowInstance | null> {
    return this.loadInstance(instanceId);
  }

  /** List all workflow instances */
  async list(): Promise<WorkflowInstance[]> {
    const dir = await this.workflowsDir();
    const files = await fs.readdir(dir);
    const instances: WorkflowInstance[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf-8");
        instances.push(JSON.parse(raw));
      } catch {
        // skip corrupt files
      }
    }
    return instances.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // --- Internal execution ---

  private async executeSteps(
    instance: WorkflowInstance,
    def: WorkflowDefinition,
  ): Promise<WorkflowInstance> {
    while (instance.currentStepIndex < def.steps.length) {
      if (instance.status === "cancelled") break;

      const step = def.steps[instance.currentStepIndex];

      // Check condition
      if (step.condition && !evaluateCondition(step.condition, instance.stepResults)) {
        // Skip this step
        instance.currentStepIndex++;
        instance.updatedAt = new Date().toISOString();
        await this.persistInstance(instance);
        continue;
      }

      // Check approval gate BEFORE executing the step
      if (step.requiresApproval) {
        instance.status = "paused";
        instance.updatedAt = new Date().toISOString();
        await this.persistInstance(instance);
        return instance;
      }

      // Execute step with retries
      const result = await this.executeStepWithRetry(step, instance);

      // Store result
      instance.stepResults[step.id] = result;
      instance.updatedAt = new Date().toISOString();
      await this.persistInstance(instance); // Persist result before advancing

      if (result.ok === false) {
        instance.status = "failed";
        instance.error = `Step "${step.name}" failed: ${(result as ToolResult).error || "unknown error"}`;
        await this.persistInstance(instance);
        return instance;
      }

      // Advance
      instance.currentStepIndex++;

      // Restatement injection — combat attention decay in long workflows
      if (def.restatement && instance.currentStepIndex > 0 && instance.currentStepIndex % def.restatement.intervalSteps === 0) {
        const restateKey = `_restatement_after_${step.id}`;
        instance.stepResults[restateKey] = {
          type: "restatement",
          context: def.restatement.context,
          afterStep: step.id,
          stepIndex: instance.currentStepIndex,
          timestamp: new Date().toISOString(),
        };
      }

      await this.persistInstance(instance);
    }

    if (instance.status !== "cancelled") {
      instance.status = "completed";
      instance.updatedAt = new Date().toISOString();
      await this.persistInstance(instance);
    }

    return instance;
  }

  private async executeStepWithRetry(
    step: WorkflowStep,
    instance: WorkflowInstance,
  ): Promise<ToolResult> {
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    const delayMs = step.retry?.delayMs ?? 0;

    const resolvedParams = resolveParams(step.params, instance.stepResults, instance.params);

    let lastResult: ToolResult = { ok: false, error: "No attempts made" };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await this.toolRunner.execute(step.tool, resolvedParams);

      if (lastResult.ok !== false) {
        return lastResult;
      }

      // Don't delay after the last failed attempt
      if (attempt < maxAttempts && delayMs > 0) {
        await delay(delayMs);
      }
    }

    return lastResult;
  }
}
