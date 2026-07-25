import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { getDataDir } from "../storage/local-store.js";
import { makePiModel } from "../engine/pi-wire.js";
import { registerExchange } from "../engine/observer.js";
import type { LoopTool } from "../engine/loop.js";
import type { AgentRunOptions, AgentRunResult, AgentRuntime } from "./runtime.js";

const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

function safeNotify(callback: AgentRunOptions["onEvent"], type: "tool_start" | "tool_end", tool: string): void {
  if (!callback) return;
  try {
    callback({ type, tool });
  } catch {
    // Observability must not break execution.
  }
}

function toPiTool(tool: LoopTool): ToolDefinition {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await tool.execute(params as Record<string, unknown>);
      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });
}

async function createClosedResourceLoader(
  dataDir: string,
  systemPrompt: string,
  settingsManager: SettingsManager,
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: dataDir,
    agentDir: path.join(dataDir, "pi-agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await loader.reload();
  return loader;
}

export interface PiAgentSessionProbe {
  activeTools: string[];
  sessionId: string;
  dispose(): void;
}

interface CreateClosedSessionOptions {
  config: Parameters<AgentRuntime["run"]>[0];
  options: AgentRunOptions;
  upstreamBaseUrl?: string;
}

/**
 * Exported for the security contract test. Creating the session performs no
 * provider request and must expose exactly the injected AutoCrew tools.
 */
export async function createClosedPiAgentSession(
  input: CreateClosedSessionOptions,
): Promise<PiAgentSessionProbe & { session: Awaited<ReturnType<typeof createAgentSession>>["session"] }> {
  const dataDir = getDataDir(input.config.dataDir);
  const credentials = new InMemoryCredentialStore();
  const provider = input.config.protocol === "anthropic" ? "anthropic" : "openai";
  await credentials.modify(provider, async () => ({ type: "api_key", key: input.config.apiKey }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory(
    {
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 20_000 },
      enableAnalytics: false,
      enableInstallTelemetry: false,
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      enableSkillCommands: false,
    },
    { projectTrusted: false },
  );
  const customTools = (input.options.tools ?? []).map(toPiTool);
  const toolNames = customTools.map((tool) => tool.name);
  const resourceLoader = await createClosedResourceLoader(dataDir, input.options.systemPrompt, settingsManager);
  const model = makePiModel(
    input.config,
    input.options.model,
    input.upstreamBaseUrl ?? input.config.baseUrl,
  );
  const { session } = await createAgentSession({
    cwd: dataDir,
    agentDir: path.join(dataDir, "pi-agent"),
    modelRuntime,
    model,
    thinkingLevel: "off",
    noTools: "all",
    tools: toolNames,
    customTools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(dataDir),
    settingsManager,
  });
  const activeTools = session.getActiveToolNames().sort();
  const expected = [...toolNames].sort();
  if (JSON.stringify(activeTools) !== JSON.stringify(expected)) {
    session.dispose();
    throw new Error(
      `PiAgent 工具白名单断言失败:expected=${expected.join(",")} active=${activeTools.join(",")}`,
    );
  }
  return {
    session,
    activeTools,
    sessionId: session.sessionId,
    dispose: () => session.dispose(),
  };
}

export const piAgentRuntime: AgentRuntime = {
  kind: "pi-agent",
  async run(config, options): Promise<AgentRunResult> {
    const exchange = await registerExchange({
      upstreamBase: config.baseUrl,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      idleMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    });
    const closed = await createClosedPiAgentSession({
      config,
      options,
      upstreamBaseUrl: exchange.baseUrl,
    });
    const { session } = closed;
    const maxTurns = options.maxTurns ?? 6;
    const maxTotalTokens = options.maxTotalTokens ?? 20_000;
    let turns = 0;
    let budgetStop: "max_turns" | "max_tokens" | undefined;

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start") turns += 1;
      if (event.type === "tool_execution_start") {
        safeNotify(options.onEvent, "tool_start", event.toolName);
      }
      if (event.type === "tool_execution_end") {
        safeNotify(options.onEvent, "tool_end", event.toolName);
      }
      if (event.type !== "turn_end") return;
      const tokens = session.getSessionStats().tokens.total;
      if (turns >= maxTurns) budgetStop = "max_turns";
      else if (tokens >= maxTotalTokens) budgetStop = "max_tokens";
      if (budgetStop && !session.isIdle) void session.abort();
    });

    try {
      try {
        await session.prompt(options.userMessage, { expandPromptTemplates: false, source: "rpc" });
      } catch (error) {
        if (!budgetStop) throw error;
      }
      const stats = session.getSessionStats();
      return {
        finalMessage: session.getLastAssistantText() ?? "",
        turns: Math.max(turns, stats.assistantMessages > 0 ? 1 : 0),
        totalTokens: stats.tokens.total,
        toolCallCount: stats.toolCalls,
        stopReason: budgetStop ?? "no_tool_calls",
        runtime: "pi-agent",
        sessionId: session.sessionId,
      };
    } finally {
      unsubscribe();
      closed.dispose();
      exchange.release();
    }
  },
};
