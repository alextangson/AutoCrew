/**
 * 写作规则审批（spec 2026-09-28 §3 D，P1）：规则生效的唯一入口。
 *
 * 只认浏览器会话（工作台登录 cookie）+ 同源 + JSON 请求；具名 MCP bearer、/api/invoke、对话工具都到不了这里。
 * 请求里的任何「用户已确认」字样都不看——证明来自这次 HTTP 请求本身的会话，不来自载荷。
 */
import type http from "node:http";
import { decideWritingRule, type RuleDecision } from "../modules/profile/creator-profile.js";

export interface RuleApprovalDeps {
  authorize(req: http.IncomingMessage): "session" | "bearer" | null;
  originAllowed(req: http.IncomingMessage): boolean;
  readBody(req: http.IncomingMessage): Promise<string>;
  resolveDataDir(): Promise<string>;
}

const DECISIONS: readonly RuleDecision[] = ["active", "rejected", "disabled"];

export function createRuleApprovalHandler(deps: RuleApprovalDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/api/rules/decision") return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    if (req.method !== "POST") { send(405, { ok: false, error: "method_not_allowed" }); return true; }
    if (deps.authorize(req) !== "session" || !deps.originAllowed(req)) {
      send(403, { ok: false, error: "founder_workbench_required：规则只能在工作台由创始人批准" });
      return true;
    }
    if (!(req.headers["content-type"] ?? "").includes("application/json")) { send(415, { ok: false, error: "application/json required" }); return true; }
    let a: Record<string, unknown>;
    try { a = JSON.parse(await deps.readBody(req)) as Record<string, unknown>; } catch { send(400, { ok: false, error: "bad json" }); return true; }
    const ruleId = a.ruleId, revision = a.revision, decision = a.decision, eventId = a.eventId;
    if (typeof ruleId !== "string" || !ruleId || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 ||
        !DECISIONS.includes(decision as RuleDecision) || typeof eventId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(eventId)) {
      send(400, { ok: false, error: "invalid_rule_decision：需要 ruleId、revision、decision(active|rejected|disabled)、eventId" });
      return true;
    }
    try {
      const profile = await decideWritingRule({ ruleId, revision, decision: decision as RuleDecision, eventId }, await deps.resolveDataDir());
      send(200, { ok: true, rules: profile.writingRules });
    } catch (e) {
      send(409, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  };
}
