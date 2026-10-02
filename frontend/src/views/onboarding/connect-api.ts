/** 一键接入的服务端调用（onboarding-connect §3）。只走浏览器会话端点；失败一律回人话，不抛。 */
import { authedFetch, SESSION_EXPIRED } from "../../transport";

export type HostId = "claude" | "codex" | "workbuddy";
export interface HostStatus {
  host: HostId;
  label: string;
  found: boolean;
  loggedIn: boolean | null;
  detail: string;
  connected: boolean;
  /** 写进去了但没核对上：原因 */
  unverified?: string;
  hasEntry?: boolean;
  hasToken?: boolean;
  /** 服务端按 host-policy 算的：能不能写稿 */
  canWrite?: boolean;
  lastUsedAt?: string;
}
export interface ConnectView { hosts: HostStatus[]; skipped: boolean }
export interface ConnectResult { ok: boolean; host: HostId; registered: boolean; verified: boolean; message: string; error?: string; code?: string; replaced?: boolean; backup?: string }
export type ProbeResult = { ok: true; detail: string } | { ok: false; code: string; error: string };
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit, raw = false): Promise<Reply<T>> {
  try {
    const r = await authedFetch(url, init);
    const body = (await r.json().catch(() => null)) as ({ ok?: boolean; error?: string; data?: T } & Record<string, unknown>) | null;
    if (!r.ok || !body) return { ok: false, error: body?.error ?? (r.status === 403 ? SESSION_EXPIRED : `服务没响应（HTTP ${r.status}）`) };
    // 接入 / 检测的结果本身带 ok:false（写进去了但没核对上、没登录…），要原样交给界面
    if (raw) return { ok: true, data: body as unknown as T };
    if (body.ok === false) return { ok: false, error: body.error ?? "没成功，原因没写" };
    return { ok: true, data: (body.data ?? body) as T };
  } catch (e) {
    return { ok: false, error: `连不上 AutoCrew 服务：${e instanceof Error ? e.message : String(e)}` };
  }
}
const post = <T>(url: string, payload: Record<string, unknown>, raw = false) =>
  call<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, raw);

export const loadConnect = () => call<ConnectView>("/api/connect");
export const probeHost = (host: HostId) => post<ProbeResult>("/api/connect/probe", { host }, true);
export const connectHost = (host: HostId) => post<ConnectResult>("/api/connect/connect", { host }, true);
export const disconnectHost = (host: HostId) => post<ConnectResult>("/api/connect/disconnect", { host }, true);
export const skipOnboarding = () => post<{ skipped: boolean }>("/api/connect/skip", { skipped: true });

/** 网络/会话层面的失败也折成一条结果，界面只认一种形状 */
export function asResult(host: HostId, r: Reply<ConnectResult>): ConnectResult {
  return r.ok ? r.data : { ok: false, host, registered: false, verified: false, message: r.error, error: r.error };
}

/** 引导出现的条件（spec §2.1）：没配引擎、没接任何宿主、没点过「先不配」 */
export function shouldOnboard(engineConfigured: boolean, view: Reply<ConnectView>): boolean {
  if (engineConfigured) return false;
  if (!view.ok) return true;
  // 没核对上的条目不算接好（Codex 评审 P2-3）；用过的老令牌（仓库 .mcp.json 开发用）算
  return !view.data.skipped && !view.data.hosts.some((h) => h.connected || (h.lastUsedAt && !h.unverified));
}
