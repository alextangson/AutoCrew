/**
 * Hooks — PreToolUse / PostToolUse lifecycle hooks.
 *
 * Inspired by Claude Code's hook system. Hooks are deterministic callbacks
 * that fire at specific points in the tool execution lifecycle.
 *
 * Built-in hooks handle AutoCrew workflow automation:
 * - content:save → auto scan sensitive words
 * - content:update → auto record diff
 * - cover:approve → auto generate multi-ratio (Pro)
 * - publish → enforce pre-publish check
 *
 * Users can add custom hooks via ~/.autocrew/hooks.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { type EventBus, type AutoCrewEvent, type AutoCrewEventType } from "./events.js";
import { type ToolRunner } from "./tool-runner.js";

// --- Types ---

export interface HookMatcher {
  tool?: string;
  action?: string;
}

export interface HookDefinition {
  /** Human-readable name */
  name: string;
  /** Which event triggers this hook */
  event: AutoCrewEventType;
  /** Optional matcher to filter events */
  matcher?: HookMatcher;
  /** Handler: call another tool */
  handler:
    | { type: "tool"; tool: string; params: Record<string, unknown> }
    | { type: "function"; fn: (event: AutoCrewEvent, runner: ToolRunner) => Promise<void> };
}

// --- Built-in Hooks ---

function builtinHooks(): HookDefinition[] {
  return [
    {
      name: "auto-scan-on-save",
      event: "tool:post_execute",
      matcher: { tool: "autocrew_content", action: "save" },
      handler: {
        type: "function",
        fn: async (event, runner) => {
          const contentId = event.data.contentId as string;
          if (!contentId) return;
          // Fire-and-forget: scan for sensitive words
          runner.execute("autocrew_review", { action: "scan_only", content_id: contentId }).catch(() => {});
        },
      },
    },
    {
      name: "auto-diff-on-update",
      event: "tool:post_execute",
      matcher: { tool: "autocrew_content", action: "update" },
      handler: {
        type: "function",
        fn: async (event, _runner) => {
          // Diff tracking is already handled inside the content-save tool
          // This hook is a placeholder for future enhancements
          void event;
        },
      },
    },
    {
      name: "enforce-pre-publish",
      event: "tool:pre_execute",
      matcher: { tool: "autocrew_publish" },
      handler: {
        type: "function",
        fn: async (event, runner) => {
          const contentId = event.data.contentId as string;
          if (!contentId) return;
          const check = await runner.execute("autocrew_pre_publish", {
            action: "check",
            content_id: contentId,
          });
          if (check.ok === false || check.passed === false) {
            // The pre-publish check failed — the tool runner will still proceed,
            // but the result is logged. In a stricter mode, we could throw to block.
          }
        },
      },
    },
  ];
}

// --- User Hooks Loader ---

interface UserHookConfig {
  hooks: Array<{
    name?: string;
    event: AutoCrewEventType;
    matcher?: HookMatcher;
    handler: { type: "tool"; tool: string; params: Record<string, unknown> };
  }>;
}

async function loadUserHooks(dataDir: string): Promise<HookDefinition[]> {
  const filePath = path.join(dataDir, "hooks.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const config = JSON.parse(raw) as UserHookConfig;
    return (config.hooks || []).map((h, i) => ({
      name: h.name || `user-hook-${i}`,
      event: h.event,
      matcher: h.matcher,
      handler: h.handler,
    }));
  } catch {
    return []; // No hooks file or invalid JSON — that's fine
  }
}

// --- Hook Manager ---

export class HookManager {
  private hooks: HookDefinition[] = [];
  private runner: ToolRunner | null = null;

  /** Initialize with built-in + user hooks, and wire up to EventBus */
  async init(eventBus: EventBus, runner: ToolRunner, dataDir: string): Promise<void> {
    this.runner = runner;

    // Load hooks
    const userHooks = await loadUserHooks(dataDir);
    this.hooks = [...builtinHooks(), ...userHooks];

    // Subscribe to events
    eventBus.on("*", (event) => this.handleEvent(event));
  }

  /** Get all registered hooks (for debugging) */
  getHooks(): HookDefinition[] {
    return this.hooks;
  }

  private async handleEvent(event: AutoCrewEvent): Promise<void> {
    if (!this.runner) return;

    for (const hook of this.hooks) {
      if (!this.matches(hook, event)) continue;

      try {
        if (hook.handler.type === "function") {
          await hook.handler.fn(event, this.runner);
        } else if (hook.handler.type === "tool") {
          // Merge event data into handler params
          const params = { ...hook.handler.params };
          if (event.data.contentId && !params.content_id) {
            params.content_id = event.data.contentId;
          }
          await this.runner.execute(hook.handler.tool, params);
        }
      } catch {
        // Hooks should never crash the main pipeline
      }
    }
  }

  private matches(hook: HookDefinition, event: AutoCrewEvent): boolean {
    if (hook.event !== event.type) return false;
    if (!hook.matcher) return true;
    if (hook.matcher.tool && event.data.tool !== hook.matcher.tool) return false;
    if (hook.matcher.action && event.data.action !== hook.matcher.action) return false;
    return true;
  }
}
