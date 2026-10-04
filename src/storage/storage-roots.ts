/** Program files, portable libraries and machine state have separate roots.
 * No configured library ever falls back to an empty local directory.
 */
import path from "node:path";
import os from "node:os";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { assertLibraryWriter } from "./library-lock.js";

export const LIBRARY_MARKER = "autocrew-library.json";
export const STORAGE_CONFIG = "storage.json";
export interface LibraryLocation { version: 1; id: string; root: string }
export interface LibraryManifest { version: 1; id: string; createdAt: string }

export function getMachineDir(customDir?: string): string {
  return path.resolve(customDir || process.env.AUTOCREW_LOCAL_DIR || process.env.AUTOCREW_DATA_DIR ||
    path.join(process.env.HOME || os.homedir(), ".autocrew"));
}

export function readLibraryLocation(): LibraryLocation | null {
  let raw: string;
  try { raw = readFileSync(path.join(getMachineDir(), STORAGE_CONFIG), "utf8"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  const value = JSON.parse(raw) as LibraryLocation;
  if (value.version !== 1 || !/^lib-[a-f0-9-]+$/.test(value.id) || !path.isAbsolute(value.root)) {
    throw new Error("资料库位置配置损坏，请修复本机 storage.json；不会切换到其他目录。");
  }
  return value;
}

export function assertLibraryAvailable(location = readLibraryLocation()): void {
  if (!location) return;
  try {
    const marker = JSON.parse(readFileSync(path.join(location.root, LIBRARY_MARKER), "utf8")) as LibraryManifest;
    if (marker.version !== 1 || !/^lib-[a-f0-9-]+$/.test(marker.id) || marker.id !== location.id) throw new Error("资料库身份不匹配");
    accessSync(location.root, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`资料库未连接、只读或身份不匹配：${location.root}。请重新连接原资料库；不会自动新建或切换。`);
  }
}

export function getHostStateDir(customDir?: string): string {
  const location = readLibraryLocation();
  return customDir && !(location && isWithin(location.root, path.resolve(customDir)))
    ? getMachineDir(customDir) : getMachineDir();
}

export function getLibraryRoot(): string {
  const location = readLibraryLocation();
  assertLibraryAvailable(location);
  return location?.root ?? getMachineDir();
}

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** Explicit unrelated directories remain isolated (fixtures and external adapters). */
export function resolveDataDir(customDir?: string): string {
  const location = readLibraryLocation();
  if (customDir) {
    if (location && isWithin(location.root, path.resolve(customDir))) assertLibraryAvailable(location);
    return customDir;
  }
  assertLibraryAvailable(location);
  return location ? path.join(location.root, "workspaces", "default") : getMachineDir();
}

/** Credentials are scoped by stable library and workspace IDs, never by mount path. */
export function getConfigDir(customDir?: string): string {
  const location = readLibraryLocation();
  const data = customDir ? path.resolve(customDir) : resolveDataDir();
  if (!location || !isWithin(path.join(location.root, "workspaces"), data)) return data;
  const workspace = path.relative(path.join(location.root, "workspaces"), data);
  if (!/^(default|ws-[a-z0-9]+)$/.test(workspace)) throw new Error("无效的运营工作区路径");
  return path.join(getMachineDir(), "libraries", location.id, "workspaces", workspace);
}

/** Symlinks in parent mount paths are resolved before comparing destinations. */
export function canonicalTarget(input: string): string {
  if (!path.isAbsolute(input)) throw new Error("请选择完整的绝对路径");
  const root = path.resolve(input);
  try { return realpathSync(root); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return path.join(realpathSync(path.dirname(root)), path.basename(root));
  }
}

export function assertManagedPathAvailable(filePath: string): void {
  const location = readLibraryLocation();
  if (location && isWithin(location.root, path.resolve(filePath))) {
    assertLibraryAvailable(location);
    assertLibraryWriter(location.root);
  }
}

/** Multi-file writers pre-check the whole data dir before their first write, so a refusal leaves nothing partial. */
export function assertDataDirWritable(dataDir?: string): void {
  assertManagedPathAvailable(resolveDataDir(dataDir));
}

/** Rebuildable search indexes/proxies live on this machine, never in the library.
 * Without a library an explicit directory keeps its own cache, like every other root here. */
export function getWorkspaceCacheDir(customDir?: string): string {
  return path.join(getConfigDir(customDir), "cache");
}
