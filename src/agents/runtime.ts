import type { EngineConfig } from "../engine/config.js";
import type { LoopEvent, LoopResult, LoopTool } from "../engine/loop.js";

export interface AgentRunOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools?: LoopTool[];
  maxTurns?: number;
  maxTotalTokens?: number;
  fetchImpl?: typeof fetch;
  idleTimeoutMs?: number;
  onEvent?: (event: LoopEvent) => void;
  logMeta?: { runId?: string; agent?: string };
}

export interface AgentRunResult extends LoopResult {
  runtime: "loop" | "pi-agent";
  sessionId?: string;
}

/**
 * Inner application port. PiAgent and the legacy thin loop are replaceable
 * adapters; campaign use cases depend only on this contract.
 */
export interface AgentRuntime {
  readonly kind: AgentRunResult["runtime"];
  run(config: EngineConfig, options: AgentRunOptions): Promise<AgentRunResult>;
}
