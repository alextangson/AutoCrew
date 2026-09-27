import { readProjectRegistry } from "../../../storage/content-project.js";
/**
 * 剪辑项目根目录白名单（P6 spec §3.4）：`<dataDir>/video.json` 的 `project_roots`。
 *
 * 仅 ENOENT 可用约定默认根：受管资料库为工作区 projects；未迁移的本机旧模式才用 broll。每个根展开 `~` 后
 * `realpath`——之后所有路径比较都在真实路径上按段比，别名、`..`、大小写之外的花样都绕不过去。
 * 不存在的根照实报出来（交接时一个可用根都没有就拒绝），不静默跳过。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfigDir, resolveDataDir } from "../../../storage/storage-roots.js";
import { handoffFail, type HandoffResult } from "./types.js";

export const DEFAULT_PROJECT_ROOTS = ["~/Projects/broll"];

export interface ProjectRoots {
  /** realpath 之后可用的根，顺序同配置（交接缺省落在第一个） */
  roots: string[];
  /** 配置了但不存在 / 读不了的根（原样，便于人话报错） */
  missing: string[];
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function configuredRoots(dataDir: string): Promise<string[]> {
  const file = path.join(getConfigDir(dataDir), "video.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readProjectRegistry(dataDir) || getConfigDir(dataDir) !== resolveDataDir(dataDir)
      ? [path.join(resolveDataDir(dataDir), "projects")]
      : DEFAULT_PROJECT_ROOTS;
  }
  // 配置写坏了要响：静默回落默认根会把项目建到用户没想到的地方
  const parsed = JSON.parse(raw) as { project_roots?: unknown };
  if (!Array.isArray(parsed.project_roots)) throw new Error(`${file} 缺 project_roots 数组`);
  if (readProjectRegistry(dataDir)) {
    const managed = path.join(resolveDataDir(dataDir), "projects");
    if (parsed.project_roots.length !== 1 || path.resolve(expandHome(String(parsed.project_roots[0]))) !== path.resolve(managed)) throw new Error("共享项目必须使用资料库的 projects 根目录；请更新本机 video.json");
  }
  return parsed.project_roots.filter((r): r is string => typeof r === "string" && r.trim() !== "");
}

export async function loadProjectRoots(dataDir: string): Promise<ProjectRoots> {
  const out: ProjectRoots = { roots: [], missing: [] };
  for (const configured of await configuredRoots(dataDir)) {
    try {
      const real = await fs.realpath(expandHome(configured.trim()));
      if ((await fs.stat(real)).isDirectory() && !out.roots.includes(real)) out.roots.push(real);
      else if (!out.roots.includes(real)) out.missing.push(configured);
    } catch {
      out.missing.push(configured);
    }
  }
  return out;
}

/** 交接/登记用：一个可用根都没有就拒绝，并把配置了却不存在的根报出来 */
export async function usableRoots(
  dataDir: string,
): Promise<{ ok: true; value: ProjectRoots } | { ok: false; result: HandoffResult }> {
  let roots: ProjectRoots;
  try {
    roots = await loadProjectRoots(dataDir);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, result: handoffFail("roots_unavailable", `剪辑根目录配置读不了（video.json）：${why}`) };
  }
  if (roots.roots.length > 0) return { ok: true, value: roots };
  return {
    ok: false,
    result: handoffFail("roots_unavailable",
      `没有可用的剪辑根目录：配置的 ${roots.missing.join("、") || "（空）"} 都不存在。` +
      `在 ${path.join(getConfigDir(dataDir), "video.json")} 的 project_roots 里写一个存在的目录`,
      { missing: roots.missing }),
  };
}
