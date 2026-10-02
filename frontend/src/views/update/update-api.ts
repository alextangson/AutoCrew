/** 版本提醒与一键更新的服务端调用（self-update §2/§3）。失败一律回人话，不抛。 */
import { authedFetch, SESSION_EXPIRED } from "../../transport";

export interface ReleaseNotes { version: string; date: string; news: string[]; fixes: string[]; todo: string[] }
export interface UpdateStatus { checkedAt: string; current: string; latest?: string; available: boolean; reason?: string; error?: string }
export interface UpdateResult { ok: boolean; outcome: "updated" | "rolled_back" | "stuck" | "not_started" | "cancelled" | "aborted"; from: string; to: string; message: string; log: string; manualCommands?: string[]; notes?: ReleaseNotes[] }
export interface UpdateView {
  current: string;
  currentDate: string | null;
  settings: { autoCheck: boolean; skipVersion?: string };
  status: UpdateStatus | null;
  banner: { version: string; notes: ReleaseNotes[] } | null;
  running: boolean;
  result: UpdateResult | null;
  logDir?: string;
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<Reply<T>> {
  try {
    const r = await authedFetch(url, init);
    const body = await r.json().catch(() => null) as { ok?: boolean; error?: string; data?: T } | null;
    if (!r.ok || !body || body.ok === false) return { ok: false, error: body?.error ?? (r.status === 403 ? SESSION_EXPIRED : `服务没响应（HTTP ${r.status}）`) };
    return { ok: true, data: (body.data ?? body) as T };
  } catch (e) {
    return { ok: false, error: `连不上 AutoCrew 服务：${e instanceof Error ? e.message : String(e)}` };
  }
}
const post = <T>(url: string, payload: Record<string, unknown> = {}) =>
  call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

export const loadUpdate = () => call<UpdateView>("/api/update");
export const checkNow = () => post<UpdateView>("/api/update/check");
export const saveUpdateSettings = (p: { auto_check?: boolean; skip_version?: string | null }) => post<UpdateView>("/api/update/settings", p);
export const ackResult = () => post<UpdateView>("/api/update/ack");
export const startUpdate = () => post<{ from: string; to: string; log: string }>("/api/update/start");

export type WaitState = "updating" | "unreachable" | "stalled";

/**
 * 等更新跑完（第 12 轮 P2）：服务连得上、还在更新 → 一直等（装依赖慢的时候可能好几分钟），绝不叫人去重启；
 * 连不上 → 在重启，继续等；连续连不上超过 stalledAfterMs 才标成「卡住」，但照样接着轮询，回来了就算完。
 */
export async function waitBack(opts: {
  intervalMs?: number; stalledAfterMs?: number;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
  load?: typeof loadUpdate; onState?: (s: WaitState) => void;
} = {}): Promise<true> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const load = opts.load ?? loadUpdate;
  const stalledAfter = opts.stalledAfterMs ?? 5 * 60_000;
  let downSince: number | null = null;
  for (;;) {
    await sleep(opts.intervalMs ?? 2_000);
    const r = await load();
    if (r.ok && !r.data.running) return true;
    if (r.ok) { downSince = null; opts.onState?.("updating"); continue; }
    downSince ??= now();
    opts.onState?.(now() - downSince >= stalledAfter ? "stalled" : "unreachable");
  }
}
