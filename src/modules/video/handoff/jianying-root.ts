/**
 * 成片候选的项目外根（P6 §13.4-F 成片第 2 步，评审 #4）。
 *
 * 创始人在剪映里审完导出，文件落在剪映自己的导出目录；Codex 用 `report` 报它，角色必须是
 * `final-cut-candidate`。这是**唯一**允许在项目外的产物，根也只有一个：设置里登记的剪映导出目录。
 * 没设就拒绝并说去哪里设——不猜缺省值（剪映的默认导出位置各机器不同，猜错等于放行任意目录）。
 * 规则和项目内文件同一套（paths.resolveFileUnder）：规范化、realpath 比段、根之下逐段禁符号链接。
 * 不放宽 resolveProjectFile 的通用边界。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getVideoSettingsRaw } from "../../../desktop/settings-video.js";
import { resolveFileUnder, resolveProjectFile, type PathCheck } from "./paths.js";
import { expandHome } from "./roots.js";
import { handoffFail } from "./types.js";

export const FINAL_CUT_CANDIDATE = "final-cut-candidate";
export const SET_EXPORT_DIR_HINT = "在 AutoCrew「设置 → 模型 → 剪映导出目录」里填剪映的导出位置（剪映 → 全局设置 → 导出路径）";

export type ReportedLocation = { file: string; external: boolean };

/** 剪映导出目录（realpath 过）；没设 / 不存在都回可读的拒绝 */
export async function jianyingExportRoot(dataDir: string): Promise<PathCheck<string>> {
  const configured = (await getVideoSettingsRaw(dataDir)).jianyingExportDir;
  if (!configured) {
    return { ok: false, result: handoffFail("jianying_dir_unset", `成片候选在项目外，但还没设置剪映导出目录：${SET_EXPORT_DIR_HINT}，再重新 report`) };
  }
  try {
    const real = await fs.realpath(expandHome(configured));
    if ((await fs.stat(real)).isDirectory()) return { ok: true, value: real };
  } catch { /* 落到下面的拒绝 */ }
  return { ok: false, result: handoffFail("roots_unavailable", `设置里的剪映导出目录不存在：${configured}。${SET_EXPORT_DIR_HINT}`) };
}

/**
 * report / 批准共用：项目内文件照旧；项目外只有成片候选、只在剪映导出目录下才收。
 * 返回真实路径和它是不是项目外文件。
 */
export async function resolveReportedFile(file: string, projectRoot: string, role: string, dataDir: string): Promise<PathCheck<ReportedLocation>> {
  const abs = path.isAbsolute(file) || file.startsWith("~") ? file : path.join(projectRoot, file);
  const inside = await resolveProjectFile(abs, projectRoot, role);
  if (inside.ok) return { ok: true, value: { file: inside.value, external: false } };
  if (role !== FINAL_CUT_CANDIDATE || inside.result.code !== "path_not_whitelisted") return inside;
  const root = await jianyingExportRoot(dataDir);
  if (!root.ok) return root;
  const outside = await resolveFileUnder(abs, root.value, role, (expanded) => handoffFail("path_not_whitelisted",
    `${role} 只能在当前项目或剪映导出目录（${root.value}）里：${expanded}`, { which: role }));
  return outside.ok ? { ok: true, value: { file: outside.value, external: true } } : outside;
}
