/** 看板与数据页的服务端调用：读看板、开始写、我发了 / 撤销；读数据页、关联 / 撤销。失败一律回人话，不抛。 */
import type { BoardData } from "./board-columns";
import type { DataPageData } from "./data-lib";

type Json = Record<string, unknown>;
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const r = await fetch(url, { credentials: "same-origin", ...init });
    const body = await r.json().catch(() => null) as (Json & { ok?: boolean; error?: string; data?: T }) | null;
    if (!r.ok || !body || body.ok === false) return { ok: false, error: body?.error ?? (r.status === 403 ? "没有权限（登录过期？刷新页面试试）" : `服务没响应（HTTP ${r.status}）`) };
    return { ok: true, data: (body.data ?? body) as T };
  } catch (e) {
    return { ok: false, error: `连不上 AutoCrew 服务：${e instanceof Error ? e.message : String(e)}` };
  }
}

const post = <T>(url: string, payload: Json) => call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

export const loadBoard = () => call<BoardData>("/api/board");

export interface StartReply { created: boolean; content_id: string; prompt?: string; opened?: boolean; open_error?: string; code?: string }
export const startWriting = (topicId: string, platform?: string) => post<StartReply>("/api/board/start-writing", { topic_id: topicId, ...(platform ? { platform } : {}) });

export const markPublished = (contentId: string, platform: string, url?: string) =>
  post<Json>("/api/board/mark-published", { content_id: contentId, platform, ...(url ? { url } : {}) });
export const unmarkPublished = (contentId: string, platform: string) =>
  post<Json>("/api/board/mark-published", { content_id: contentId, platform, undo: true });

/* 数据页（数据页规格 §F / §G）：读数据、手动关联 / 合并 / 拆开、撤销 */
export const loadDataPage = () => call<DataPageData>("/api/data");
export interface LinkReply { id: string }
export const linkWorks = (payload: { op: "link" | "merge" | "split"; works: string[]; content_id?: string; target?: string }) =>
  post<LinkReply>("/api/data/link", payload);
export const undoLink = (id: string) => post<{ removed: boolean }>("/api/data/undo", { id });
