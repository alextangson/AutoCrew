/**
 * autocrew_playbook：五本体裁手册（docs/2026-10-13-genre-playbooks-spec.md §3）。
 * list / get 读；propose 交整本修订（进「等你拍板」，批了才生成新版本）；rollback 由创始人发起，直接生成新版本。
 * 参数不保证类型对（中转会把数字变字符串）：这里统一归一。
 */
import { Type } from "@sinclair/typebox";
import { requesterOf } from "../modules/production/chat-approval/view.js";
import { isRequestId } from "../modules/production/chat-approval/requests.js";
import { proposeRevision, rollbackPlaybook } from "../modules/playbook/changes.js";
import { paragraphDiff } from "../modules/playbook/diff.js";
import { GENRE_HINT, listSummary } from "../modules/playbook/read.js";
import { entryOf, loadManifest, readVersionText } from "../modules/playbook/store.js";
import { isPlaybookId, PlaybookError, PLAYBOOK_IDS, type PlaybookId } from "../modules/playbook/types.js";

const ACTIONS = ["list", "get", "propose", "rollback"] as const;
type R = Record<string, unknown>;

export const PLAYBOOK_DESCRIPTION =
  "体裁手册（5 本，写稿按立意选的那本写）。list 看版本与待批提案数；get{id,version?} 读全文与历史；" +
  "propose{id,based_on,text,reason,founder_words} 交整本修订进「等你拍板」；rollback{id,to_version,expected_current_version,founder_words,request_id} 创始人说回滚才调。";

export const playbookSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS], description: "list / get / propose / rollback" }),
  id: Type.Optional(Type.String({ description: "手册 id：ganhuo / shiyan / fanchangshi / xinxicha / renwu" })),
  version: Type.Optional(Type.Integer({ description: "get：第几版，缺省当前版" })),
  based_on: Type.Optional(Type.Integer({ description: "propose：你读到的当前版本号" })),
  text: Type.Optional(Type.String({ description: "propose：整本新全文（≤4000 字）" })),
  reason: Type.Optional(Type.String({ description: "propose：改了什么、为什么" })),
  founder_words: Type.Optional(Type.String({ description: "创始人的原话，照抄" })),
  to_version: Type.Optional(Type.Integer({ description: "rollback：回到第几版" })),
  expected_current_version: Type.Optional(Type.Integer({ description: "rollback：你看到的当前版本号" })),
  request_id: Type.Optional(Type.String({ description: "rollback：请求号，重试用同一个" })),
});

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const int = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
};
const fail = (code: string, error: string, extra: R = {}): R => ({ ok: false, code, error, ...extra });

async function get(p: Record<string, unknown>, id: PlaybookId, dataDir?: string): Promise<R> {
  const m = await loadManifest(dataDir);
  const e = entryOf(m, id);
  const version = int(p.version) ?? e.current;
  if (!e.versions.some((v) => v.version === version)) return fail("not_found", `手册 ${id} 没有第 ${version} 版（现在到第 ${e.current} 版）`);
  const pending = await Promise.all(e.proposals.filter((x) => x.status === "pending").map(async (x) => ({
    proposal_id: x.id, kind: x.kind, based_on: x.based_on, reason: x.reason, founder_words: x.founder_words, diff: paragraphDiff(await readVersionText(id, x.based_on, dataDir), x.text),
  })));
  return { ok: true, id, name: e.name, version, current_version: e.current, text: await readVersionText(id, version, dataDir), history: e.versions, pending_proposals: pending };
}

async function propose(p: Record<string, unknown>, id: PlaybookId, dataDir?: string): Promise<R> {
  const basedOn = int(p.based_on), text = typeof p.text === "string" ? p.text : "", reason = str(p.reason);
  if (!basedOn || !text.trim() || !reason) return fail("bad_param", "propose 要带 based_on（读到的当前版本号）、text（整本新全文）和 reason（改了什么、为什么）");
  const r = await proposeRevision({ id, based_on: basedOn, text, reason, founder_words: str(p.founder_words) ?? "" }, dataDir);
  return { ...r, next_action: "已进「等你拍板」：autocrew_review_inbox list 拿到这条（type=playbook_change），把 brief 里的改前改后给创始人看，他说批才 decide approve_playbook" };
}

async function rollback(p: Record<string, unknown>, id: PlaybookId, dataDir?: string): Promise<R> {
  const to = int(p.to_version), expected = int(p.expected_current_version), words = str(p.founder_words), requestId = str(p.request_id);
  if (!to || !expected || !words || !requestId) return fail("bad_param", "rollback 要带 to_version、expected_current_version（你看到的当前版本号）、founder_words（创始人说回滚的原话）和 request_id");
  if (!isRequestId(requestId)) return fail("bad_param", "request_id 只能是 1–100 位字母、数字、-、_");
  const r = await rollbackPlaybook({ id, to_version: to, expected_current_version: expected, founder_words: words, request_id: requestId, source: "tool", requested_by: requesterOf(p._host, p._session) }, dataDir);
  return { ...r, next_action: "告诉创始人：已回滚，生成了新版本，历史都在；之后新出的立意用这一版，已经在写的稿不换" };
}

export async function executePlaybook(params: Record<string, unknown>): Promise<R> {
  const action = str(params.action) ?? "list";
  const dataDir = str(params._dataDir);
  try {
    if (action === "list") return { ok: true, playbooks: listSummary(await loadManifest(dataDir)) };
    if (!(ACTIONS as readonly string[]).includes(action)) return fail("bad_param", `未知动作：${action}；可用 ${ACTIONS.join(" / ")}`);
    const id = str(params.id)?.toLowerCase();
    if (!isPlaybookId(id)) return fail("bad_genre", `不认识的手册：${id ?? "（空）"}。${GENRE_HINT.replace("genre", "id")}`, { ids: [...PLAYBOOK_IDS] });
    if (action === "get") return await get(params, id, dataDir);
    if (action === "propose") return await propose(params, id, dataDir);
    return await rollback(params, id, dataDir);
  } catch (e) {
    if (e instanceof PlaybookError) return fail(e.code, e.message, e.extra);
    return fail("storage_error", `手册读写失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
