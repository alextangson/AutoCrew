// 量 MCP 表面：tools/list 每个工具的字数（与 tools/list 同一套序列化）+ initialize instructions
import { handleMcpRequest } from "../mcp/server.js";
const host = process.argv[2] ?? "workbuddy";
const access = { principal: { subject: host, plan: "local" as const }, host };
const list = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, access);
const tools = (list!.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
const rows = tools.map((t) => ({ name: t.name, total: JSON.stringify(t).length, desc: t.description.length, schema: JSON.stringify(t.inputSchema).length }));
rows.sort((a, b) => b.total - a.total);
console.table(rows);
console.log("TOTAL", JSON.stringify(tools).length, "tools", tools.length);
const init = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } }, access);
console.log("instructions", ((init!.result as { instructions: string }).instructions).length);
process.exit(0);
