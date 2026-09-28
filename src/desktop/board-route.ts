/**
 * 看板的浏览器会话端点（不是 MCP 能力）：读看板、「开始写」、「我发了」/撤销。
 * 写操作只给浏览器会话 + 同源；打开 Claude 桌面版的命令由服务端拼，浏览器传不进链接。
 */
import type http from "node:http";
import { boardData } from "./board-data.js";
import { markPublished, startWriting, unmarkPublished, type OpenDeps } from "./board-actions.js";

export interface BoardRouteDeps {
  authorize: (req: http.IncomingMessage) => "session" | "bearer" | null;
  originAllowed: (req: http.IncomingMessage) => boolean;
  resolveDataDir: () => Promise<string>;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  open?: OpenDeps;
}

const JSON_TYPE = "application/json; charset=utf-8";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

async function jsonBody(req: http.IncomingMessage, readBody: BoardRouteDeps["readBody"]): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readBody(req)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("请求体要是对象");
  return parsed as Record<string, unknown>;
}

export function createBoardHandler(deps: BoardRouteDeps) {
  const writeAllowed = (req: http.IncomingMessage) => deps.authorize(req) === "session" && deps.originAllowed(req);
  const post = async (req: http.IncomingMessage, res: http.ServerResponse, act: (body: Record<string, unknown>, dir: string) => Promise<unknown>) => {
    if (!writeAllowed(req)) { res.writeHead(403).end(); return; }
    try { send(res, 200, await act(await jsonBody(req, deps.readBody), await deps.resolveDataDir())); }
    catch (e) { send(res, 400, { ok: false, code: "bad_request", error: e instanceof Error ? e.message : String(e) }); }
  };
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (p === "/api/board" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      try { send(res, 200, { ok: true, data: await boardData(await deps.resolveDataDir()) }); }
      catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/board/start-writing" && req.method === "POST") {
      await post(req, res, (b, dir) => startWriting(String(b.topic_id ?? ""), typeof b.platform === "string" ? b.platform : undefined, dir, deps.open));
      return true;
    }
    if (p === "/api/board/mark-published" && req.method === "POST") {
      await post(req, res, (b, dir) => b.undo === true
        ? unmarkPublished(String(b.content_id ?? ""), String(b.platform ?? ""), dir)
        : markPublished(String(b.content_id ?? ""), String(b.platform ?? ""), b.url, dir));
      return true;
    }
    return false;
  };
}
