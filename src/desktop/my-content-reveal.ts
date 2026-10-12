/**
 * 进度栏「在访达打开这一条」（发布台 spec 2026-10-12 补做 A）：打开「我的内容」里这条稿的文件夹，不是 AI 的项目目录。
 * 点的时候才按视图清单（.autocrew-view.json 的 dirs）找——卡片可能刚换栏。找不到就说清楚为什么，绝不换个文件夹偷偷打开。
 * 路径安全：realpath 必须还在「我的内容」根下；浏览器只传稿件 id。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { getContent } from "../storage/local-store.js";
import { getLibraryRoot, isWithin, readLibraryLocation } from "../storage/storage-roots.js";
import { VIEW_DIR, VIEW_MANIFEST } from "../storage/my-content-view.js";
import { folderTitle } from "../storage/my-content-plan.js";
import { explainContent } from "../modules/production/read.js";
import type { RevealDeps } from "./project-reveal.js";

export type MyContentRevealResult =
  | { ok: true; path: string; opened: true }
  | { ok: false; code: "bad_request" | "not_found" | "not_in_view" | "view_unreadable" | "open_failed"; error: string; path?: string };

export interface MyContentRevealDeps extends RevealDeps { viewRoot?: string | null; openTimeoutMs?: number; retryMs?: number }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function defaultViewRoot(): string | null {
  return readLibraryLocation() ? path.join(getLibraryRoot(), VIEW_DIR) : null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 视图里没有这条：按「上次同步出错 → 已发布超出保留 → 还没同步到」给原因 */
export async function missingReason(root: string, id: string, title: string, column: string | null): Promise<string> {
  const state = await readJson<Record<string, string[]>>(path.join(root, ".autocrew-errors.json")).catch(() => null);
  const hit = (state?.sync ?? []).find((e) => e.includes(id) || e.includes(`/${title}`));
  if (hit) return `上次同步这条出错了：${hit}`;
  if (column === "已发布") return "这条已发布，不在「我的内容」保留的最近几条里";
  return "「我的内容」还没同步到这条（每分钟对一次账，稍后再点）";
}

const UNREADABLE = "「我的内容」正在同步或读不出，稍后再点";

/** 清单坏了 / 读不出（对账中途覆盖）：等一下重读一次；还不行就算读不出，不当成「没有这条」 */
async function readManifest(file: string, retryMs: number): Promise<{ dirs?: Record<string, string> } | null | "unreadable"> {
  for (let i = 0; i < 2; i++) {
    try { return await readJson<{ dirs?: Record<string, string> }>(file); }
    catch { if (i === 0) await new Promise((r) => setTimeout(r, retryMs)); }
  }
  return "unreadable";
}

type Found = { ok: true; path: string } | Extract<MyContentRevealResult, { ok: false }>;

async function locate(id: string, dataDir: string, deps: MyContentRevealDeps): Promise<Found> {
  const content = await getContent(id, dataDir);
  if (!content || content.deletedAt) return { ok: false, code: "not_found", error: "这条稿不在了" };
  const root = deps.viewRoot === undefined ? defaultViewRoot() : deps.viewRoot;
  if (!root) return { ok: false, code: "not_in_view", error: "没有配置资料库，没有「我的内容」文件夹" };
  const manifest = await readManifest(path.join(root, VIEW_MANIFEST), deps.retryMs ?? 300);
  if (manifest === "unreadable") return { ok: false, code: "view_unreadable", error: UNREADABLE };
  if (!manifest) return { ok: false, code: "not_in_view", error: "「我的内容」还没生成过" };
  // 只认「栏目/稿件文件夹」这一层
  const rel = Object.entries(manifest.dirs ?? {}).find(([r, owner]) => owner === id && r.split("/").length === 2)?.[0];
  if (!rel) {
    const column = await explainContent(content, dataDir).then((x) => x.column, () => null);
    return { ok: false, code: "not_in_view", error: await missingReason(root, id, folderTitle(content), column) };
  }
  const dir = path.join(root, rel);
  const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(dir).catch(() => null)]);
  if (!real) return { ok: false, code: "not_in_view", error: "文件夹找不到了（可能刚换栏，等下一次对账）", path: dir };
  if (real === realRoot || !isWithin(realRoot, real)) return { ok: false, code: "bad_request", error: "这个文件夹不在「我的内容」里" };
  if (!(await fs.stat(real)).isDirectory()) return { ok: false, code: "not_in_view", error: "这里不是文件夹", path: dir };
  return { ok: true, path: real };
}

/** 等 open 退出：非 0 / 报错 / 超时都算没打开 */
function openDir(dir: string, deps: MyContentRevealDeps): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const end = (v: string | null) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => end("open 一直没返回（超时）"), deps.openTimeoutMs ?? 10_000);
    try {
      const child = (deps.spawnImpl ?? spawn)("open", [dir], { stdio: "ignore" });
      child.once("error", (e: Error) => end(errMsg(e)));
      child.once("exit", (code: number | null, sig: string | null) => end(code === 0 ? null : `open 退出码 ${code ?? sig}`));
    } catch (e) { end(errMsg(e)); }
  });
}

export async function revealMyContent(id: string, dataDir: string, deps: MyContentRevealDeps = {}): Promise<MyContentRevealResult> {
  if (!/^content-\d+-[a-z0-9]+$/.test(id)) return { ok: false, code: "bad_request", error: "参数不对" };
  const at = await locate(id, dataDir, deps).catch((e): Found => ({ ok: false, code: "view_unreadable", error: `读「我的内容」失败：${errMsg(e)}` }));
  if (!at.ok) return at;
  if ((deps.platform ?? process.platform) !== "darwin") return { ok: false, code: "open_failed", error: `这台机器不是 macOS，打不开访达；路径：${at.path}`, path: at.path };
  const fail = await openDir(at.path, deps);
  return fail ? { ok: false, code: "open_failed", error: `访达没打开：${fail}`, path: at.path } : { ok: true, path: at.path, opened: true };
}
