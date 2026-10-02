import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMcpRequest } from "./server.js";
import { hostAuthorize, hostListsTool } from "./host-policy.js";

let dir: string;
const access = { host: "claude-code", principal: { subject: "claude-code", plan: "local" as const }, authorize: hostAuthorize("claude-code") };
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-insights-mcp-")); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("禁止网络"); })); });
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(dir, { recursive: true, force: true }); });

describe("insights MCP discovery and invocation", () => {
  it("工具与可选参数的prompt可被Claude发现，默认调用实际备料而非后台模型", async () => {
    const tools = await handleMcpRequest({ id: 1, method: "tools/list" }, access, dir);
    expect(JSON.stringify(tools)).toContain("autocrew_insights");
    const prompts = await handleMcpRequest({ id: 2, method: "prompts/list" }, access, dir);
    const listed = (prompts?.result as { prompts: Array<{ name: string; arguments: Array<{ required: boolean }> }> }).prompts.find((p) => p.name === "insights");
    expect(listed?.arguments[0].required).toBe(false);
    const prompt = await handleMcpRequest({ id: 3, method: "prompts/get", params: { name: "insights" } }, access, dir);
    expect(JSON.stringify(prompt)).toContain("必须完成submit");
    const call = await handleMcpRequest({ id: 4, method: "tools/call", params: { name: "autocrew_insights", arguments: {} } }, access, dir);
    expect(call?.result).toMatchObject({ structuredContent: { ok: true, status: "ready_for_host_analysis", model_invoked: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("codex 与别的命名宿主一样能看到并调用账号洞察（2026-10-02 起不再单独限权）", async () => {
    expect(hostListsTool("codex", "autocrew_insights")).toBe(hostListsTool("claude-code", "autocrew_insights"));
    const call = await handleMcpRequest({ id: 5, method: "tools/call", params: { name: "autocrew_insights", arguments: {} } },
      { host: "codex", principal: { subject: "codex", plan: "local" }, authorize: hostAuthorize("codex") }, dir);
    expect(call?.result).toMatchObject({ structuredContent: { ok: true } });
  });
});
