/** 设置页「原片从哪里找」要看的东西（1b §5）：收件箱路径、监视文件夹与各自最近一次扫描、暂停、转写环境、剪映导出目录 */
import { matchDeps } from "./match/deps.js";
import { readReconcileReport } from "./reconcile.js";
import { inboxToCreate } from "./roots.js";
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
