/**
 * 发布台的一个刷新协调器（吸收 8）：卡片、各平台表、进度栏都读同一份 /api/board/desk。
 * 稿件变了（状态 / 存盘时刻）、引擎事件（回执 / 回流落盘）、定时到点都重读；回流慢，另外每 5 分钟读一次。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { subscribeEvents } from "../transport";
import { loadDesk, type DeskReply } from "./desk-api";

export interface DeskState { data: DeskReply | null; error: string | null; refresh: () => Promise<void> }
const Ctx = createContext<DeskState | null>(null);
export const useDesk = (): DeskState | null => useContext(Ctx);

const POLL_MS = 5 * 60_000;

export function DeskProvider(p: { contentId: string; refreshKey: string; children: ReactNode }) {
  const [data, setData] = useState<DeskReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const r = await loadDesk(p.contentId).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    if (mine !== seq.current) return;
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  }, [p.contentId]);
  useEffect(() => { void refresh(); }, [refresh, p.refreshKey]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeEvents((e) => {
      if (e.kind !== "engine" && e.kind !== "reconnect" && e.kind !== "video:updated" && e.kind !== "inbox") return;
      if (t) clearTimeout(t);
      t = setTimeout(() => void refresh(), 1500);
    });
    const poll = setInterval(() => void refresh(), POLL_MS);
    return () => { off(); clearInterval(poll); if (t) clearTimeout(t); };
  }, [refresh]);
  const at = data?.active ? data.desk.refresh_at : null;
  useEffect(() => {
    if (!at) return;
    const ms = Date.parse(at) - Date.now() + 5_000;
    if (!(ms > 0) || ms > 2 ** 31 - 1) return;
    const t = setTimeout(() => void refresh(), ms);
    return () => clearTimeout(t);
  }, [at, refresh]);
  return <Ctx.Provider value={{ data, error, refresh }}>{p.children}</Ctx.Provider>;
}
