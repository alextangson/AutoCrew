/**
 * `/mcp` 上会话令牌的那一支（spec §地基 1）。放在 server.ts 之外，server.ts 只多一行分派——
 * 另一条「命名宿主令牌不进 /api/*」的修复也改 server.ts，这样合并时互不打架。
 *
 * 会话令牌只在这里有效：/api/* 的鉴权（LocalSessionAuth）根本不认识 `ce_` 令牌，一律 401/403。
 */
import type http from "node:http";
import { MCP_PROTOCOL_VERSION } from "../../../mcp/server.js";
import { handleAgentMcp } from "./mcp-bridge.js";
import { getChiefEditor } from "./service.js";

export async function serveAgentMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  readBody: (req: http.IncomingMessage) => Promise<string>,
): Promise<boolean> {
  const svc = getChiefEditor();
  const binding = svc?.bindingFor(req.headers.authorization);
  if (!svc || !binding) return false;
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST, GET", "Cache-Control": "no-store" }).end();
    return true;
  }
  if (!(req.headers["content-type"] || "").includes("application/json")) {
    res.writeHead(415).end("application/json required");
    return true;
  }
  let request: Record<string, unknown>;
  try { request = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end("bad json"); return true; }
  const response = await handleAgentMcp(svc, binding, request);
  if (!response) { res.writeHead(202, { "Cache-Control": "no-store" }).end(); return true; }
  const negotiated = (response.result as { protocolVersion?: string } | undefined)?.protocolVersion;
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "MCP-Protocol-Version": negotiated ?? MCP_PROTOCOL_VERSION });
  res.end(JSON.stringify(response));
  return true;
}
