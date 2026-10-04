/**
 * 工作台上的薄路径定稿（会审 #1）：读定稿清单、再审、「定了」。
 * 「定了」只认浏览器会话（创始人本人点的）；令牌调用宿主也拿得到，一律拒——AI 不能批准稿件（09-29 批准伪造漏洞）。
 */
import { enqueueReview, reviewView } from "../modules/draft/codex-review-queue.js";
import { finalizeByFounder, finalPanel } from "../modules/draft/draft-finalize.js";
import type { IpcHandler } from "./ipc.js";

const dirOf = (p: Record<string, unknown>) => (typeof p._dataDir === "string" && p._dataDir) || undefined;
const idOf = (p: Record<string, unknown>) => (typeof p.id === "string" ? p.id.trim() : "");
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const FOUNDER_ONLY_FINALIZE = "「定了」只能由创始人在工作台点；AI 宿主不能代点。把工作台链接交给创始人。";

const finalGet: IpcHandler = async (p) => {
  try { return await finalPanel(idOf(p), await reviewView(idOf(p), dirOf(p)), dirOf(p)); }
  catch (err) { return { ok: false, error: errText(err) }; }
};

const reviewRerun: IpcHandler = async (p) => {
  try { const r = await enqueueReview(idOf(p), dirOf(p)); return { ok: true, coalesced: r.coalesced, review: await reviewView(idOf(p), dirOf(p)) }; }
  catch (err) { return { ok: false, error: errText(err) }; }
};

const finalize: IpcHandler = async (p, ctx) => {
  if (ctx?.authMethod !== "session") return { ok: false, code: "founder_only", error: FOUNDER_ONLY_FINALIZE };
  const keep = Array.isArray(p.keep) ? p.keep.filter((k): k is string => typeof k === "string") : [];
  try { return await finalizeByFounder(idOf(p), { draftHash: String(p.draft_hash ?? ""), keep }, dirOf(p)); }
  catch (err) { return { ok: false, error: errText(err) }; }
};

export const DRAFT_IPC_HANDLERS = {
  "draft:final_get": finalGet,
  "draft:review_rerun": reviewRerun,
  "draft:finalize": finalize,
} as const;
