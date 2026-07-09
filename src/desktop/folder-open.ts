/**
 * 打开稿件文件夹(V5.6.1 人机协同):darwin 用 Finder 打开,其他平台返回路径。
 * 文件夹本就自描述——draft.md(每次存稿常新)+ 封面.png(选定副本)+
 * assets/(候选与素材)+ versions/(版本历史)。spawn 可注入,测试不真开窗。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { getDataDir } from "../storage/local-store.js";

const CONTENT_ID_RE = /^content-\d+-[a-z0-9]+$/;

export interface OpenFolderResult {
  ok: boolean;
  path?: string;
  /** true = 已在 Finder 打开;false = 仅返回路径(非 darwin 或 spawn 失败) */
  opened?: boolean;
  error?: string;
}

export async function openContentFolder(
  id: string,
  dataDir?: string,
  deps?: { spawnImpl?: typeof spawn; platform?: NodeJS.Platform },
): Promise<OpenFolderResult> {
  if (!CONTENT_ID_RE.test(id)) return { ok: false, error: "非法稿件 id" };
  const projDir = path.join(getDataDir(dataDir), "contents", id);
  try {
    await fs.access(path.join(projDir, "meta.json"));
  } catch {
    return { ok: false, error: "稿件不存在" };
  }
  const platform = deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: true, path: projDir, opened: false };
  }
  const spawnImpl = deps?.spawnImpl ?? spawn;
  try {
    const child = spawnImpl("open", [projDir], { detached: true, stdio: "ignore" });
    child.unref?.();
    return { ok: true, path: projDir, opened: true };
  } catch (err) {
    return { ok: true, path: projDir, opened: false, error: err instanceof Error ? err.message : String(err) };
  }
}
