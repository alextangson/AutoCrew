/** 版本提醒与一键更新的服务端调用（self-update §2/§3）。失败一律回人话，不抛。 */
import { authedFetch, SESSION_EXPIRED } from "../../transport";

export interface ReleaseNotes { version: string; date: string; news: string[]; fixes: string[]; todo: string[] }
export interface UpdateStatus { checkedAt: string; current: string; latest?: string; available: boolean; reason?: string; error?: string }
export interface UpdateResult { ok: boolean; outcome: "updated" | "rolled_back" | "stuck" | "not_started"; from: string; to: string; message: string; log: string; manualCommands?: string[]; notes?: ReleaseNotes[] }
export interface UpdateView {
  current: string;
  currentDate: string | null;
  settings: { autoCheck: boolean; skipVersion?: string };
  status: UpdateStatus | null;
  banner: { version: string; notes: ReleaseNotes[] } | null;
  running: boolean;
  result: UpdateResult | null;
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

/** 服务重启期间轮询：连不上就继续等，回来且不再「正在更新」才算完 */
export async function waitBack(opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  while (Date.now() < deadline) {
    await sleep(opts.intervalMs ?? 2_000);
    const r = await loadUpdate();
    if (r.ok && !r.data.running) return true;
  }
  return false;
}
