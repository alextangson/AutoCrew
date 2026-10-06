/** 设置页「原片放哪里」要看的东西：收件箱路径（手动收件 spec 2026-10-06：监视文件夹、暂停、转写环境都已删掉） */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { contentRoot } from "../../storage/content-project.js";
import { inboxToCreate, movableRoots } from "./roots.js";

export async function arollSourcesView(dataDir: string): Promise<Record<string, unknown>> {
  return { ok: true, inbox: await inboxToCreate(dataDir) };
}

export interface RevealSourceDeps { spawnImpl?: (cmd: string, args: string[], opts: Record<string, unknown>) => { unref?: () => void }; platform?: string }

/** 卡片候选的「在访达中显示」：只显示这条稿本轮这条候选 / 核对中事实自己的文件 */
export async function revealFactPath(contentId: string, factId: string, dataDir: string, deps: RevealSourceDeps = {}): Promise<Record<string, unknown>> {
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  // 候选 / 核对中的，和本轮已挂的原片（1b 验收：原片行也要「在访达中显示」）
  const f = doc.facts.find((x) => x.id === factId && x.round === doc.round && (x.state === "candidate" || x.state === "pending_match" || (x.state === "accepted" && x.kind === "aroll")));
  if (!f?.path) return { ok: false, code: "not_allowed", error: "这条没有可显示的文件，刷新再看" };
  const abs = path.isAbsolute(f.path) ? f.path : path.join(contentRoot(contentId, dataDir), f.path);
  const real = await fs.realpath(abs).catch(() => null);
  if (!real) return { ok: false, code: "file_missing", error: "文件不在了（可能已经挪走），刷新再看" };
  return openInFinder(real, false, deps);
}

async function openInFinder(real: string, isDir: boolean, deps: RevealSourceDeps): Promise<Record<string, unknown>> {
  if ((deps.platform ?? process.platform) !== "darwin") return { ok: true, path: real, opened: false };
  try {
    const child = (deps.spawnImpl ?? spawn)("open", isDir ? [real] : ["-R", real], { detached: true, stdio: "ignore" });
    child.unref?.();
    return { ok: true, path: real, opened: true };
  } catch (e) {
    return { ok: false, code: "open_failed", error: `访达没打开：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 「在访达中显示」（设置页）：只认收件箱目录与收件箱顶层文件；别的路径一律拒 */
export async function revealSourcePath(target: string, dataDir: string, deps: RevealSourceDeps = {}): Promise<Record<string, unknown>> {
  if (typeof target !== "string" || !path.isAbsolute(target)) return { ok: false, code: "bad_request", error: "要完整路径" };
  const real = await fs.realpath(target).catch(() => null);
  if (!real) return { ok: false, code: "file_missing", error: "文件不在了（可能已经挪走），刷新再看" };
  const inbox = (await movableRoots(dataDir)).inbox;
  const isDir = real === inbox;
  const inInbox = Boolean(inbox) && path.dirname(real) === inbox;
  if (!isDir && !inInbox) return { ok: false, code: "not_allowed", error: "只能显示收件箱里的东西" };
  return openInFinder(real, isDir, deps);
}
