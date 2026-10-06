/** 看板与数据页的服务端调用：读看板、开始写、我发了 / 撤销；读数据页、关联 / 撤销。失败一律回人话，不抛。 */
import type { BoardData } from "./board-columns";
import { authedFetch, SESSION_EXPIRED } from "../transport";
import type { DataPageData } from "./data-lib";

type Json = Record<string, unknown>;
/** 失败时 body 原样带回（code、改挂要的归属信息等），界面按 code 决定下一步 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; body?: Json };

async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const r = await authedFetch(url, { credentials: "same-origin", ...init });
    const body = await r.json().catch(() => null) as (Json & { ok?: boolean; error?: string; data?: T }) | null;
    if (!r.ok || !body || body.ok === false) return { ok: false, error: body?.error ?? (r.status === 403 ? SESSION_EXPIRED : `服务没响应（HTTP ${r.status}）`), ...(body ? { body } : {}) };
    return { ok: true, data: (body.data ?? body) as T };
  } catch (e) {
    // 会话交换失败（地址栏 token 与 cookie 都无效）不是「连不上」：原样给怎么拿新链接
    if (e instanceof Error && e.message === SESSION_EXPIRED) return { ok: false, error: SESSION_EXPIRED };
    return { ok: false, error: `连不上 AutoCrew 服务：${e instanceof Error ? e.message : String(e)}` };
  }
}

const post = <T>(url: string, payload: Json) => call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

export const loadBoard = () => call<BoardData>("/api/board");

export interface StartReply { created: boolean; content_id: string; prompt?: string; opened?: boolean; open_error?: string; needs_angle?: boolean; code?: string }
export const startWriting = (topicId: string, platform?: string) => post<StartReply>("/api/board/start-writing", { topic_id: topicId, ...(platform ? { platform } : {}) });

export const markPublished = (contentId: string, platform: string, url?: string) =>
  post<Json>("/api/board/mark-published", { content_id: contentId, platform, ...(url ? { url } : {}) });
export const unmarkPublished = (contentId: string, platform: string) =>
  post<Json>("/api/board/mark-published", { content_id: contentId, platform, undo: true });

/** 启用本体（§4.1）：创始人看过差异清单后确认；exclude = 看过失败清单后明确排除的稿 */
export interface EnableFailure { id: string; title: string; step: string; error: string }
export async function enableOntology(exclude: string[] = []): Promise<{ ok: boolean; error?: string; failures: EnableFailure[] }> {
  try {
    const r = await authedFetch("/api/board/ontology/enable", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, exclude }) });
    const body = await r.json().catch(() => null) as { ok?: boolean; error?: string; failures?: EnableFailure[] } | null;
    if (!r.ok || !body) return { ok: false, error: r.status === 403 ? SESSION_EXPIRED : `服务没响应（HTTP ${r.status}）`, failures: [] };
    return { ok: body.ok === true, ...(body.error ? { error: body.error } : {}), failures: body.failures ?? [] };
  } catch (e) {
    return { ok: false, error: `连不上 AutoCrew 服务：${e instanceof Error ? e.message : String(e)}`, failures: [] };
  }
}

/* 数据页（数据页规格 §F / §G）：读数据、手动关联 / 合并 / 拆开、撤销 */
export const loadDataPage = () => call<DataPageData>("/api/data");
export interface LinkReply { id: string }
export const linkWorks = (payload: { op: "link" | "merge" | "split"; works: string[]; content_id?: string; target?: string }) =>
  post<LinkReply>("/api/data/link", payload);
export const undoLink = (id: string) => post<{ removed: boolean }>("/api/data/undo", { id });

