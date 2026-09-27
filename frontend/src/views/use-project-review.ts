/** 读 /api/project-review 并提交创始人决定；看板打开期间按 REFRESH_MS 自动刷新。错误原样给页面。 */
import { useCallback, useEffect, useState } from "react";
import { REFRESH_MS, type ProjectReview } from "./project-board";

export function useProjectReview(contentId: string, poll: boolean) {
  const [review, setReview] = useState<ProjectReview | null>(null);
  const [error, setError] = useState("");
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
  const refresh = useCallback(async () => {
    try { setReview(await read()); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [read]);
  useEffect(() => {
    let live = true;
    setReview(null); setError("");
    const tick = () => { read().then((s) => { if (live) { setReview(s); setError(""); } }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); }); };
    tick();
    const timer = poll ? window.setInterval(tick, REFRESH_MS) : undefined;
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [read, poll]);
  /** 创始人决定：成功后用回执刷新；失败原样抛给调用方显示 */
  const submit = useCallback(async (payload: Record<string, unknown>): Promise<boolean> => {
    setBusy(true); setError("");
    try {
      setReview(await read({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  }, [read]);
  return { review, error, busy, submit, refresh };
}

