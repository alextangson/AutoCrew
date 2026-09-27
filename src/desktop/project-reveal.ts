/**
 * 剪辑看板「在访达中显示」：只认本条稿自己的东西——执行索引里的产物（按 sha256）或几个固定位置，
 * 浏览器永远传不进原始路径。项目内文件照登记规则校验（不许符号链接、不许出项目）；
 * 项目外只有已报到的剪映导出成片候选（resolveReportedFile 同一套规则）。
 * darwin：文件 `open -R`，文件夹 `open`；其他平台只回路径。spawn 可注入，测试不真开窗。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { getContent } from "../storage/local-store.js";
import { resolveContentProject } from "../storage/content-project.js";
import { resolveProjectFile } from "../modules/video/handoff/paths.js";
import { resolveReportedFile } from "../modules/video/handoff/jianying-root.js";
import { executionWithCovers } from "../modules/video/handoff/founder-review.js";

export const REVEAL_DIRS = { project_root: "", covers_dir: "05-cover", delivery_dir: "07-delivery" } as const;
const MISSING = "文件找不到了（可能已挪走）";

export type RevealResult =
  | { ok: true; path: string; opened: boolean }
  | { ok: false; code: "bad_request" | "not_allowed" | "file_missing" | "open_failed"; error: string; path?: string };
type Located = { ok: true; path: string; dir: boolean } | Extract<RevealResult, { ok: false }>;

export interface RevealDeps { spawnImpl?: typeof spawn; platform?: NodeJS.Platform }

async function locateDir(root: string, sub: string): Promise<Located> {
  const dir = sub ? path.join(root, sub) : root;
  const st = await fs.lstat(dir).catch(() => null);
  if (!st || !st.isDirectory()) return { ok: false, code: "file_missing", error: MISSING, path: dir };
  return { ok: true, path: dir, dir: true };
}

async function locate(id: string, target: string, dataDir: string): Promise<Located> {
  const content = await getContent(id, dataDir);
  const binding = resolveContentProject(id, dataDir);
  const root = binding?.project_root ?? content?.video?.handoff?.project_root;
  if (!content || !root) return { ok: false, code: "not_allowed", error: "这条稿还没有项目文件夹" };
  if (Object.hasOwn(REVEAL_DIRS, target)) return locateDir(root, REVEAL_DIRS[target as keyof typeof REVEAL_DIRS]);
  let checked;
  if (target === "aroll") {
    const aroll = content.video?.handoff?.aroll_path;
    if (!aroll) return { ok: false, code: "file_missing", error: "还没有交接原片" };
    checked = await resolveProjectFile(aroll, root, "原片");
  } else if (/^[0-9a-f]{64}$/.test(target)) {
    const execution = await executionWithCovers(content, dataDir, content.video?.handoff?.generation ?? 1);
    const entry = execution?.artifacts.find((a) => a.sha256 === target);
    if (!entry) return { ok: false, code: "not_allowed", error: "这件产物不属于这条稿" };
    const at = await resolveReportedFile(entry.path, root, entry.role, dataDir);
    checked = at.ok ? { ok: true as const, value: at.value.file } : at;
  } else return { ok: false, code: "bad_request", error: "不认识的位置" };
  if (checked.ok) return { ok: true, path: checked.value, dir: false };
  const code = (checked.result as { code?: string }).code;
  return code === "path_missing" ? { ok: false, code: "file_missing", error: MISSING } : { ok: false, code: "not_allowed", error: "这个文件不在本条稿的项目里" };
}

export async function revealProjectPath(id: string, target: string, dataDir: string, deps: RevealDeps = {}): Promise<RevealResult> {
  if (!/^content-\d+-[a-z0-9]+$/.test(id) || typeof target !== "string") return { ok: false, code: "bad_request", error: "参数不对" };
  const at = await locate(id, target, dataDir);
  if (!at.ok) return at;
  if ((deps.platform ?? process.platform) !== "darwin") return { ok: true, path: at.path, opened: false };
  try {
    const child = (deps.spawnImpl ?? spawn)("open", at.dir ? [at.path] : ["-R", at.path], { detached: true, stdio: "ignore" });
    child.unref?.();
    return { ok: true, path: at.path, opened: true };
  } catch (e) {
    return { ok: false, code: "open_failed", error: `访达没打开：${e instanceof Error ? e.message : String(e)}`, path: at.path };
  }
}
