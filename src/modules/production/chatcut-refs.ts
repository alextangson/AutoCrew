/**
 * 隐式 ChatCut 引用守卫（原 spec §13-A「被 ChatCut 引用的原片不挪」）：旧的 ChatCut 工程按**绝对路径**引用素材
 * （`<projects>/<id>/project.chatcutproject/assets/video/*.json` 的 `path`），不一定有 `chatcut_project.uses_aroll` 事实。
 * 把库外原片挪进项目之前先查一遍：有工程在用 → 原地收（in_place），依据写出是哪个工程。
 *
 * 核不了就不挪（Codex 审 segB18 P2）：工程目录、某个工程的素材目录、某个素材 JSON 读不了 / 解析不了（写了一半），
 * 都算「没法确认」——不能当成「没引用」。只有工程目录根本不存在（没装 ChatCut）才等于没引用。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { chatcutProjectsRoot } from "./sliver/chatcut-read.js";

/** project：在用它的工程名；unverified：没法确认（给人看的原因），调用方据此不挪 */
export interface ChatcutHold { project: string | null; unverified: string | null }

const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));

type Json = Record<string, unknown>;
async function readJson(file: string): Promise<{ ok: true; value: Json } | { ok: false; why: string }> {
  try { return { ok: true, value: JSON.parse(await fs.readFile(file, "utf8")) as Json }; }
  catch (e) { return { ok: false, why: e instanceof SyntaxError ? "素材信息写了一半" : code(e) }; }
}

async function samePath(a: string, file: string, real: string): Promise<boolean> {
  if (path.resolve(a) === file || path.resolve(a) === real) return true;
  return (await fs.realpath(a).catch(() => null)) === real;
}

export const unverifiedText = (why: string) => `没读到 ChatCut 工程信息（${why}），先不挪，稍后再试`;

async function projectHit(dir: string, file: string, real: string): Promise<{ hit: boolean; why: string | null }> {
  let assets: string[];
  try { assets = (await fs.readdir(path.join(dir, "assets", "video"))).filter((n) => n.endsWith(".json")); }
  catch (e) { return { hit: false, why: code(e) === "ENOENT" ? null : code(e) }; }
  let why: string | null = null;
  for (const name of assets) {
    const a = await readJson(path.join(dir, "assets", "video", name));
    if (!a.ok) { why = a.why; continue; }
    if (typeof a.value.path === "string" && (await samePath(a.value.path, file, real))) return { hit: true, why: null };
  }
  return { hit: false, why };
}

/** 这个文件是不是被本机某个 ChatCut 工程引用着；核不了就回 unverified */
export async function chatcutHold(file: string): Promise<ChatcutHold> {
  const root = chatcutProjectsRoot();
  const real = await fs.realpath(file).catch(() => file);
  let ids: string[];
  try { ids = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch (e) { return code(e) === "ENOENT" ? { project: null, unverified: null } : { project: null, unverified: unverifiedText(code(e)) }; }
  let why: string | null = null;
  for (const id of ids) {
    const dir = path.join(root, id, "project.chatcutproject");
    const r = await projectHit(dir, file, real);
    if (r.hit) {
      const meta = await readJson(path.join(dir, "project.json"));
      const title = meta.ok ? meta.value.name : undefined;
      return { project: typeof title === "string" && title ? title : id, unverified: null };
    }
    why ??= r.why;
  }
  return { project: null, unverified: why ? unverifiedText(why) : null };
}

export const inUseEvidence = (project: string) => `ChatCut 工程《${project}》在用这个文件，留在原处不挪`;
