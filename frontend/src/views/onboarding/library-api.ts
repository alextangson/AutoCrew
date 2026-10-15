/** 「资料放哪」的服务端调用（onboarding-connect §7.3）。失败一律回人话，不抛。 */
import { authedFetch, SESSION_EXPIRED } from "../../transport";

export interface LibraryStatus { configured: boolean; root: string | null; defaultPath: string; legacyDrafts: number }
export type SetupResult =
  | { status: "already" | "created" | "opened" | "migrated"; root: string; backup?: string; afterRestart?: string[] }
  | { status: "queued_restart"; root: string; backup: string }
  | { status: "needs_legacy_choice"; root: string; drafts: number; files?: number }
  | { status: "refused"; code: string; error: string; root?: string; suggestion?: string };
export type LibReply<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<LibReply<T>> {
  try {
    const r = await authedFetch(url, init);
    const body = (await r.json().catch(() => null)) as ({ ok?: boolean; error?: string; data?: T; status?: string } & Record<string, unknown>) | null;
    // 拒绝（路径不合适）是一种结果，原样交给界面显示原因
    if (body?.status === "refused") return { ok: true, data: body as unknown as T };
    if (!r.ok || !body) return { ok: false, error: body?.error ?? (r.status === 403 ? SESSION_EXPIRED : `服务没响应（HTTP ${r.status}）`) };
    if (body.ok === false) return { ok: false, error: body.error ?? "没成功，原因没写" };
    return { ok: true, data: body.data as T };
  } catch (e) {
    return { ok: false, error: `连不上 AutoCrew 服务：${e instanceof Error ? e.message : String(e)}` };
  }
}

export const loadLibrary = () => call<LibraryStatus>("/api/library");
export const setupLibrary = (target: string, legacy?: "migrate" | "keep") =>
  call<SetupResult>("/api/library/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target, ...(legacy ? { legacy } : {}) }) });
