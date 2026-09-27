/** Browser-session-only founder decisions and artifact review. Not an MCP capability. */
import type http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { resolveContentProject } from "../storage/content-project.js";
import { resolveProjectFile } from "../modules/video/handoff/paths.js";
import { sha256File } from "../modules/video/handoff/manifest.js";
import { founderProjectReview } from "../modules/video/handoff/founder-review.js";
import { parseRangeHeader } from "./video-media.js";

export interface ProjectReviewRouteDeps {
  authorize: (req: http.IncomingMessage) => "session" | "bearer" | null;
  originAllowed: (req: http.IncomingMessage) => boolean;
  resolveDataDir: () => Promise<string>;
  readBody: (req: http.IncomingMessage) => Promise<string>;
}
export function createProjectReviewHandler(deps: ProjectReviewRouteDeps) {
  const authorize = deps.authorize, activeDataDir = deps.resolveDataDir, readBody = deps.readBody;
  const browserWriteAllowed = (req: http.IncomingMessage, _method: string) => deps.originAllowed(req);
  const MIME: Record<string, string> = { ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
  if (p === "/api/project-artifact" && req.method === "GET") {
    if (authorize(req) !== "session") { res.writeHead(403).end(); return true; }
    try {
      const binding = resolveContentProject(url.searchParams.get("content_id") ?? "", await activeDataDir());
      const relative = url.searchParams.get("path") ?? "";
      if (!binding || !relative || path.isAbsolute(relative)) { res.writeHead(400).end(); return true; }
      const checked = await resolveProjectFile(path.join(binding.project_root, relative), binding.project_root, "审阅产物");
      if (!checked.ok) { res.writeHead(403).end(); return true; }
      const ext = path.extname(checked.value).toLowerCase();
      if (![".mp4", ".png", ".jpg", ".jpeg"].includes(ext)) { res.writeHead(415).end(); return true; }
      if (await sha256File(checked.value) !== url.searchParams.get("sha256")) { res.writeHead(409).end("产物已变化"); return true; }
      const size = (await fs.stat(checked.value)).size;
      const range = parseRangeHeader(req.headers.range, size);
      if (range === "unsatisfiable") { res.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return true; }
      res.writeHead(range ? 206 : 200, { "Content-Type": ext === ".mp4" ? "video/mp4" : MIME[ext], "Cache-Control": "no-store", "Accept-Ranges": "bytes",
        "Content-Length": range ? range.end - range.start + 1 : size, ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}) });
      createReadStream(checked.value, range ?? undefined).pipe(res);
    } catch { res.writeHead(404).end(); }
    return true;
  }

  // Founder approvals are browser-session-only, never granted by a named MCP bearer.
  if (p === "/api/project-review" && ["GET", "POST"].includes(req.method ?? "")) {
    if (authorize(req) !== "session" || (req.method === "POST" && !browserWriteAllowed(req, "session"))) { res.writeHead(403).end(); return true; }
    const id = url.searchParams.get("content_id") ?? "";
    if (!/^content-\d+-[a-z0-9]+$/.test(id)) { res.writeHead(400).end(); return true; }
    try {
      if (req.method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json")) { res.writeHead(415).end(); return true; }
      const payload = req.method === "POST" ? JSON.parse(await readBody(req)) : undefined;
      const result = await founderProjectReview(id, await activeDataDir(), payload);
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" }).end(JSON.stringify(result));
    } catch (e) { res.writeHead(400, { "Content-Type": MIME[".json"] }).end(JSON.stringify({ ok: false, error: String(e) })); }
    return true;
  }

    return false;
  };
}
