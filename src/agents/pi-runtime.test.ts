import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineConfig } from "../engine/config.js";
import { anthropicSse, sseResponse } from "../engine/sse-fixtures.js";
import { createClosedPiAgentSession, piAgentRuntime } from "./pi-runtime.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pi-session-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("closed PiAgent session", () => {
  it("disables every built-in/resource-discovered tool and exposes only the injected allowlist", async () => {
    const config: EngineConfig = {
      apiKey: "!literal-test-key",
      baseUrl: "https://example.invalid",
      protocol: "anthropic",
      strongModel: "test-model",
      fastModel: "test-model",
      dataDir,
    };
    const closed = await createClosedPiAgentSession({
      config,
      options: {
        model: "test-model",
        systemPrompt: "Only use approved tools.",
        userMessage: "noop",
        tools: [
          {
            name: "submit_artifact",
            description: "Submit a local artifact",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            execute: () => "ok",
          },
        ],
      },
    });
    try {
      expect(closed.activeTools).toEqual(["submit_artifact"]);
      expect(closed.activeTools).not.toEqual(expect.arrayContaining(["bash", "read", "write", "edit"]));
    } finally {
      closed.dispose();
    }
  });

  it("runs a real AgentSession tool roundtrip through the isolated observer transport", async () => {
    const config: EngineConfig = {
      apiKey: "test-key",
      baseUrl: "https://example.invalid",
      protocol: "anthropic",
      strongModel: "test-model",
      fastModel: "test-model",
      dataDir,
    };
    const upstream = [
      anthropicSse({
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "submit_artifact",
            input: { title: "动态工作流" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 4 },
      }),
      anthropicSse({
        content: [{ type: "text", text: "已提交" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 2 },
      }),
    ];
    let request = 0;
    const calls: Array<Record<string, unknown>> = [];
    const result = await piAgentRuntime.run(config, {
      model: "test-model",
      systemPrompt: "Submit the artifact.",
      userMessage: "Create it.",
      fetchImpl: (async () => sseResponse(upstream[request++])) as typeof fetch,
      tools: [
        {
          name: "submit_artifact",
          description: "Submit a local artifact",
          parameters: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
          execute(args) {
            calls.push(args);
            return "saved";
          },
        },
      ],
    });
    expect(calls).toEqual([{ title: "动态工作流" }]);
    expect(result).toMatchObject({
      finalMessage: "已提交",
      runtime: "pi-agent",
      toolCallCount: 1,
      stopReason: "no_tool_calls",
    });
    expect(request).toBe(2);
  });
});
