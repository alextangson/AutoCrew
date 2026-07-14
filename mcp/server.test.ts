import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "./server.js";

describe("MCP protocol adapters", () => {
  it("advertises the current protocol plus tools, resources and prompts", async () => {
    const initialized = await handleMcpRequest({ id: 1, method: "initialize", params: {} });
    expect(initialized?.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {}, prompts: {} },
    });
    const tools = await handleMcpRequest({ id: 2, method: "tools/list", params: {} });
    const names = ((tools?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toContain("autocrew_generate");
    expect(names).toContain("autocrew_revise");
  });

  it("supports a commercial authorization boundary", async () => {
    const authorize = vi.fn(async () => ({ ok: false as const, error: "plan limit" }));
    const response = await handleMcpRequest(
      { id: 3, method: "tools/call", params: { name: "autocrew_humanize", arguments: { action: "humanize_zh", text: "测试" } } },
      { principal: { subject: "user-1", plan: "free" }, authorize },
    );
    expect(authorize).toHaveBeenCalledOnce();
    expect(response?.result).toMatchObject({ isError: true });
  });

  it("records usage for an allowed tool call", async () => {
    const recordUsage = vi.fn();
    const response = await handleMcpRequest(
      { id: 4, method: "tools/call", params: { name: "autocrew_humanize", arguments: { action: "humanize_zh", text: "首先，我们需要深入探讨。" } } },
      { principal: { subject: "user-2", plan: "pro", workspaceId: "ws-1" }, recordUsage },
    );
    expect(response?.result).toBeDefined();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ subject: "user-2", tool: "autocrew_humanize", ok: true }));
  });
});
