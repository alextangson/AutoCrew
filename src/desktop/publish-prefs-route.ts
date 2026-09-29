/**
 * 发布前把关的创始人专属网页路由（spec §3、§6、E6）。只认浏览器会话（工作台登录 cookie）+ 同源 + JSON；
 * 具名 MCP bearer、/api/invoke、对话工具都到不了——偏好生效与指令留底都是创始人自己的动作。
 *
 * - GET  /api/publish-prefs                → 默认上传槽、账号覆盖、发布规则、待确认提议
 * - POST /api/publish-prefs {op, …}         → decide_proposal / set_cover_ratios / add_rule / remove_rule
 * - POST /api/publish-instruction {content_id, text, via} → 存编辑后的指令，回 instruction_id 与要复制的文本
 */
import type http from "node:http";
import { COVER_CROP_CHECKS, COVER_RATIOS_BY_PLATFORM } from "../modules/cover/platform-ratios.js";
import { addPublishRule, decideProposal, pendingProposals, readPublishPrefs, removePublishRule, setCoverRatios } from "../modules/publish/review-gate/preferences.js";
import { saveInstruction } from "../modules/publish/review-gate/instructions.js";
import { GATE_PLATFORMS, PLATFORM_LABEL } from "../modules/publish/review-gate/platforms.js";

export interface PublishPrefsRouteDeps {
  authorize(req: http.IncomingMessage): "session" | "bearer" | null;
  originAllowed(req: http.IncomingMessage): boolean;
  readBody(req: http.IncomingMessage): Promise<string>;
  resolveDataDir(): Promise<string>;
}

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function prefsView(dataDir: string): Promise<Record<string, unknown>> {
  const prefs = await readPublishPrefs(dataDir);
  const defaults = Object.fromEntries(GATE_PLATFORMS.map((p) => [p, COVER_RATIOS_BY_PLATFORM[p] ?? []]));
  return { ok: true, platforms: GATE_PLATFORMS.map((p) => ({ id: p, label: PLATFORM_LABEL[p] })), defaults, crop_checks: COVER_CROP_CHECKS, ...prefs, proposals: await pendingProposals(dataDir) };
}

async function applyOp(a: Body, dataDir: string): Promise<{ ok: boolean; error?: string }> {
  if (a.op === "decide_proposal") {
    if (a.decision !== "confirm" && a.decision !== "dismiss") return { ok: false, error: "decision 只能是 confirm 或 dismiss" };
    return decideProposal(str(a.id), a.decision, dataDir);
  }
  if (a.op === "set_cover_ratios") return setCoverRatios(str(a.platform), a.ratios, dataDir);
  if (a.op === "add_rule") return addPublishRule(str(a.text), str(a.platform) || undefined, dataDir);
  if (a.op === "remove_rule") return removePublishRule(str(a.id), dataDir);
  return { ok: false, error: "op 只能是 decide_proposal / set_cover_ratios / add_rule / remove_rule" };
}

export function createPublishPrefsHandler(deps: PublishPrefsRouteDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (p !== "/api/publish-prefs" && p !== "/api/publish-instruction") return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    const isGet = req.method === "GET" && p === "/api/publish-prefs";
    if (!isGet && req.method !== "POST") { send(405, { ok: false, error: "method_not_allowed" }); return true; }
    if (deps.authorize(req) !== "session" || (!isGet && !deps.originAllowed(req))) {
      send(403, { ok: false, error: "founder_workbench_required：只能在工作台由创始人操作" });
      return true;
    }
    const dataDir = await deps.resolveDataDir();
    if (isGet) { send(200, await prefsView(dataDir)); return true; }
    if (!(req.headers["content-type"] ?? "").includes("application/json")) { send(415, { ok: false, error: "application/json required" }); return true; }
    let a: Body;
    try { a = JSON.parse(await deps.readBody(req)) as Body; } catch { send(400, { ok: false, error: "bad json" }); return true; }
    try {
      if (p === "/api/publish-instruction") {
        const r = await saveInstruction(str(a.content_id), a.text, a.via, dataDir);
        send(r.ok ? 200 : 400, r.ok ? { ok: true, instruction_id: r.instruction.id, copy_text: r.copy_text } : r);
        return true;
      }
      const r = await applyOp(a, dataDir);
      send(r.ok ? 200 : 409, r.ok ? await prefsView(dataDir) : r);
    } catch (e) {
      send(400, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  };
}
