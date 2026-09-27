import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleMcpRequest, normalizeSession, runner, DEFAULT_HOST, HOST_PARAM, SESSION_PARAM, UNKNOWN_SESSION } from "./server.js";
import { CODEX_EDITOR_DENIED, HOST_HIDDEN_TOOLS, hostAuthorize, hostPolicy } from "./host-policy.js";

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

  it("按宿主限权（P6 §3.4）：codex 调写稿工具在协议层就被拒，工具不执行", async () => {
    const response = await handleMcpRequest(
      { id: 5, method: "tools/call", params: { name: "autocrew_humanize", arguments: { action: "humanize_zh", text: "测试" } } },
      { principal: { subject: "codex", plan: "local" }, host: "codex", authorize: hostAuthorize("codex") },
    );
    expect(response?.result).toMatchObject({ isError: true, content: [{ type: "text", text: CODEX_EDITOR_DENIED }] });
    const allowed = await handleMcpRequest(
      { id: 6, method: "tools/call", params: { name: "autocrew_humanize", arguments: { action: "humanize_zh", text: "测试" } } },
      { principal: { subject: "claude-code", plan: "local" }, host: "claude-code", authorize: hostAuthorize("claude-code") },
    );
    expect((allowed?.result as { content: Array<{ text: string }> }).content[0].text).not.toBe(CODEX_EDITOR_DENIED);
  });

  it("codex 不带 confirmation_id 调 handoff：协议层回结构化 confirmation_required 和 match → confirm 的下一步", async () => {
    const response = await handleMcpRequest(
      { id: 7, method: "tools/call", params: { name: "autocrew_video", arguments: { action: "handoff", content_id: "content-1", aroll_path: "/tmp/a.mov" } } },
      { principal: { subject: "codex", plan: "local" }, host: "codex", authorize: hostAuthorize("codex") },
    );
    const result = response?.result as { isError: boolean; structuredContent: Record<string, unknown>; content: Array<{ text: string }> };
    expect(result).toMatchObject({ isError: true, structuredContent: { ok: false, code: "confirmation_required" } });
    expect(String(result.structuredContent.next_action)).toMatch(/match[\s\S]*confirm/);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: "confirmation_required" });
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

describe("desk resource (P3 §6.1)", () => {
  it("autocrew://desk/<employee> 与 autocrew_desk inbox 是同一份待办", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "autocrew-mcp-desk-"));
    const listed = await handleMcpRequest({ id: 50, method: "resources/list", params: {} }, LOCAL, dataDir);
    const uris = ((listed?.result as { resources: Array<{ uri: string }> }).resources).map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["autocrew://desk/writer", "autocrew://desk/cover", "autocrew://desk/editor"]));

    const response = await handleMcpRequest(
      { id: 51, method: "resources/read", params: { uri: "autocrew://desk/cover" } },
      LOCAL,
      dataDir,
    );
    const contents = (response?.result as { contents: Array<{ mimeType: string; text: string }> }).contents;
    expect(contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(contents[0].text)).toMatchObject({ ok: true, employee: "cover", items: [] });
  });

  it("不认识的员工名 → 资源不存在，不返回一张空桌", async () => {
    const response = await handleMcpRequest(
      { id: 52, method: "resources/read", params: { uri: "autocrew://desk/designer" } },
      LOCAL,
    );
    expect(response?.error).toMatchObject({ code: -32002 });
  });
});

/** 以某宿主身份发请求（带上 desktop/server.ts 生产上挂的那个 authorize） */
function as(host: string, session?: string) {
  return { principal: { subject: host, plan: "local" as const }, host, authorize: hostAuthorize(host), ...(session ? { session } : {}) };
}

