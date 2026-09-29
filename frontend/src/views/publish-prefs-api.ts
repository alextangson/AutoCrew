/** 发布前把关的创始人专属接口（浏览器会话路由 /api/publish-prefs、/api/publish-instruction）。失败都带原因回来，不静默 */

export type Proposal = { id: string; kind: "cover_ratio" | "rule"; platform?: string; value: string[] | string; founder_quote: string; host: string; at: string };
export type PublishRule = { id: string; text: string; platform?: string; added_at: string };
export type PublishPrefsView = {
  platforms: Array<{ id: string; label: string }>;
  defaults: Record<string, string[]>;
  crop_checks: Record<string, string[]>;
  coverRatios: Record<string, string[]>;
  publishRules: PublishRule[];
  proposals: Proposal[];
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, body?: unknown): Promise<Result<T>> {
  try {
    const r = await fetch(url, body === undefined
      ? { credentials: "same-origin" }
      : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => null) as ({ ok?: boolean; error?: string } & T) | null;
    if (!r.ok || !json?.ok) return { ok: false, error: json?.error ?? `HTTP ${r.status}` };
    return { ok: true, data: json };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export const loadPublishPrefs = () => call<PublishPrefsView>("/api/publish-prefs");
export const publishPrefsOp = (op: Record<string, unknown>) => call<PublishPrefsView>("/api/publish-prefs", op);
export const saveInstruction = (contentId: string, text: string, via: "copy" | "copy_open") =>
  call<{ instruction_id: string; copy_text: string }>("/api/publish-instruction", { content_id: contentId, text, via });

export function proposalText(p: Proposal, labelOf: (id: string) => string): string {
  const where = p.platform ? labelOf(p.platform) : "所有平台";
  return p.kind === "cover_ratio"
    ? `${where}封面上传 ${(p.value as string[]).join(" + ")}`
    : `发布规则（${where}）：${p.value as string}`;
}

/** 「打开 Codex」可以不重存指令的唯一情形：上次复制失败，且编辑框里的文本就是已存（带编号）的那份 */
export function skipResave(copyFailed: boolean, text: string, savedText: string | null): boolean {
  return copyFailed && savedText !== null && text === savedText;
}
