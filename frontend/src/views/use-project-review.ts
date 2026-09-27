/**
 * 读 /api/project-review 并提交创始人决定；看板打开期间按 REFRESH_MS 自动刷新。
 * error = 首次读取或提交失败（原样给页面）；refreshError = 已有数据时后台刷新失败，
 * 页面据此明说「看板更新失败（上次更新 x 分钟前）」，不把旧数据装成新的。
 */
import { useCallback, useEffect, useState } from "react";
import { REFRESH_MS, type ProjectReview } from "./project-board";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useProjectReview(contentId: string, poll: boolean) {
  const [review, setReview] = useState<ProjectReview | null>(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/project-review?content_id=${encodeURIComponent(contentId)}`;
  const read = useCallback(async (init?: RequestInit) => {
    const r = await fetch(url, { credentials: "same-origin", ...init });
    const text = await r.text();
    let body: ProjectReview | null = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON 错误页原样显示 */ }
    if (!r.ok || body?.ok === false) throw new Error(body?.error ?? (text || `HTTP ${r.status}`));
    return body!;
  }, [url]);
  const accept = useCallback((s: ProjectReview) => { setReview(s); setError(""); setRefreshError(""); setLastOkAt(Date.now()); }, []);
  useEffect(() => {
    let live = true, loaded = false;
    setReview(null); setError(""); setRefreshError(""); setLastOkAt(null);
    const tick = () => {
      read().then((s) => { if (live) { loaded = true; accept(s); } })
        .catch((e) => { if (live) (loaded ? setRefreshError : setError)(message(e)); });
    };
    tick();
    const timer = poll ? window.setInterval(tick, REFRESH_MS) : undefined;
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [read, poll, accept]);
  /** 创始人决定：成功后用回执刷新；失败原样给调用方显示 */
  const submit = useCallback(async (payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setError("");
    try { accept(await read({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })); return true; }
    catch (e) { setError(message(e)); return false; } finally { setBusy(false); }
  }, [read, accept]);
  return { review, error, refreshError, lastOkAt, busy, submit };
}
