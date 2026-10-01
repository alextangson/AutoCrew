/**
 * 版本提醒与一键更新的浏览器端点（self-update §2/§3）。全部只认浏览器会话；写操作另要同源。
 * 模型 / MCP / bearer 一律 403——更新会重启服务，只能是创始人在页面上点的。
 */
import type http from "node:http";
import { checkForUpdate, updateView, type UpdateView } from "../modules/update/check.js";
import { busyWork, lockHeld, type PreflightDeps } from "../modules/update/preflight.js";
import { markResultSeen, writeSettings } from "../modules/update/state.js";
import { prepareUpdate, spawnDetachedUpdater, type Prepared } from "../modules/update/start.js";
import type { GitRunner } from "../modules/update/git.js";

export interface UpdateRouteDeps {
  authorize: (req: http.IncomingMessage) => "session" | "bearer" | null;
  originAllowed: (req: http.IncomingMessage) => boolean;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  root: string;
  machineDir: string;
  port: number;
  inProcessTurns?: () => number;
  launcher?: PreflightDeps["launcher"];
  /** 测试注入 */
  git?: GitRunner;
  runAlive?: PreflightDeps["runAlive"];
  spawnUpdater?: (job: Prepared) => Promise<{ ok: true; log: string } | { ok: false; reason: string }>;
}

const JSON_TYPE = "application/json; charset=utf-8";
const send = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "Content-Type": JSON_TYPE, "Cache-Control": "no-store" }).end(JSON.stringify(body));

export function createUpdateHandler(deps: UpdateRouteDeps) {
  const view = (): UpdateView => updateView(deps.root, deps.machineDir, lockHeld(deps.machineDir));
  const session = (req: http.IncomingMessage) => deps.authorize(req) === "session";
  const writeOk = (req: http.IncomingMessage) => session(req) && deps.originAllowed(req);
  const body = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const raw = await deps.readBody(req);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  };
  const start = async () => {
    const prep = await prepareUpdate(deps.root, deps.machineDir, {
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.inProcessTurns ? { inProcessTurns: deps.inProcessTurns } : {}),
      ...(deps.runAlive ? { runAlive: deps.runAlive } : {}),
      ...(deps.launcher ? { launcher: deps.launcher } : {}),
    });
    if (!prep.ok) return { ok: false, code: prep.code, error: prep.reason };
    const spawned = await (deps.spawnUpdater ?? ((j: Prepared) => spawnDetachedUpdater(deps.root, deps.machineDir, deps.port, j)))(prep);
    if (!spawned.ok) return { ok: false, code: "spawn_failed", error: spawned.reason };
    return { ok: true, from: prep.from, to: prep.to, log: spawned.log };
  };
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (!p.startsWith("/api/update")) return false;
    // 「有没有轮在跑」：命令行 autocrew update 与独立的更新进程用本机 server-token 来问（只读，不触发任何动作）
    if (p === "/api/update/busy" && req.method === "GET") {
      if (deps.authorize(req) === null) { res.writeHead(403).end(); return true; }
      send(res, 200, { ok: true, busy: busyWork(deps.machineDir, { inProcessTurns: deps.inProcessTurns ?? (() => 0), ...(deps.runAlive ? { runAlive: deps.runAlive } : {}) }) });
      return true;
    }
    const isGet = p === "/api/update" && req.method === "GET";
    if (isGet ? !session(req) : !writeOk(req)) { res.writeHead(403).end(); return true; }
    try {
      if (isGet) send(res, 200, { ok: true, data: view() });
      else if (p === "/api/update/check" && req.method === "POST") {
        await checkForUpdate(deps.root, deps.machineDir, deps.git ? { git: deps.git } : {});
        send(res, 200, { ok: true, data: view() });
      } else if (p === "/api/update/settings" && req.method === "POST") {
        const b = await body(req);
        writeSettings(deps.machineDir, {
          ...(typeof b.auto_check === "boolean" ? { autoCheck: b.auto_check } : {}),
          ...(typeof b.skip_version === "string" || b.skip_version === null ? { skipVersion: b.skip_version as string | null } : {}),
        });
        send(res, 200, { ok: true, data: view() });
      } else if (p === "/api/update/ack" && req.method === "POST") {
        markResultSeen(deps.machineDir);
        send(res, 200, { ok: true, data: view() });
      } else if (p === "/api/update/start" && req.method === "POST") {
        send(res, 200, await start());
      } else send(res, 404, { ok: false, error: "没有这个地址" });
    } catch (e) {
      send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  };
}
