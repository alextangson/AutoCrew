/**
 * 归档腾空间后，视图怎么找项目里的文件（spec 2026-09-29 B6）。
 * 选定做法：封面和登记字幕在删本机素材前复制一份到项目 00-project/kept/<原相对路径>（小文件，不是硬链接），
 * 视图找不到原件就读这份；成片、原片不留副本，按 relocations.json 写成「在 NAS」说明文件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isMissing } from "./content-project.js";

export const KEPT_DIR = "00-project/kept";
const RELOCATIONS = "00-project/autocrew/relocations.json";

export type Located = { where: "local"; path: string } | { where: "nas"; path: string } | null;

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function readRelocations(root: string): Promise<Record<string, string>> {
  try { return JSON.parse(await fs.readFile(path.join(root, RELOCATIONS), "utf8")) as Record<string, string>; }
  catch (e) { if (isMissing(e)) return {}; throw e; }
}

/**
 * 本机原件 → 本机留底副本 → 已搬到 NAS 的路径 → 找不到。
 * 稿件记录里的项目路径读出来时已按 relocations 换成了 NAS 路径，这里先换回项目相对路径再找，免得视图链到 NAS 上。
 */
export async function locateProjectFile(root: string, file: string): Promise<Located> {
  const relocations = await readRelocations(root);
  const back = Object.entries(relocations).find(([, nas]) => nas === file)?.[0];
  const rel = back ? back.replace(/^@project\//, "") : path.relative(root, file).split(path.sep).join("/");
  const inProject = !rel.startsWith("../") && !path.isAbsolute(rel);
  if (!inProject) return (await exists(file)) ? { where: "local", path: file } : null;
  const local = path.join(root, rel), kept = path.join(root, KEPT_DIR, rel);
  if (await exists(local)) return { where: "local", path: local };
  if (await exists(kept)) return { where: "local", path: kept };
  const nas = relocations[`@project/${rel}`];
  return nas ? { where: "nas", path: nas } : null;
}