/* 数据页封面（§I.56）：请求体就是图片字节 */
export const uploadCover = (key: string, file: Blob) =>
  call<{ file: string }>(`/api/data/cover?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
export const removeCover = (key: string) => post<{ removed: boolean }>("/api/data/cover-remove", { key });

/* 撤回交接：创始人会话走 /api/project-review 的 revoke，服务端跑完整撤回 */
export interface RevokeReply { ok: boolean; error?: string; aroll_restored_to?: string; aroll_restore_failed?: string }
export const revokeHandoff = (contentId: string, manifestHash: string) =>
  post<RevokeReply>(`/api/project-review?content_id=${encodeURIComponent(contentId)}`, { action: "revoke", manifest_hash: manifestHash });

/* 本体卡片面板（spec §10）：读面板、创始人决定、重开文稿 */
export interface CardCandidate { fact_id: string; kind: string; path?: string; evidence?: string; sha256?: string; post_publish?: boolean; state?: string; started_at?: string }
/** 本轮 accepted 原片（1b §4.1）：能撤就给「不是」，撤不了给原因 */
export interface ArollRow { fact_id: string; sha256: string; path: string; name?: string; origin?: string; duration_ms?: number | null; at?: string; auto_attached: boolean; source_path: string | null; undo_blocked: string | null }
export interface CardPanelData {
  id: string; title: string; platform: string | null; status: string; active: boolean;
  column: string | null; stage: string | null; reason?: string; missing: string[]; badges: string[]; alerts?: string[]; candidates: CardCandidate[];
  round?: number; checklist?: string | null; can_reopen?: boolean;
  published_now?: boolean; past_receipts?: Array<{ round: number; platform: string; label: string; url: string | null; at: string }>;
  pending_receipts?: Array<{ fact_id: string; platform: string | null; url: string | null; host: string }>;
  published?: Array<{ id: string; kind: string; platform: string | null; url: string | null; work?: string | null; label: string; at: string }>;
  approvals?: { cut: { id: string; sha256?: string } | null; cover: { id: string } | null };
  slivers?: SliverPanel | null;
  /** B7：有导出但 agent 还没说可以审（没有就是 null） */
  unreviewed?: { count: number; editor_label: string } | null;
  /** 「稿子写好了」这件事的身份与代次：认稿要带它 */
  draft_item?: { item_id: string; gen: string };
  /** 正式封面文件夹以外的封面图（多半是中间文件）：只在制作中的稿卡上收成一行 */
  stray_covers?: { count: number } | null;
  storyboard?: StoryboardPanel | null;
  arolls?: ArollRow[];
  candidate_rows?: CandidateRowView[];
}
/** 「发现的候选」一行（服务端已翻成人话；完整路径与分数只在 detail 里） */
export interface CandidateRowView { fact_id: string; kind: string; state: string; sha256?: string; started_at?: string; name: string; origin: string; reason: string; detail: string; path: string | null; in_inbox?: boolean }
export const revealFact = (contentId: string, factId: string) => post<Json>("/api/board/reveal-source", { content_id: contentId, fact_id: factId });
/** 分镜（spec 2026-09-30-storyboard-review-check §4）：最新一版 + 旧版 */
export interface StoryboardView { fact_id: string; sha256: string; version: string; path: string; at: string }
export interface StoryboardPanel { latest: StoryboardView & { changed: boolean; missing: boolean; note?: string }; older: StoryboardView[] }
export const openStoryboard = (contentId: string, factId: string) => post<Json>("/api/board/open-storyboard", { content_id: contentId, fact_id: factId });
/** 抽帧检查（spec 2026-09-30 §6）：status none = 还没有结果 */
export interface SliverItem { key: string; start_frame: number; end_frame: number; frames: number; start_tc: string; prev_name?: string; next_name?: string; transition?: boolean; suggestion?: string; waived: boolean }
export interface SliverPanel {
  cut_sha: string; status: "clean" | "slivers" | "unchecked" | "none"; reason: string | null; fingerprint: string | null;
  blocked: boolean; missing: string | null; whole_waivable: boolean; whole_waived: boolean; items: SliverItem[];
}
export const loadCard = (contentId: string) => call<CardPanelData>(`/api/board/card?content_id=${encodeURIComponent(contentId)}`);
export const decide = (contentId: string, action: string, params: Json = {}) => post<Json>("/api/board/decision", { content_id: contentId, action, ...params });
export const chooseFile = () => post<{ path: string }>("/api/board/choose-file", {});
export const reopenScript = (contentId: string, round: number) => post<Json>("/api/board/reopen-script", { content_id: contentId, confirm: true, round });

/* 「原片从哪里找」（1b §5）：读 / 写只走浏览器会话 */
export interface ArollSourcesView { inbox: string | null }
export const loadSources = () => call<ArollSourcesView>("/api/board/aroll-sources");
export const sourceOp = (op: string, params: Json = {}) => post<Json>("/api/board/aroll-sources", { op, ...params });
export const revealSource = (path: string) => post<Json>("/api/board/reveal-source", { path });
