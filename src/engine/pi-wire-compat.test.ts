/**
 * makePiModel 的方言判定回归（spec 2026-10-25-tokencamel-touchpoint §8-4）：
 * DeepSeek 模型挂在第三方 OpenAI 兼容中转地址下，靠模型 id 一票钉上 reasoning 兼容；Claude 模型不带。
 * 判定读的是真实上游 config.baseUrl，第三个参数只是观察器的环回地址。
 */
import { describe, expect, it } from "vitest";
import type { EngineConfig } from "./config.js";
import { makePiModel } from "./pi-wire.js";

const relay = { baseUrl: "https://api.tokencamel.com/v1", protocol: "openai" } as unknown as EngineConfig;
const LOOPBACK = "http://127.0.0.1:5555/x";

describe("makePiModel · 中转地址下的 DeepSeek 方言", () => {
  it("TokenCamel 地址 + DeepSeek-V4-Pro → reasoning + requiresReasoningContentOnAssistantMessages", () => {
    const m = makePiModel(relay, "DeepSeek-V4-Pro", LOOPBACK) as { reasoning: boolean; compat?: Record<string, unknown>; baseUrl: string };
    expect(m.reasoning).toBe(true);
    expect(m.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
    expect(m.baseUrl).toBe(LOOPBACK);
  });

  it("TokenCamel 地址 + Claude 模型 → 不带 reasoning 兼容", () => {
    const m = makePiModel(relay, "claude-sonnet-5", LOOPBACK) as { reasoning: boolean; compat?: Record<string, unknown> };
    expect(m.reasoning).toBe(false);
    expect(m.compat?.requiresReasoningContentOnAssistantMessages).toBeUndefined();
  });
});
