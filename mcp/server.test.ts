import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMcpRequest, runner, DEFAULT_HOST, HOST_PARAM } from "./server.js";

const LOCAL: { principal: { subject: string; plan: "local" }; host: string } = {
  principal: { subject: DEFAULT_HOST, plan: "local" },
  host: DEFAULT_HOST,
};

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
      { principal: { subject: "user-1", plan: "free" }, host: "codex", authorize },
    );
    expect(authorize).toHaveBeenCalledOnce();
    expect(response?.result).toMatchObject({ isError: true });
  });

  it("records usage for an allowed tool call", async () => {
    const recordUsage = vi.fn();
    const response = await handleMcpRequest(
      { id: 4, method: "tools/call", params: { name: "autocrew_humanize", arguments: { action: "humanize_zh", text: "首先，我们需要深入探讨。" } } },
      { principal: { subject: "user-2", plan: "pro", workspaceId: "ws-1" }, host: "codex", recordUsage },
    );
    expect(response?.result).toBeDefined();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ subject: "user-2", tool: "autocrew_humanize", ok: true }));
  });
});

describe("MCP protocol version negotiation (2026-09-06 spike)", () => {
  it("echoes a protocol version we support", async () => {
    for (const version of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
      const response = await handleMcpRequest({
        id: 10,
        method: "initialize",
        params: { protocolVersion: version, clientInfo: { name: "codex-mcp-client" } },
      }, LOCAL);
      expect(response?.result).toMatchObject({ protocolVersion: version });
    }
  });

  it("falls back to the default for a version we do not know", async () => {
    const response = await handleMcpRequest(
      { id: 11, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      LOCAL,
    );
    expect(response?.result).toMatchObject({ protocolVersion: "2025-11-25" });
  });
});

describe("host attribution", () => {
  it("injects the authenticated host into tools/call arguments", async () => {
    const seen: Array<Record<string, unknown>> = [];
    runner.register({
      name: "test_host_probe",
      label: "host probe",
      description: "records the params it was called with",
      parameters: { type: "object", properties: {} },
      execute: async (params) => {
        seen.push({ ...params });
        return { ok: true };
      },
    });

    await handleMcpRequest(
      { id: 20, method: "tools/call", params: { name: "test_host_probe", arguments: { topic: "t" } } },
      { principal: { subject: "codex", plan: "local" }, host: "codex" },
    );
    expect(seen[0][HOST_PARAM]).toBe("codex");
    expect(seen[0].topic).toBe("t");

    // 客户端自报的 _host 一律丢弃：归因只认认证时定下的主体。
    await handleMcpRequest(
      { id: 21, method: "tools/call", params: { name: "test_host_probe", arguments: { [HOST_PARAM]: "forged" } } },
      { principal: { subject: "claude-code", plan: "local" }, host: "claude-code" },
    );
    expect(seen[1][HOST_PARAM]).toBe("claude-code");

    // 没有 access 的调用（本机脚本）落到 local-user，不留 undefined。
    await handleMcpRequest({ id: 22, method: "tools/call", params: { name: "test_host_probe", arguments: {} } });
    expect(seen[2][HOST_PARAM]).toBe(DEFAULT_HOST);
  });
});

describe("lossless JSON on the MCP path", () => {
  it("strips TypeBox own symbols from tools/list schemas", async () => {
    const raw = runner.getTools().find((tool) => tool.name === "autocrew_content")!.parameters;
    expect(Object.getOwnPropertySymbols(raw as object).length).toBeGreaterThan(0); // 前提：源 schema 真带 symbol

    const response = await handleMcpRequest({ id: 30, method: "tools/list", params: {} }, LOCAL);
    const tools = (response?.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    const schema = tools.find((tool) => tool.name === "autocrew_content")!.inputSchema;
    expect(Object.getOwnPropertySymbols(schema as object)).toEqual([]);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });

  it("passes tools/call results through lossless JSON", async () => {
    runner.register({
      name: "test_lossless_probe",
      label: "lossless probe",
      description: "returns a value with undefined fields",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, keep: "yes", drop: undefined }),
    });
    const response = await handleMcpRequest(
      { id: 31, method: "tools/call", params: { name: "test_lossless_probe", arguments: {} } },
      LOCAL,
    );
    const structured = (response?.result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured).toEqual({ ok: true, keep: "yes" });
    expect("drop" in structured).toBe(false);
  });
});

describe("writing-pack resource", () => {
  const contentId = "content-1757000000000-abc123";

  it("returns the markdown pack when it exists", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "autocrew-mcp-pack-"));
    mkdirSync(path.join(dataDir, "contents", contentId), { recursive: true });
    writeFileSync(path.join(dataDir, "contents", contentId, "writing-pack.md"), "# 写作包\n提交走 autocrew_writer submit\n");

    const response = await handleMcpRequest(
      { id: 40, method: "resources/read", params: { uri: `autocrew://contents/${contentId}/writing-pack` } },
      LOCAL,
      dataDir,
    );
    const contents = (response?.result as { contents: Array<{ mimeType: string; text: string }> }).contents;
    expect(contents[0].mimeType).toBe("text/markdown");
    expect(contents[0].text).toContain("autocrew_writer submit");
  });

  it("errors instead of returning an empty pack when there is none", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "autocrew-mcp-pack-"));
    const response = await handleMcpRequest(
      { id: 41, method: "resources/read", params: { uri: `autocrew://contents/${contentId}/writing-pack` } },
      LOCAL,
      dataDir,
    );
    expect(response?.error).toMatchObject({ code: -32002 });
  });
});