async function listedNames(host: string): Promise<string[]> {
  const response = await handleMcpRequest({ id: 60, method: "tools/list", params: {} }, as(host));
  return ((response?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
}

describe("工具表面瘦身：tools/list 按宿主过滤（P6 §3.7）", () => {
  it("local-user 全列；claude-code 与任意命名宿主去掉隐藏工具，其余照列", async () => {
    const all = runner.getTools().map((tool) => tool.name);
    expect(await listedNames(DEFAULT_HOST)).toEqual(all);
    for (const host of ["claude-code", "some-named-host"]) {
      const names = await listedNames(host);
      for (const hidden of HOST_HIDDEN_TOOLS) expect(names).not.toContain(hidden);
      expect(names).toEqual(all.filter((name) => !HOST_HIDDEN_TOOLS.has(name)));
      expect(names).toEqual(expect.arrayContaining(["autocrew_workflow", "autocrew_writer", "autocrew_review_desk"]));
    }
  });

  it("codex 只列它调得动的：等于宿主白名单，列外的工具任何 action 都被拒", async () => {
    const names = await listedNames("codex");
    expect([...names].sort()).toEqual(["autocrew_asset", "autocrew_content", "autocrew_desk", "autocrew_status", "autocrew_video"]);
    for (const tool of runner.getTools().map((t) => t.name).filter((name) => !names.includes(name))) {
      for (const action of ["", "list", "get", "status", "register"]) expect(hostPolicy("codex", tool, { action }).ok).toBe(false);
    }
  });

  it("不列 ≠ 不能调：claude-code 硬调隐藏工具照常执行，回执多一句 host_note；local-user 没有这句", async () => {
    const call = { id: 61, method: "tools/call", params: { name: "autocrew_humanize", arguments: { action: "humanize_zh", text: "首先，我们需要深入探讨。" } } };
    const hosted = await handleMcpRequest(call, as("claude-code"));
    const structured = (hosted?.result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured.host_note).toMatch(/autocrew_humanize 不在宿主工具清单里/);
    expect(Object.keys(structured).length).toBeGreaterThan(1); // 工具真的跑了，不是只回一句提示
    const local = await handleMcpRequest(call, as(DEFAULT_HOST));
    expect((local?.result as { structuredContent: Record<string, unknown> }).structuredContent).not.toHaveProperty("host_note");
  });
});

describe("会话归因（P6 §3.8，只做诊断）", () => {
  it("_session 与 _host 并列注入；客户端自报的一律丢弃；没带头 = unknown", async () => {
    const seen: Array<Record<string, unknown>> = [];
    runner.register({
      name: "test_session_probe",
      label: "session probe",
      description: "records the params it was called with",
      parameters: { type: "object", properties: {} },
      execute: async (params) => {
        seen.push({ ...params });
        return { ok: true };
      },
    });
    const call = (args: Record<string, unknown>) => ({ id: 70, method: "tools/call", params: { name: "test_session_probe", arguments: args } });
    await handleMcpRequest(call({ [SESSION_PARAM]: "forged" }), as("claude-code", "sess-1-abc"));
    expect(seen[0]).toMatchObject({ [HOST_PARAM]: "claude-code", [SESSION_PARAM]: "sess-1-abc" });
    await handleMcpRequest(call({ [SESSION_PARAM]: "forged" }), as("codex-direct"));
    expect(seen[1][SESSION_PARAM]).toBe(UNKNOWN_SESSION);
  });

  it("X-AutoCrew-Session 头只收短的安全字符，其余一律 unknown", () => {
    expect(normalizeSession("sess-1790000000000-ab12cd34")).toBe("sess-1790000000000-ab12cd34");
    expect(normalizeSession([" sess-1-x ", "sess-2-y"])).toBe("sess-1-x");
    for (const bad of [undefined, "", "a b", "x".repeat(81), "<script>", 42]) expect(normalizeSession(bad)).toBe(UNKNOWN_SESSION);
  });

  it("这次调用落的 run-log 记录带上会话（runId 仍是服务端的 session-*）", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "autocrew-mcp-session-"));
    await handleMcpRequest({ id: 71, method: "tools/call", params: { name: "autocrew_status", arguments: {} } }, as("claude-code", "sess-9-zz"), dataDir);
    const file = path.join(dataDir, "logs", "runs", `${new Date().toISOString().slice(0, 10)}.jsonl`);
    await vi.waitFor(() => {
      const records = readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.find((r) => r.name === "autocrew_status")).toMatchObject({ kind: "tool", session: "sess-9-zz", runId: expect.stringMatching(/^session-/) });
    });
  });
});
