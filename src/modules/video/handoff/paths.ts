/**
 * 路径门（P6 spec §3.4 / §8 最坏输入；codex 评审 #8）。
 *
 * 四条硬规则，交接与登记共用：
 * 1. 项目目录必须是白名单根的**直接子目录**——realpath 之后按路径段比，不比字符串前缀
 *    （`~/Projects/broll-evil` 以 `~/Projects/broll` 开头，但不是它的子目录）。
 * 2. 项目目录本身、以及登记文件在项目目录**之下**的每一段，都不许是符号链接
 *    （`~/Projects/broll/x → /etc` 这种）。项目目录**之上**的别名（macOS 的 /var → /private/var、
 *    被链接过的家目录）不算：它们落到的仍是白名单里那个真实根。
 * 3. 项目目录里 `.autocrew-owner` 记着归属的 content；别的稿件的项目不复用、不覆盖。
 * 4. 登记的文件必须真的在当前交接的项目目录里（`~/Downloads/x.mp4` 一律拒）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expandHome, type ProjectRoots } from "./roots.js";
import { handoffFail, type HandoffResult } from "./types.js";

export const OWNER_FILE = ".autocrew-owner";
export const SCRIPT_DIR = "01-script";
const MAX_NAME_CHARS = 40;

export type PathCheck<T> = { ok: true; value: T } | { ok: false; result: HandoffResult };

function fail<T>(result: HandoffResult): PathCheck<T> {
  return { ok: false, result };
}

async function lstatOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 缺省项目名 `YYYYMMDD <标题>`：去路径非法字符与控制字符、去开头的点，≤40 字 */
export function defaultProjectName(title: string, now: Date = new Date()): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  const clipped = Array.from(cleaned).slice(0, MAX_NAME_CHARS).join("").trim();
  return `${date} ${clipped || "未命名"}`;
}

/** 按段判「a 就是 b」：两边都已 realpath，relative 为空才算同一个目录 */
function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

/**
 * 交接用：把 `project_root` 落到某个白名单根的直接子目录上，返回规范化后的真实路径。
 * 目录可以还不存在（交接会建）；已存在就必须是真目录而不是链接。
 */
export async function resolveProjectRoot(input: string, roots: ProjectRoots): Promise<PathCheck<string>> {
  const expanded = path.resolve(expandHome(input.trim()));
  if ((await lstatOrNull(expanded))?.isSymbolicLink()) {
    return fail(handoffFail("path_symlink", `项目目录是符号链接：${expanded}——请给真实目录`));
  }
  const name = path.basename(expanded);
  const realParent = await realpathOrNull(path.dirname(expanded));
  const root = realParent ? roots.roots.find((r) => samePath(r, realParent)) : undefined;
  if (!root || !name || name === "." || name === "..") {
    return fail(handoffFail("path_not_whitelisted",
      `项目目录必须是白名单根目录的直接子目录（白名单：${roots.roots.join("、") || "空"}；见 video.json）：${expanded}`,
      { roots: roots.roots }));
  }
  const candidate = path.join(root, name);
  const st = await lstatOrNull(candidate);
  if (st?.isSymbolicLink()) return fail(handoffFail("path_symlink", `项目目录是符号链接：${candidate}`));
  if (st && !st.isDirectory()) return fail(handoffFail("path_not_whitelisted", `项目路径已存在但不是目录：${candidate}`));
  return { ok: true, value: candidate };
}

async function readOwner(ownerPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(ownerPath, "utf-8")) as { content_id?: unknown };
    return typeof parsed.content_id === "string" ? parsed.content_id : null;
  } catch {
    return null;
  }
}

function ownedByOther(projectRoot: string, owner: string | null): HandoffResult {
  return handoffFail("project_owned_by_other",
    owner
      ? `该项目目录属于另一条稿件（${owner}）：${projectRoot}——换一个 project_root，不复用不覆盖`
      : `该项目目录的归属文件 ${OWNER_FILE} 缺失或读不了：${projectRoot}`,
    { owner });
}

