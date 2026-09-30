/**
 * 隐式 ChatCut 引用守卫（原 spec §13-A「被 ChatCut 引用的原片不挪」）：旧的 ChatCut 工程按**绝对路径**引用素材
 * （`<projects>/<id>/project.chatcutproject/assets/video/*.json` 的 `path`），不一定有 `chatcut_project.uses_aroll` 事实。
 * 把库外原片挪进项目之前先查一遍：有工程在用 → 原地收（in_place），依据写出是哪个工程。
 *
 * 读不了 ChatCut 目录不挡搬运（没装 ChatCut 很正常）：回一句要写进依据的提示，退回只按显式引用判断——唯一允许的降级。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { chatcutProjectsRoot } from "./sliver/chatcut-read.js";

export interface ChatcutHold { project: string | null; note: string }

const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>; } catch { return null; }
}

async function samePath(a: string, file: string, real: string): Promise<boolean> {
  if (path.resolve(a) === file || path.resolve(a) === real) return true;
  return (await fs.realpath(a).catch(() => null)) === real;
}

/** 这个文件是不是被本机某个 ChatCut 工程引用着 */
export async function chatcutHold(file: string): Promise<ChatcutHold> {
  const root = chatcutProjectsRoot();
  const real = await fs.realpath(file).catch(() => file);
  let ids: string[];
  try { ids = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch (e) {
    return code(e) === "ENOENT" ? { project: null, note: "" } : { project: null, note: `（没读到 ChatCut 工程目录：${code(e)}，只按显式引用判断在不在用）` };
  }
  let note = "";
  for (const id of ids) {
    const dir = path.join(root, id, "project.chatcutproject");
    let assets: string[];
    try { assets = (await fs.readdir(path.join(dir, "assets", "video"))).filter((n) => n.endsWith(".json")); }
    catch (e) { if (code(e) !== "ENOENT") note = `（没读到 ChatCut 工程目录：${code(e)}，只按显式引用判断在不在用）`; continue; }
    for (const name of assets) {
      const a = await readJson(path.join(dir, "assets", "video", name));
      if (typeof a?.path === "string" && (await samePath(a.path, file, real))) {
        const title = (await readJson(path.join(dir, "project.json")))?.name;
        return { project: typeof title === "string" && title ? title : id, note };
      }
    }
  }
  return { project: null, note };
}

export const inUseEvidence = (project: string) => `ChatCut 工程《${project}》在用这个文件，留在原处不挪`;
