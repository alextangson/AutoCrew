/**
 * 「让 Codex 发布」的打开对话：只收稿件 id，对话 id 由服务端从本条稿的执行记录里取（必须是 UUID），
 * 浏览器永远传不进链接或对话 id。找不到就开新对话。只打开，不发消息、不发布。
 * darwin 用 `open codex://threads/<id>`；其他平台只回链接。spawn 可注入，测试不真开窗。
 */
import { spawn } from "node:child_process";
import { getContent } from "../storage/local-store.js";
import { executionWithCovers } from "../modules/video/handoff/founder-review.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CodexOpenResult =
  | { ok: true; link: string; thread: boolean; opened: boolean }
  | { ok: false; code: "bad_request" | "not_found" | "open_failed"; error: string; link?: string };
export interface CodexOpenDeps { spawnImpl?: typeof spawn; platform?: NodeJS.Platform }

/** 本条稿当前执行者的 Codex 对话链接；没有或不是 UUID → 新对话 */
export async function codexLinkFor(id: string, dataDir: string): Promise<{ link: string; thread: boolean } | null> {
  const content = await getContent(id, dataDir).catch(() => null);
  if (!content) return null;
  const execution = await executionWithCovers(content, dataDir, content.video?.handoff?.generation ?? 1);
  const session = execution?.session_id?.trim() ?? "";
  return UUID.test(session) ? { link: `codex://threads/${session.toLowerCase()}`, thread: true } : { link: "codex://threads/new", thread: false };
}

export async function openCodexForContent(id: string, dataDir: string, deps: CodexOpenDeps = {}): Promise<CodexOpenResult> {
  if (!/^content-\d+-[a-z0-9]+$/.test(id)) return { ok: false, code: "bad_request", error: "参数不对" };
  const at = await codexLinkFor(id, dataDir);
  if (!at) return { ok: false, code: "not_found", error: "找不到这条稿" };
  if ((deps.platform ?? process.platform) !== "darwin") return { ok: true, ...at, opened: false };
  const code = await new Promise<number | string>((resolve) => {
    try {
      const child = (deps.spawnImpl ?? spawn)("open", [at.link], { stdio: "ignore" });
      child.on("error", (e) => resolve(e.message));
      child.on("exit", (c) => resolve(c ?? "被中断"));
    } catch (e) { resolve(e instanceof Error ? e.message : String(e)); }
  });
  if (code === 0) return { ok: true, ...at, opened: true };
  const why = typeof code === "number" ? `open 退出码 ${code}，可能没装 Codex 桌面版` : code;
  return { ok: false, code: "open_failed", error: `Codex 没打开：${why}`, link: at.link };
}
