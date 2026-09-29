/** MCP 表面预算（spec v1.3 M7）与契约不变（M1）：量法与 tools/list 同一套序列化 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "./server.js";
import { schemaShape } from "./schema-shape.js";
import { TOOL_GUIDE_PREFIX } from "./tool-docs.js";

const HOSTS = ["local-user", "workbuddy", "codex"] as const;
const access = (host: string) => ({ principal: { subject: host, plan: "local" as const }, host });
async function toolsFor(host: string) {
  const r = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, access(host));
  return (r!.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
}

/** 实测锁（2026-09-29）：总 27,322 / 单个最大 3,556（editorial）/ instructions 675；留一点余量 */
export const BUDGET = { total: 28_000, perTool: 4_000, instructions: 1_500 };

describe("M7 预算：外部宿主看到的 tools/list 与 initialize", () => {
  it.each(["workbuddy", "claude-code"])("%s：总量、单个工具、instructions 都在预算内；超了列出谁超、多少字", async (host) => {
    const tools = await toolsFor(host);
    const sizes = tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length }));
    const total = JSON.stringify(tools).length;
    const over = sizes.filter((s) => s.chars > BUDGET.perTool).map((s) => `${s.name} ${s.chars}`);
    const init = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } }, access(host));
    const instructions = (init!.result as { instructions: string }).instructions.length;
    const report = `tools/list 共 ${total} 字（上限 ${BUDGET.total}）；超单个上限 ${BUDGET.perTool} 的：${over.join("，") || "无"}；instructions ${instructions} 字（上限 ${BUDGET.instructions}）。最大的五个：${[...sizes].sort((a, b) => b.chars - a.chars).slice(0, 5).map((s) => `${s.name} ${s.chars}`).join("，")}`;
    expect(total <= BUDGET.total && over.length === 0 && instructions <= BUDGET.instructions, report).toBe(true);
  });
});

describe("M1 契约不变：工具名、参数名、类型、必填、枚举、长度与格式限制与瘦身前逐项一致", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "tool-contract.json"), "utf-8")) as Record<string, Array<{ name: string; shape: unknown }>>;
  it.each(HOSTS)("%s 看到的工具清单与参数形状", async (host) => {
    const now = (await toolsFor(host)).map((t) => ({ name: t.name, shape: schemaShape(t.inputSchema) }));
    expect(now).toEqual(fixture[host]);
  });
});

describe("长说明搬进按需资源", () => {
  it("每个工具的完整用法可按需读取（瘦身前的原文）", async () => {
    const r = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: `${TOOL_GUIDE_PREFIX}autocrew_writer` } }, access("workbuddy"));
    const text = ((r!.result as { contents: Array<{ text: string }> }).contents[0].text);
    expect(text).toContain("pack_status");
    expect(text.length).toBeGreaterThan(1000);
    const missing = await handleMcpRequest({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: `${TOOL_GUIDE_PREFIX}nope` } }, access("workbuddy"));
    expect(missing!.error).toBeDefined();
  });
  it("短说明点名资源；instructions 点名写作守则", async () => {
    const tools = await toolsFor("workbuddy");
    for (const t of tools) expect(t.description).toContain(`${TOOL_GUIDE_PREFIX}${t.name}`);
    const init = await handleMcpRequest({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }, access("workbuddy"));
    expect((init!.result as { instructions: string }).instructions).toContain("autocrew://writing-guide");
  });
});
