/**
 * SPIKE: Thin agent loop — Day 2, Route A
 * DO NOT import into src/. Throwaway validation code.
 *
 * Drives an OpenAI-compatible model through tool-use rounds.
 * Budget caps: maxTurns (loop iterations) + maxTotalTokens.
 */

import { readFileSync } from "fs";
import { join } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface CompletionResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface LoopConfig {
  model: string;
  maxTurns: number;
  maxTotalTokens: number;
  systemPrompt: string;
  userMessage: string;
}

interface LoopResult {
  finalMessage: string;
  turns: number;
  totalTokens: number;
  toolCallCount: number;
  stopReason: "no_tool_calls" | "max_turns" | "max_tokens";
  wallMs: number;
}

// ─── Config from .env ────────────────────────────────────────────────────────

function loadEnv(): { apiKey: string; baseUrl: string } {
  const envPath = new URL(".env", import.meta.url).pathname;
  const raw = readFileSync(envPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.includes("="));
  const env: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf("=");
    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const apiKey = env["DEEPSEEK_API_KEY"];
  const baseUrl = env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com";
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not found in .env");
  return { apiKey, baseUrl };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_creator_profile",
      description:
        "Read the creator's profile: industry, platforms, and writingRules. Call this before writing any content.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

function executeTool(name: string, _args: unknown): string {
  if (name === "read_creator_profile") {
    const profilePath = join(process.env.HOME ?? "/Users/macmini", ".autocrew/creator-profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    return JSON.stringify({
      industry: profile.industry,
      platforms: profile.platforms,
      writingRules: profile.writingRules,
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── Core loop ────────────────────────────────────────────────────────────────

async function runLoop(config: LoopConfig): Promise<LoopResult> {
  const { apiKey, baseUrl } = loadEnv();
  const startMs = Date.now();

  const messages: Message[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: config.userMessage },
  ];

  let turns = 0;
  let totalTokens = 0;
  let toolCallCount = 0;
  let stopReason: LoopResult["stopReason"] = "no_tool_calls";

  while (turns < config.maxTurns) {
    if (totalTokens >= config.maxTotalTokens) {
      stopReason = "max_tokens";
      break;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as CompletionResponse;
    turns++;
    totalTokens += data.usage?.total_tokens ?? 0;

    const choice = data.choices[0];
    const assistantMsg = choice.message;
    messages.push({ role: "assistant", content: assistantMsg.content, tool_calls: assistantMsg.tool_calls });

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      stopReason = "no_tool_calls";
      break;
    }

    // Execute each tool call and append results
    for (const tc of assistantMsg.tool_calls) {
      toolCallCount++;
      let result: string;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        result = executeTool(tc.function.name, args);
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: result, name: tc.function.name });
    }

    if (turns >= config.maxTurns) {
      stopReason = "max_turns";
    }
  }

  const finalMessage =
    [...messages].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "(no content)";

  return {
    finalMessage,
    turns,
    totalTokens,
    toolCallCount,
    stopReason,
    wallMs: Date.now() - startMs,
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

export { runLoop };
export type { LoopConfig, LoopResult };
