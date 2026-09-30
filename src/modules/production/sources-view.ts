/** 设置页「原片从哪里找」要看的东西（1b §5）：收件箱路径、监视文件夹与各自最近一次扫描、暂停、转写环境、剪映导出目录 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { matchDeps } from "./match/deps.js";
import { readReconcileReport } from "./reconcile.js";
import { inboxToCreate, movableRoots } from "./roots.js";
import { folderProblem, readArollSources } from "./sources.js";

export async function arollSourcesView(dataDir: string): Promise<Record<string, unknown>> {
  const src = await readArollSources(dataDir);
  const report = await readReconcileReport(dataDir);
  const t = matchDeps().transcriber;
  const asr = t.notReady ? await t.notReady(dataDir).catch((e: unknown) => `检查失败：${e instanceof Error ? e.message : String(e)}`) : null;
  const folders = await Promise.all(src.folders.map(async (f) => {
    const scan = report?.watch?.find((w) => w.path === f.path);
    return { path: f.path, scan: f.scan, allow_move: f.allow_move, problem: await folderProblem(f), last: scan ?? null };
  }));
  return { ok: true, inbox: await inboxToCreate(dataDir), folders, paused: src.paused, asr: asr ? { ready: false, reason: asr } : { ready: true }, jianyingExportDir: src.jianyingExportDir };
}

export interface RevealSourceDeps { spawnImpl?: (cmd: string, args: string[], opts: Record<string, unknown>) => { unref?: () => void }; platform?: string }

/**
 * 「在访达中显示」（1b §4 列头、§5 设置页）：只认收件箱目录、收件箱顶层文件、已加的监视文件夹；别的路径一律拒。
 */
export async function revealSourcePath(target: string, dataDir: string, deps: RevealSourceDeps = {}): Promise<Record<string, unknown>> {
  if (typeof target !== "string" || !path.isAbsolute(target)) return { ok: false, code: "bad_request", error: "要完整路径" };
  const real = await fs.realpath(target).catch(() => null);
  if (!real) return { ok: false, code: "file_missing", error: "文件不在了（可能已经挪走），刷新再看" };
  const inbox = (await movableRoots(dataDir)).inbox;
  const folders = (await readArollSources(dataDir)).folders.map((f) => f.path);
  const isDir = real === inbox || folders.includes(real);
  const inInbox = Boolean(inbox) && path.dirname(real) === inbox;
  if (!isDir && !inInbox) return { ok: false, code: "not_allowed", error: "只能显示收件箱和监视文件夹里的东西" };
  if ((deps.platform ?? process.platform) !== "darwin") return { ok: true, path: real, opened: false };
  try {
    const child = (deps.spawnImpl ?? spawn)("open", isDir ? [real] : ["-R", real], { detached: true, stdio: "ignore" });
    child.unref?.();
    return { ok: true, path: real, opened: true };
  } catch (e) {
    return { ok: false, code: "open_failed", error: `访达没打开：${e instanceof Error ? e.message : String(e)}` };
  }
}
