/**
 * 写作手册页的创始人专属网页路由（spec 2026-10-13 §5）。照 rule-approval：只认浏览器会话（工作台登录 cookie）+ 同源 + JSON；
 * 具名 MCP bearer、/api/invoke 都到不了。批准 / 否决与回滚和对话、工具共用 modules/playbook/changes 的同一套逻辑。
 *
 * - GET  /api/playbooks                         → 5 本：当前全文、版本历史、待批提案（含改前改后）、每版统计
 * - GET  /api/playbooks/version?id=&version=    → 某一版全文 + 它对当前版本的对比
 * - POST /api/playbooks {op:"approve"|"reject", id, proposal_id, gen, event_id}
 * - POST /api/playbooks {op:"batch", id, based_on, items:[{proposal_id, gen, decision:"approve"|"reject"}], event_id}（同一份改动合并批）
 * - POST /api/playbooks {op:"rollback", id, to_version, expected_current_version, request_id, founder_words?}
 */
import type http from "node:http";
import { decideProposal, rollbackPlaybook } from "../modules/playbook/changes.js";
import { decideLessonBatch, type BatchItem } from "../modules/playbook/batch.js";
import { paragraphDiff } from "../modules/playbook/diff.js";
import { entryOf, loadManifest, readVersionText } from "../modules/playbook/store.js";
import { playbookStats } from "../modules/playbook/stats.js";
import { isPlaybookId, PlaybookError, type PlaybookId, type PlaybookManifest } from "../modules/playbook/types.js";

export interface PlaybookRouteDeps {
  authorize(req: http.IncomingMessage): "session" | "bearer" | null;
  originAllowed(req: http.IncomingMessage): boolean;
  readBody(req: http.IncomingMessage): Promise<string>;
  resolveDataDir(): Promise<string>;
}

type Body = Record<string, unknown>;
const EVENT_RE = /^[A-Za-z0-9_-]{8,100}$/;
const posInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

async function view(m: PlaybookManifest, dataDir: string): Promise<Body> {
  const playbooks = await Promise.all(m.playbooks.map(async (e) => ({
    id: e.id, name: e.name, current: e.current, text: await readVersionText(e.id, e.current, dataDir), versions: e.versions,
    proposals: await Promise.all(e.proposals.filter((p) => p.status === "pending").map(async (p) => ({
      id: p.id, kind: p.kind, based_on: p.based_on, gen: p.gen, reason: p.reason, founder_words: p.founder_words, at: p.at, origin: p.origin ?? null,
      diff: paragraphDiff(await readVersionText(e.id, p.based_on, dataDir), p.text),
    }))),
  })));
  return { ok: true, playbooks, stats: await playbookStats(m, dataDir) };
}

async function versionView(url: URL, dataDir: string): Promise<[number, Body]> {
  const id = url.searchParams.get("id"), version = Number(url.searchParams.get("version"));
  if (!isPlaybookId(id) || !posInt(version)) return [400, { ok: false, error: "要带 id（5 本之一）和 version" }];
  const e = entryOf(await loadManifest(dataDir), id);
  if (!e.versions.some((v) => v.version === version)) return [404, { ok: false, error: `没有第 ${version} 版` }];
  const text = await readVersionText(id, version, dataDir);
  return [200, { ok: true, id, version, current: e.current, text, diff: paragraphDiff(text, await readVersionText(id, e.current, dataDir)) }];
}

async function applyOp(a: Body, dataDir: string): Promise<Body> {
  if (!isPlaybookId(a.id)) throw new PlaybookError("bad_param", "id 要是 5 本手册之一");
  const id = a.id as PlaybookId;
  if (a.op === "approve" || a.op === "reject") {
    if (typeof a.proposal_id !== "string" || typeof a.gen !== "string" || typeof a.event_id !== "string" || !EVENT_RE.test(a.event_id)) throw new PlaybookError("bad_param", "要带 proposal_id、gen、event_id");
    return decideProposal({ id, proposal_id: a.proposal_id, gen: a.gen, decision: a.op, eventId: `web-${a.event_id}`, source: "workbench" }, dataDir);
  }
  if (a.op === "batch") {
    const items = Array.isArray(a.items) ? (a.items as Body[]) : null;
    const good = items?.every((i) => typeof i.proposal_id === "string" && typeof i.gen === "string" && (i.decision === "approve" || i.decision === "reject"));
    if (!items || !good || !posInt(a.based_on) || typeof a.event_id !== "string" || !EVENT_RE.test(a.event_id)) throw new PlaybookError("bad_param", "要带 based_on、items[{proposal_id, gen, decision}]、event_id");
    return decideLessonBatch({ id, based_on: a.based_on as number, items: items as unknown as BatchItem[], eventId: `web-${a.event_id}`, source: "workbench" }, dataDir);
  }
  if (a.op === "rollback") {
    const to = posInt(a.to_version), expected = posInt(a.expected_current_version);
    if (!to || !expected || typeof a.request_id !== "string" || !EVENT_RE.test(a.request_id)) throw new PlaybookError("bad_param", "要带 to_version、expected_current_version、request_id");
    const words = typeof a.founder_words === "string" && a.founder_words.trim() ? a.founder_words.trim() : `工作台点了「回滚到第 ${to} 版」`;
    return rollbackPlaybook({ id, to_version: to, expected_current_version: expected, request_id: a.request_id, founder_words: words, source: "workbench" }, dataDir);
  }
  throw new PlaybookError("bad_param", "op 只能是 approve / reject / batch / rollback");
}

export function createPlaybookHandler(deps: PlaybookRouteDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (p !== "/api/playbooks" && p !== "/api/playbooks/version") return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    const isGet = req.method === "GET";
    if (!isGet && (req.method !== "POST" || p !== "/api/playbooks")) { send(405, { ok: false, error: "method_not_allowed" }); return true; }
    if (deps.authorize(req) !== "session" || (!isGet && !deps.originAllowed(req))) {
      send(403, { ok: false, error: "founder_workbench_required：手册只能在工作台由创始人操作" });
      return true;
    }
    try {
      const dataDir = await deps.resolveDataDir();
      if (isGet && p === "/api/playbooks/version") { const [status, body] = await versionView(url, dataDir); send(status, body); return true; }
      if (isGet) { send(200, await view(await loadManifest(dataDir), dataDir)); return true; }
      if (!(req.headers["content-type"] ?? "").includes("application/json")) { send(415, { ok: false, error: "application/json required" }); return true; }
      let a: Body;
      try { a = JSON.parse(await deps.readBody(req)) as Body; } catch { send(400, { ok: false, error: "bad json" }); return true; }
      send(200, await applyOp(a, dataDir));
    } catch (e) {
      if (e instanceof PlaybookError) send(e.code === "bad_param" ? 400 : 409, { ok: false, code: e.code, error: e.message, ...e.extra });
      else send(500, { ok: false, code: "storage_error", error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  };
}
