/**
 * AutoCrew Dashboard — standalone entry point.
 *
 * Usage: node --loader ts-node/esm src/server/start.ts [--port 3000]
 */
import { serve } from "@hono/node-server";
import { createContext } from "../runtime/context.js";
import { EventBus } from "../runtime/events.js";
import { ToolRunner } from "../runtime/tool-runner.js";
import { HookManager } from "../runtime/hooks.js";
import { WorkflowEngine } from "../runtime/workflow-engine.js";
import { createApp } from "./index.js";

// Re-use the same tool registry as the OpenClaw plugin
import { topicCreateSchema, executeTopicCreate } from "../tools/topic-create.js";
import { researchSchema, executeResearch } from "../tools/research.js";
import { contentSaveSchema, executeContentSave } from "../tools/content-save.js";
import { statusSchema, executeStatus } from "../tools/status.js";
import { assetSchema, executeAsset } from "../tools/asset.js";
import { pipelineSchema, createPipelineExecutor } from "../tools/pipeline.js";
import { publishSchema, executePublish } from "../tools/publish.js";
import { humanizeSchema, executeHumanize } from "../tools/humanize.js";
import { rewriteSchema, executeRewrite } from "../tools/rewrite.js";
import { coverReviewSchema, executeCoverReview } from "../tools/cover-review.js";
import { memorySchema, executeMemory } from "../tools/memory.js";
import { reviewSchema, executeReview } from "../tools/review.js";
import { prePublishSchema, executePrePublish } from "../tools/pre-publish.js";
import { executeInit } from "../tools/init.js";
import { getProStatus } from "../modules/pro/gate.js";
import { loadProfile, detectMissingInfo } from "../modules/profile/creator-profile.js";

// --- Parse CLI args ---

function parsePort(args: string[]): number {
  const idx = args.indexOf("--port");
  if (idx !== -1 && args[idx + 1]) {
    const port = Number(args[idx + 1]);
    if (!Number.isNaN(port) && port > 0 && port < 65536) return port;
  }
  return 3000;
}

// --- Register all tools (mirrors index.ts registerAllTools) ---

function registerAllTools(runner: ToolRunner): void {
  runner.register({
    name: "autocrew_topic",
    label: "AutoCrew Topic",
    description: "Create or list content topics. Actions: create, list.",
    parameters: topicCreateSchema,
    execute: executeTopicCreate,
  });

  runner.register({
    name: "autocrew_research",
    label: "AutoCrew Research",
    description: "Topic discovery with multiple modes.",
    parameters: researchSchema,
    execute: executeResearch,
  });

  runner.register({
    name: "autocrew_content",
    label: "AutoCrew Content",
    description: "Manage content lifecycle: save, list, get, update, transition, list_siblings, create_variant.",
    parameters: contentSaveSchema,
    execute: executeContentSave,
  });

  runner.register({
    name: "autocrew_status",
    label: "AutoCrew Status",
    description: "Show pipeline status.",
    parameters: statusSchema,
    execute: executeStatus,
  });

  runner.register({
    name: "autocrew_asset",
    label: "AutoCrew Asset",
    description: "Manage content project assets and version history.",
    parameters: assetSchema,
    execute: executeAsset,
  });

  runner.register({
    name: "autocrew_pipeline",
    label: "AutoCrew Pipeline",
    description: "Workflow orchestration for content pipelines.",
    parameters: pipelineSchema,
    execute: createPipelineExecutor(runner),
  });

  runner.register({
    name: "autocrew_publish",
    label: "AutoCrew Publish",
    description: "Run proven publishing flows.",
    parameters: publishSchema,
    execute: executePublish,
  });

  runner.register({
    name: "autocrew_humanize",
    label: "AutoCrew Humanize",
    description: "Run the Chinese de-AI pass on content text.",
    parameters: humanizeSchema,
    execute: executeHumanize,
  });

  runner.register({
    name: "autocrew_rewrite",
    label: "AutoCrew Rewrite",
    description: "Create platform-native rewrites.",
    parameters: rewriteSchema,
    execute: executeRewrite,
  });

  runner.register({
    name: "autocrew_cover_review",
    label: "AutoCrew Cover Review",
    description: "Generate, review, and approve cover images via Gemini.",
    parameters: coverReviewSchema,
    execute: executeCoverReview,
    needsGemini: true,
  });

  runner.register({
    name: "autocrew_memory",
    label: "AutoCrew Memory",
    description: "Capture user feedback into MEMORY.md or read current memory.",
    parameters: memorySchema,
    execute: executeMemory,
  });

  runner.register({
    name: "autocrew_review",
    label: "AutoCrew Review",
    description: "Content review: sensitive words scan + quality score + de-AI check.",
    parameters: reviewSchema,
    execute: executeReview,
  });

  runner.register({
    name: "autocrew_pre_publish",
    label: "AutoCrew Pre-Publish",
    description: "Pre-publish gate: 6 checks before allowing publish.",
    parameters: prePublishSchema,
    execute: executePrePublish,
  });

  runner.register({
    name: "autocrew_init",
    label: "AutoCrew Init",
    description: "Initialize the AutoCrew data directory and creator profile.",
    parameters: { type: "object" as const, properties: {} },
    execute: async (params) => executeInit({ dataDir: params._dataDir as string }),
  });

  runner.register({
    name: "autocrew_pro_status",
    label: "AutoCrew Pro Status",
    description: "Check AutoCrew Pro status.",
    parameters: { type: "object" as const, properties: {} },
    execute: async (params) => {
      const dir = params._dataDir as string;
      const proStatus = await getProStatus(dir);
      const profile = await loadProfile(dir);
      const missing = profile ? detectMissingInfo(profile) : ["profile_not_initialized"];
      return {
        ok: true,
        isPro: proStatus.isPro,
        profileExists: profile !== null,
        missingInfo: missing,
        styleCalibrated: profile?.styleCalibrated ?? false,
      };
    },
  });
}

// --- Main ---

async function main(): Promise<void> {
  const port = parsePort(process.argv);

  // Create runtime
  const ctx = createContext();
  const eventBus = new EventBus();
  const runner = new ToolRunner({ ctx, eventBus });

  // Register tools
  registerAllTools(runner);

  // Initialize hooks
  const hookManager = new HookManager();
  await hookManager.init(eventBus, runner, ctx.dataDir).catch(() => {});

  // Initialize workflow engine
  const workflowEngine = new WorkflowEngine(runner, ctx.dataDir);

  // Create and start server
  const app = createApp({ runner, eventBus, workflowEngine });

  console.log(`AutoCrew Dashboard: http://localhost:${port}`);

  serve({
    fetch: app.fetch,
    port,
  });
}

main().catch((err) => {
  console.error("Failed to start AutoCrew server:", err);
  process.exit(1);
});