/** 登记用：只读核归属（缺归属文件也算不匹配——交接时一定写过） */
export async function checkProjectOwner(projectRoot: string, contentId: string): Promise<PathCheck<void>> {
  const ownerPath = path.join(projectRoot, OWNER_FILE);
  if ((await lstatOrNull(ownerPath))?.isSymbolicLink()) return fail(handoffFail("path_symlink", `归属文件是符号链接：${ownerPath}`));
  const owner = await readOwner(ownerPath);
  return owner === contentId ? { ok: true, value: undefined } : fail(ownedByOther(projectRoot, owner));
}

/**
 * 交接用：建 `01-script/`（只建这一个）并认领归属。归属文件用 `wx` 独占创建：
 * 两条稿件并发抢同一个目录，只有一条写得进去，另一条读到别人的 owner 被拒。
 */
export async function claimProjectDir(projectRoot: string, contentId: string): Promise<PathCheck<void>> {
  const scriptDir = path.join(projectRoot, SCRIPT_DIR);
  if ((await lstatOrNull(scriptDir))?.isSymbolicLink()) return fail(handoffFail("path_symlink", `${SCRIPT_DIR} 是符号链接：${scriptDir}`));
  const ownerPath = path.join(projectRoot, OWNER_FILE);
  if ((await lstatOrNull(ownerPath))?.isSymbolicLink()) return fail(handoffFail("path_symlink", `归属文件是符号链接：${ownerPath}`));
  // 先核归属再建目录：别人的项目里不许多出一个 01-script
  const existing = (await lstatOrNull(ownerPath)) ? await readOwner(ownerPath) : undefined;
  if (existing !== undefined && existing !== contentId) return fail(ownedByOther(projectRoot, existing));
  await fs.mkdir(scriptDir, { recursive: true });
  if (existing === contentId) return { ok: true, value: undefined };
  try {
    await fs.writeFile(ownerPath, `${JSON.stringify({ content_id: contentId })}\n`, { flag: "wx" });
    return { ok: true, value: undefined };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const owner = await readOwner(ownerPath);
    return owner === contentId ? { ok: true, value: undefined } : fail(ownedByOther(projectRoot, owner));
  }
}

/** 找到给定路径里「落到项目目录」的那一段前缀的长度；找不到 = 不在项目里 */
async function projectPrefixLength(segments: string[], projectRoot: string): Promise<number> {
  for (let i = segments.length - 1; i >= 1; i--) {
    const prefix = segments.slice(0, i).join(path.sep) || path.sep;
    const real = await realpathOrNull(prefix);
    if (real && samePath(real, projectRoot)) return i;
  }
  return 0;
}

/**
 * 登记用：文件必须在项目目录里，项目目录之下的每一段（含文件本身）都不许是符号链接。
 * 返回文件的真实绝对路径。
 */
export async function resolveProjectFile(file: string, projectRoot: string, label: string): Promise<PathCheck<string>> {
  const expanded = path.resolve(expandHome(file.trim()));
  const st = await lstatOrNull(expanded);
  if (!st) return fail(handoffFail("path_missing", `${label} 不存在或读不了：${expanded}`, { which: label }));
  const segments = expanded.split(path.sep);
  const at = await projectPrefixLength(segments, projectRoot);
  if (at === 0) {
    return fail(handoffFail("path_not_whitelisted",
      `${label} 必须在当前交接的项目目录里（${projectRoot}）：${expanded}`, { which: label }));
  }
  for (let i = at + 1; i <= segments.length; i++) {
    const seg = segments.slice(0, i).join(path.sep);
    if ((await lstatOrNull(seg))?.isSymbolicLink()) {
      return fail(handoffFail("path_symlink", `${label} 的路径里有符号链接：${seg}`, { which: label }));
    }
  }
  if (!st.isFile()) return fail(handoffFail("path_missing", `${label} 不是文件：${expanded}`, { which: label }));
  return { ok: true, value: path.join(projectRoot, ...segments.slice(at)) };
}

/** 登记时复核项目目录：仍是白名单根的直接子目录、不是链接、归属还是这条稿 */
export async function recheckProjectRoot(
  projectRoot: string,
  roots: ProjectRoots,
  contentId: string,
): Promise<PathCheck<void>> {
  const resolved = await resolveProjectRoot(projectRoot, roots);
  if (!resolved.ok) return resolved;
  if (!(await lstatOrNull(resolved.value))?.isDirectory()) {
    return fail(handoffFail("path_missing", `交接时的项目目录不见了：${projectRoot}`));
  }
  return checkProjectOwner(resolved.value, contentId);
}
