/**
 * 看板与数据页的浏览器会话端点（不是 MCP 能力）：读看板、「开始写」、「我发了」/撤销；
 * 读数据页、数据↔稿件的手动关联 / 合并 / 拆开及撤销（数据页规格 §F）。
 * 写操作只给浏览器会话 + 同源；打开 Claude 桌面版的命令由服务端拼，浏览器传不进链接。
 */
import type http from "node:http";
import { boardData } from "./board-data.js";
import { dataPage } from "./data-page.js";
import { createCoverHandler } from "./data-cover-route.js";
import { addDecision, removeDecision, type LinkOp } from "../modules/flywheel/outcome-links.js";
import { markPublished, startWriting, unmarkPublished, type OpenDeps } from "./board-actions.js";
import { reopenScript } from "../modules/production/reopen.js";
import { enableOntology } from "../modules/production/enable.js";
import { isContentId } from "../storage/entity-id.js";

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
  const covers = createCoverHandler(deps);
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (await covers(req, res, url)) return true;
    if (p === "/api/board" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      try { send(res, 200, { ok: true, data: await boardData(await deps.resolveDataDir()) }); }
      catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/data" && req.method === "GET") {
      if (deps.authorize(req) !== "session") { res.writeHead(403).end(); return true; }
      try { send(res, 200, { ok: true, data: await dataPage(await deps.resolveDataDir()) }); }
      catch (e) { send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
      return true;
    }
    if (p === "/api/data/link" && req.method === "POST") {
      await post(req, res, async (b, dir) => ({ ok: true, data: await addDecision({
        op: String(b.op ?? "") as LinkOp,
        works: Array.isArray(b.works) ? b.works.map(String) : [],
        ...(typeof b.content_id === "string" ? { contentId: b.content_id } : {}),
        ...(typeof b.target === "string" ? { target: b.target } : {}),
      }, dir) }));
      return true;
    }
    if (p === "/api/data/undo" && req.method === "POST") {
      await post(req, res, async (b, dir) => ({ ok: true, data: await removeDecision(String(b.id ?? ""), dir) }));
      return true;
    }
    if (p === "/api/board/start-writing" && req.method === "POST") {
      await post(req, res, (b, dir) => startWriting(String(b.topic_id ?? ""), typeof b.platform === "string" ? b.platform : undefined, dir, deps.open));
      return true;
    }
    // 本体（spec 2026-09-29）：两个创始人决定只走浏览器会话——重开文稿（§2.5）与启用本体（§4.1）
    if (p === "/api/board/reopen-script" && req.method === "POST") {
      await post(req, res, async (b, dir) => {
        const id = String(b.content_id ?? "");
        if (!isContentId(id)) return { ok: false, code: "bad_request", error: "content_id 不对" };
        if (b.confirm !== true) return { ok: false, code: "confirmation_required", error: "重开文稿会把本轮的原片、成片、批准转入历史，需要确认" };
        return reopenScript(id, dir, typeof b.note === "string" ? b.note.slice(0, 200) : undefined);
      });
      return true;
    }
    if (p === "/api/board/ontology/enable" && req.method === "POST") {
      await post(req, res, async (b, dir) => (b.confirm === true
        ? enableOntology(dir, { exclude: Array.isArray(b.exclude) ? b.exclude.map(String).filter(isContentId) : [] })
        : { ok: false, code: "confirmation_required", error: "启用前先看差异清单并确认" }));
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
