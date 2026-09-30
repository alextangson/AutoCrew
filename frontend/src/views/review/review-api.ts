/** 「等你拍板」的服务端调用：读列表、单一决定入口（带 item_id + gen）。失败一律回人话，不抛 */
import { authedFetch, SESSION_EXPIRED } from "../../transport";
import type { InboxView } from "./review-model";

type Json = Record<string, unknown>;
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; body?: Json };

async function call<T>(url: string, init?: RequestInit): Promise<Reply<T>> {
  try {
    const r = await authedFetch(url, { credentials: "same-origin", ...init });
    const body = await r.json().catch(() => null) as (Json & { ok?: boolean; error?: string }) | null;
    if (!r.ok || !body || body.ok === false) return { ok: false, error: body?.error ?? (r.status === 403 ? SESSION_EXPIRED : `服务没响应（HTTP ${r.status}）`), ...(body ? { body } : {}) };
    return { ok: true, data: body as T };
  } catch (e) {
    if (e instanceof Error && e.message === SESSION_EXPIRED) return { ok: false, error: SESSION_EXPIRED };
    return { ok: false, error: `连不上 AutoCrew 服务：${e instanceof Error ? e.message : String(e)}` };
  }
}

export const loadInbox = () => call<InboxView>("/api/inbox");

/** 条目的动作：params 原样来自后端给的 actions[i].params，再加 item_id / gen / 一句话等可编辑字段 */
export const decideItem = (payload: Json) =>
  call<Json>("/api/inbox/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

/** 撤回（撤销批准、纠正发布）：不在列表里的动作，走卡片的决定路由 */
export const undoDecision = (contentId: string, action: string, params: Json) =>
  call<Json>("/api/board/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content_id: contentId, action, ...params }) });

/** 条目预览（成片 / 封面 / 候选）：按 fact_id 取，条目里不带路径 */
export const mediaUrl = (contentId: string, factId: string) =>
  `/api/inbox/media?content_id=${encodeURIComponent(contentId)}&fact_id=${encodeURIComponent(factId)}`;

export const attachmentUrl = (contentId: string, askId: string, index: number) =>
  `/api/inbox/attachment?content_id=${encodeURIComponent(contentId)}&ask_id=${encodeURIComponent(askId)}&index=${index}`;

/** 卡片 / 稿件页 / 工作台里「去『等你拍板』处理」：让看板上的列表打开这条稿的那件事 */
/** 不在看板页时（工作台、稿件页）：回看板并打开这条稿的那件事 */
export const inboxHref = (contentId: string) => `#/board?inbox=${encodeURIComponent(contentId)}`;

export const INBOX_OPEN_EVENT = "autocrew:inbox-open";
export interface InboxOpenDetail { content_id: string; types?: string[] }
export function openInboxItem(contentId: string, types?: string[]): void {
  window.dispatchEvent(new CustomEvent<InboxOpenDetail>(INBOX_OPEN_EVENT, { detail: { content_id: contentId, ...(types ? { types } : {}) } }));
}
