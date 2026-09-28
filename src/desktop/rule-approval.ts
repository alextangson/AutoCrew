import type http from "node:http";
import { decideWritingRule } from "../modules/profile/creator-profile.js";
/** Browser session + exact origin are verified by the server, never taken from payload flags. */
export function createRuleApprovalHandler(deps: {
  authorize(req: http.IncomingMessage): "session" | "bearer" | null;
  originAllowed(req: http.IncomingMessage): boolean;
  readBody(req: http.IncomingMessage): Promise<string>;
  resolveDataDir(): Promise<string>;
}) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== "/api/rules/decision") return false;
    const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.method !== "POST" || deps.authorize(req) !== "session" || !deps.originAllowed(req)) { send(403, { ok: false, error: "founder_workbench_required" }); return true; }
    try {
      const a = JSON.parse(await deps.readBody(req));
      if (typeof a.ruleId !== "string" || !Number.isInteger(a.revision) || a.revision < 1 || !["active", "rejected", "disabled"].includes(a.decision) || typeof a.eventId !== "string" || !a.eventId.trim() || a.eventId.length > 100) throw new Error("invalid_rule_decision");
      const profile = await decideWritingRule({ ruleId: a.ruleId, revision: a.revision, decision: a.decision, eventId: a.eventId }, await deps.resolveDataDir());
      send(200, { ok: true, rules: profile.writingRules });
    } catch (e) { send(409, { ok: false, error: e instanceof Error ? e.message : String(e) }); }
    return true;
  };
}
