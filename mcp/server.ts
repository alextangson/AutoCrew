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
import { contentSaveSchema, executeContentSave } from "../src/tools/content-save.js";
import { statusSchema, executeStatus } from "../src/tools/status.js";
import { assetSchema, executeAsset } from "../src/tools/asset.js";
import { pipelineSchema, executePipeline } from "../src/tools/pipeline.js";

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
    name: "autocrew_content",
    description:
      "Save, list, get, or update content drafts. action='save' needs title+body, 'list' shows all, 'get'/'update' need id.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["save", "list", "get", "update"] },
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        platform: { type: "string" },
        topicId: { type: "string" },
        status: { type: "string", enum: ["draft", "review", "approved", "published"] },
        tags: { type: "array", items: { type: "string" } },
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
