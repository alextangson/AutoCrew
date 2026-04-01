/**
 * AutoCrew — Claude Code MCP Server entry point.
 *
 * Exposes the same tools as the OpenClaw plugin via MCP protocol,
 * so Claude Code users get identical capabilities.
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
import { pipelineSchema, executePipeline } from "../src/tools/pipeline.js";
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

function getDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return `${home}/.autocrew`;
}

const dataDir = getDataDir();

/**
 * MCP tool definitions — same schema and execute functions as OpenClaw tools.
 * These will be registered with the MCP SDK when we add the dependency.
 * For now, this serves as the structural contract.
 */
export const tools = [
  {
    name: "autocrew_topic",
    description:
      "Create or list content topics. Use action='create' with title/description/tags, or action='list'.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list"] },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        source: { type: "string" },
      },
      required: ["action"],
    },
    execute: (params: Record<string, unknown>) =>
      executeTopicCreate({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_research",
    description:
      "Topic discovery with multiple modes: browser-first (Pro), API fallback, free (web search + viral scoring), or manual. " +
      "action='discover' generates/saves topics, action='session_status' inspects browser login readiness.",
    inputSchema: researchSchema,
    execute: (params: Record<string, unknown>) =>
      executeResearch({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_content",
    description:
      "Manage content lifecycle. Actions: 'save' (title+body), 'list', 'get' (id), 'update' (id+fields), " +
      "'transition' (id+target_status, validated state machine), 'create_variant' (topicId+platform), " +
      "'siblings' (id), 'allowed_transitions' (id).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "list", "get", "update", "transition", "create_variant", "siblings", "allowed_transitions"],
        },
        id: { type: "string", description: "Content id" },
        title: { type: "string" },
        body: { type: "string" },
        platform: { type: "string", description: "xhs, douyin, wechat_video, wechat_mp, bilibili" },
        topicId: { type: "string" },
        status: {
          type: "string",
          enum: [
            "topic_saved", "drafting", "draft_ready", "reviewing", "revision",
            "approved", "cover_pending", "publish_ready", "publishing", "published", "archived",
            "draft", "review",
          ],
        },
        target_status: {
          type: "string",
          enum: [
            "topic_saved", "drafting", "draft_ready", "reviewing", "revision",
            "approved", "cover_pending", "publish_ready", "publishing", "published", "archived",
          ],
          description: "Target status for 'transition' action",
        },
        tags: { type: "array", items: { type: "string" } },
        hashtags: { type: "array", items: { type: "string" }, description: "Platform-specific hashtags" },
        siblings: { type: "array", items: { type: "string" }, description: "Sibling content IDs" },
        publish_url: { type: "string", description: "Published URL on target platform" },
        performance_data: {
          type: "object",
          additionalProperties: { type: "number" },
          description: "Performance metrics: views, likes, comments, shares, etc.",
        },
        force: { type: "boolean", description: "Force transition bypassing validation" },
        diff_note: { type: "string", description: "Note for revision diff tracking" },
      },
      required: ["action"],
    },
    execute: (params: Record<string, unknown>) =>
      executeContentSave({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_status",
    description: "Show AutoCrew pipeline status: topic count, content count, status breakdown.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: { type: "boolean" },
      },
    },
    execute: (params: Record<string, unknown>) =>
      executeStatus({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_asset",
    description:
      "Manage content project assets (covers, B-Roll, images, videos, subtitles) and version history. Actions: 'add' (filename + asset_type + optional source_path), 'list', 'remove' (filename), 'versions' (list version history), 'get_version' (version number), 'revert' (version number).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "remove", "versions", "get_version", "revert"] },
        content_id: { type: "string" },
        filename: { type: "string" },
        asset_type: { type: "string", enum: ["cover", "broll", "image", "video", "audio", "subtitle", "other"] },
        description: { type: "string" },
        source_path: { type: "string" },
        version: { type: "number" },
      },
      required: ["action", "content_id"],
    },
    execute: (params: Record<string, unknown>) =>
      executeAsset({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_pipeline",
    description:
      "Manage automated content pipelines. Actions: 'create' (from template or custom), 'list', 'get' (by id), 'enable'/'disable', 'delete', 'templates' (show presets: daily-research, weekly-content, daily-publish, full-pipeline).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "get", "enable", "disable", "delete", "templates"] },
        id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        schedule: { type: "string" },
        template: { type: "string" },
      },
      required: ["action"],
    },
    execute: (params: Record<string, unknown>) =>
      executePipeline({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_publish",
    description:
      "Run publishing flows. Currently supports action='wechat_mp_draft' for WeChat MP draft publishing.",
    inputSchema: publishSchema,
    execute: (params: Record<string, unknown>) =>
      executePublish({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_humanize",
    description:
      "Run the Chinese de-AI pass. Supports action='humanize_zh' for raw text or saved drafts.",
    inputSchema: humanizeSchema,
    execute: (params: Record<string, unknown>) =>
      executeHumanize({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_rewrite",
    description:
      "Create platform-native rewrites. Supports action='adapt_platform' for single platform, " +
      "action='batch_adapt' for multiple platforms with auto title/hashtag and sibling linking.",
    inputSchema: rewriteSchema,
    execute: (params: Record<string, unknown>) =>
      executeRewrite({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_cover_review",
    description:
      "Manage Xiaohongshu cover review state. Supports creating A/B/C candidates, reading review state, and approving one label.",
    inputSchema: coverReviewSchema,
    execute: (params: Record<string, unknown>) =>
      executeCoverReview({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_memory",
    description:
      "Capture user feedback into MEMORY.md or read current memory. Supports action='capture_feedback' and action='get_memory'.",
    inputSchema: memorySchema,
    execute: (params: Record<string, unknown>) =>
      executeMemory({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_review",
    description:
      "Content review: sensitive word scan + de-AI check + quality scoring. " +
      "Actions: 'full_review' (all checks), 'scan_only' (sensitive words), " +
      "'quality_score' (score only), 'auto_fix' (apply fixes and save).",
    inputSchema: reviewSchema,
    execute: (params: Record<string, unknown>) =>
      executeReview({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_pre_publish",
    description:
      "Pre-publish checklist gate. Runs 6 checks (content review, cover review, hashtags, title, platform, body length) " +
      "before allowing publish. Action: 'check'.",
    inputSchema: prePublishSchema,
    execute: (params: Record<string, unknown>) =>
      executePrePublish({ ...params, _dataDir: dataDir }),
  },
  {
    name: "autocrew_init",
    description:
      "Initialize the AutoCrew data directory (~/.autocrew/) and creator profile. Safe to run multiple times.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: (_params: Record<string, unknown>) => executeInit({ dataDir }),
  },
  {
    name: "autocrew_pro_status",
    description:
      "Check AutoCrew Pro status: whether Pro is active, profile completeness, and missing info.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: async (_params: Record<string, unknown>) => {
      const proStatus = await getProStatus(dataDir);
      const profile = await loadProfile(dataDir);
      const missing = profile ? detectMissingInfo(profile) : ["profile_not_initialized"];
      return {
        ok: true,
        isPro: proStatus.isPro,
        profileExists: profile !== null,
        missingInfo: missing,
        styleCalibrated: profile?.styleCalibrated ?? false,
      };
    },
  },
];

// --- Stdio MCP transport (minimal) ---
// When run as a subprocess, reads JSON-RPC from stdin, writes to stdout.

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });

  function respond(id: unknown, result: unknown) {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
    process.stdout.write(msg + "\n");
  }

  function respondError(id: unknown, code: number, message: string) {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
    process.stdout.write(msg + "\n");
  }

  rl.on("line", async (line: string) => {
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }

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
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }
      try {
        const result = await tool.execute(toolArgs);
        respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err: any) {
        respond(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      return;
    }

    // Unknown method
    if (id !== undefined) {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  });
}
