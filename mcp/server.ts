/**
 * AutoCrew — Claude Code MCP Server entry point.
 *
 * Exposes the same tools as the OpenClaw plugin via MCP protocol,
 * using the shared ToolRunner for consistent middleware behavior.
 *
 * Usage:
 *   In .claude-plugin/plugin.json, this is referenced as an MCP server.
 *   Or run standalone: node --loader ts-node/esm mcp/server.ts
 */
import { topicCreateSchema, executeTopicCreate } from "../src/tools/topic-create.js";
import { researchSchema, executeResearch } from "../src/tools/research.js";
import { contentSaveSchema, executeContentSave } from "../src/tools/content-save.js";
import { statusSchema, executeStatus } from "../src/tools/status.js";
import { assetSchema, executeAsset } from "../src/tools/asset.js";
import { pipelineSchema, createPipelineExecutor } from "../src/tools/pipeline.js";
import { publishSchema, executePublish } from "../src/tools/publish.js";
import { humanizeSchema, executeHumanize } from "../src/tools/humanize.js";
import { rewriteSchema, executeRewrite } from "../src/tools/rewrite.js";
import { coverReviewSchema, executeCoverReview } from "../src/tools/cover-review.js";
import { memorySchema, executeMemory } from "../src/tools/memory.js";
import { reviewSchema, executeReview } from "../src/tools/review.js";
import { prePublishSchema, executePrePublish } from "../src/tools/pre-publish.js";
import { executeInit } from "../src/tools/init.js";
import { getProStatus } from "../src/modules/pro/gate.js";
import { loadProfile, detectMissingInfo } from "../src/modules/profile/creator-profile.js";
import { createContext } from "../src/runtime/context.js";
import { ToolRunner } from "../src/runtime/tool-runner.js";
import { EventBus } from "../src/runtime/events.js";
import { HookManager } from "../src/runtime/hooks.js";

// --- Initialize Runtime ---

const ctx = createContext();
const eventBus = new EventBus();
const runner = new ToolRunner({ ctx, eventBus });
const hookManager = new HookManager();

// Register all tools (same definitions as index.ts)
runner.register({ name: "autocrew_topic", label: "AutoCrew Topic", description: "Create or list content topics. Actions: create, list.", parameters: topicCreateSchema, execute: executeTopicCreate });
runner.register({ name: "autocrew_research", label: "AutoCrew Research", description: "Topic discovery. Actions: discover, session_status.", parameters: researchSchema, execute: executeResearch });
runner.register({ name: "autocrew_content", label: "AutoCrew Content", description: "Content lifecycle. Actions: save, list, get, update, transition, create_variant, siblings.", parameters: contentSaveSchema, execute: executeContentSave });
runner.register({ name: "autocrew_status", label: "AutoCrew Status", description: "Pipeline status dashboard.", parameters: statusSchema, execute: executeStatus });
runner.register({ name: "autocrew_asset", label: "AutoCrew Asset", description: "Content asset + version management. Actions: add, list, remove, versions, get_version, revert.", parameters: assetSchema, execute: executeAsset });
runner.register({ name: "autocrew_pipeline", label: "AutoCrew Pipeline", description: "Workflow orchestration for content pipelines. Actions: create, start, status, approve, cancel, list, templates.", parameters: pipelineSchema, execute: createPipelineExecutor(runner) });
runner.register({ name: "autocrew_publish", label: "AutoCrew Publish", description: "Publishing flows. Actions: wechat_mp_draft.", parameters: publishSchema, execute: executePublish });
runner.register({ name: "autocrew_humanize", label: "AutoCrew Humanize", description: "Chinese de-AI pass. Actions: humanize_zh.", parameters: humanizeSchema, execute: executeHumanize });
runner.register({ name: "autocrew_rewrite", label: "AutoCrew Rewrite", description: "Platform-native rewrites. Actions: adapt_platform, batch_adapt.", parameters: rewriteSchema, execute: executeRewrite });
runner.register({ name: "autocrew_cover_review", label: "AutoCrew Cover Review", description: "Cover image generation + review via Gemini. Actions: create_candidates, get, approve, generate_ratios.", parameters: coverReviewSchema, execute: executeCoverReview, needsGemini: true });
runner.register({ name: "autocrew_memory", label: "AutoCrew Memory", description: "Feedback capture to MEMORY.md. Actions: capture_feedback, get_memory.", parameters: memorySchema, execute: executeMemory });
runner.register({ name: "autocrew_review", label: "AutoCrew Review", description: "Content review: sensitive words + quality + de-AI. Actions: full_review, scan_only, quality_score, auto_fix.", parameters: reviewSchema, execute: executeReview });
runner.register({ name: "autocrew_pre_publish", label: "AutoCrew Pre-Publish", description: "Pre-publish gate: 6 checks. Actions: check.", parameters: prePublishSchema, execute: executePrePublish });
runner.register({ name: "autocrew_init", label: "AutoCrew Init", description: "Initialize ~/.autocrew/ and creator profile.", parameters: { type: "object" as const, properties: {} }, execute: async (params) => executeInit({ dataDir: params._dataDir as string }) });
runner.register({
  name: "autocrew_pro_status", label: "AutoCrew Pro Status", description: "Check Pro status + profile completeness.",
  parameters: { type: "object" as const, properties: {} },
  execute: async (params) => {
    const dir = params._dataDir as string;
    const proStatus = await getProStatus(dir);
    const profile = await loadProfile(dir);
    const missing = profile ? detectMissingInfo(profile) : ["profile_not_initialized"];
    return { ok: true, isPro: proStatus.isPro, profileExists: profile !== null, missingInfo: missing, styleCalibrated: profile?.styleCalibrated ?? false };
  },
});

// Initialize hooks
hookManager.init(eventBus, runner, ctx.dataDir).catch(() => {});

// --- Export for programmatic use ---

export { runner, ctx, eventBus };

// --- Stdio MCP transport ---

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });

  function respond(id: unknown, result: unknown) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  function respondError(id: unknown, code: number, message: string) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }

  rl.on("line", async (line: string) => {
    let req: any;
    try { req = JSON.parse(line); } catch { return; }

    const { id, method, params } = req;

    if (method === "initialize") {
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "autocrew", version: "0.1.0" },
      });
      return;
    }

    if (method === "tools/list") {
      respond(id, {
        tools: runner.getTools().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      if (!runner.getTool(toolName)) {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }
      try {
        const result = await runner.execute(toolName, toolArgs);
        respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err: any) {
        respond(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
      return;
    }

    if (id !== undefined) {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  });
}
