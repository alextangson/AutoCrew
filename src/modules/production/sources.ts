/**
 * 「原片从哪里找」（1b §5）：监视文件夹、两个开关、暂停自动找原片、剪映导出目录。
 *
 * - 只有同源浏览器会话能改（board-route），`video:settings_set` / MCP / bearer 一律拒（§14-7）：这些是「可搬入根」，服务端凭据。
 * - 路径（§14-8）：存 realpath + 目录身份；必须存在、是目录、本身不是符号链接；与资料库相交（在库内或是库的祖先）即拒。
 * - 使用时复核身份与「不是链接」：变了 → 该文件夹这轮停用并提示，不猜。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getVideoSettingsRaw, jianyingDirError, mutateVideoSettings, type WatchFolder } from "../../desktop/settings-video.js";
import { isWithin, readLibraryLocation } from "../../storage/storage-roots.js";
import { expandHome } from "../video/handoff/roots.js";

export type { WatchFolder } from "../../desktop/settings-video.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });

/** 新加一个监视文件夹：返回存盘形状或拒绝原因 */
export async function validateWatchFolder(input: string, libraryRoot: string | null): Promise<{ ok: true; folder: Omit<WatchFolder, "scan" | "allow_move"> } | { ok: false; error: string }> {
  const raw = expandHome(input.trim());
  if (!path.isAbsolute(raw)) return { ok: false, error: `要完整路径：${input}` };
  const st = await fs.lstat(raw).catch(() => null);
  if (!st) return { ok: false, error: `文件夹不存在：${raw}` };
  if (st.isSymbolicLink()) return { ok: false, error: `这是符号链接，不收（选它指向的真实文件夹）：${raw}` };
  if (!st.isDirectory()) return { ok: false, error: `不是文件夹：${raw}` };
  const real = await fs.realpath(raw);
  const lib = libraryRoot ? await fs.realpath(libraryRoot).catch(() => libraryRoot) : null;
  if (lib && (isWithin(lib, real) || isWithin(real, lib))) return { ok: false, error: `这个文件夹和资料库重叠（${lib}），不能当监视文件夹` };
  const id = await fs.stat(real);
  return { ok: true, folder: { path: real, dev: id.dev, ino: id.ino } };
}

/** 使用时复核：还在、不是链接、还是当初那个目录（dev/ino） */
export async function folderProblem(f: WatchFolder): Promise<string | null> {
  const st = await fs.lstat(f.path).catch((e: NodeJS.ErrnoException) => e);
  if (st instanceof Error) return st.code === "ENOENT" ? "文件夹不在了" : `读不了（${st.code ?? st.message}）`;
  if (st.isSymbolicLink() || !st.isDirectory()) return "文件夹被换成了链接或文件，这轮停用";
  if (st.dev !== f.dev || st.ino !== f.ino) return "文件夹被换过（不是当初加的那个），这轮停用；删掉重新加";
  return null;
}

export interface ArollSources { folders: WatchFolder[]; paused: boolean; jianyingExportDir: string | null }

export async function readArollSources(dataDir: string): Promise<ArollSources> {
  const v = await getVideoSettingsRaw(dataDir);
  return { folders: v.arollWatchFolders ?? [], paused: v.arollAutoFindPaused === true, jianyingExportDir: v.jianyingExportDir ?? null };
}

/** allow_move 且复核通过的监视文件夹（agent record 的可搬入根，只认顶层文件） */
export async function movableWatchFolders(dataDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of (await readArollSources(dataDir).catch(() => ({ folders: [] as WatchFolder[] }))).folders) {
    if (f.allow_move && !(await folderProblem(f))) out.push(f.path);
  }
  return out;
}

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

async function addFolder(b: Record<string, unknown>, dataDir: string): Promise<Result> {
  const v = await validateWatchFolder(String(b.path ?? ""), readLibraryLocation()?.root ?? null);
  if (!v.ok) return fail("bad_folder", v.error);
  const r = await mutateVideoSettings(dataDir, (next) => {
    const list = next.arollWatchFolders ?? [];
    if (list.some((f) => f.path === v.folder.path)) return `已经加过：${v.folder.path}`;
    next.arollWatchFolders = [...list, { ...v.folder, scan: bool(b.scan) ?? true, allow_move: bool(b.allow_move) ?? false }];
    return null;
  });
  return r.ok ? { ok: true } : fail("bad_folder", r.error);
}

async function setFolder(b: Record<string, unknown>, dataDir: string, remove: boolean): Promise<Result> {
  const target = String(b.path ?? "");
  const r = await mutateVideoSettings(dataDir, (next) => {
    const list = next.arollWatchFolders ?? [];
    const hit = list.find((f) => f.path === target);
    if (!hit) return `没有这个监视文件夹：${target}`;
    if (remove) next.arollWatchFolders = list.filter((f) => f !== hit);
    else Object.assign(hit, { ...(bool(b.scan) !== undefined ? { scan: b.scan } : {}), ...(bool(b.allow_move) !== undefined ? { allow_move: b.allow_move } : {}) });
    if (!next.arollWatchFolders?.length) delete next.arollWatchFolders;
    return null;
  });
  return r.ok ? { ok: true } : fail("bad_folder", r.error);
}

async function setJianying(b: Record<string, unknown>, dataDir: string): Promise<Result> {
  const v = b.path;
  const r = await mutateVideoSettings(dataDir, async (next) => {
    if (v === null || v === "") { delete next.jianyingExportDir; return null; }
    const bad = await jianyingDirError(v);
    if (bad) return bad;
    next.jianyingExportDir = String(v).trim();
    return null;
  });
  return r.ok ? { ok: true } : fail("bad_folder", r.error);
}

/** 浏览器会话路由的唯一写口。调用方（board-route）已核过「同源浏览器会话」 */
export async function applyArollSourceOp(op: string, b: Record<string, unknown>, dataDir: string): Promise<Result> {
  if (op === "add_folder") return addFolder(b, dataDir);
  if (op === "remove_folder") return setFolder(b, dataDir, true);
  if (op === "set_folder") return setFolder(b, dataDir, false);
  if (op === "set_jianying") return setJianying(b, dataDir);
  if (op === "set_paused") {
    if (typeof b.paused !== "boolean") return fail("bad_request", "paused 要是布尔值");
    const r = await mutateVideoSettings(dataDir, (next) => { if (b.paused) next.arollAutoFindPaused = true; else delete next.arollAutoFindPaused; return null; });
    return r.ok ? { ok: true } : fail("bad_request", r.error);
  }
  return fail("bad_request", `不认识的操作：${op}`);
}
