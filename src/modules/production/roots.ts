/**
 * 「可扫描」与「可搬入」分开（spec §3-5，Codex P1-7）。本段只有三类可搬入根：
 * - 原片收件箱「我的内容/0 原片放这里/」：自家目录，默认可搬（任何 kind）；
 * - ChatCut 导出目录、剪映导出目录：只搬 cut / srt / cover。
 * - 开了「允许 agent 直接搬入」的监视文件夹（1b §5）：只搬 A-roll、只认顶层文件；没开的按「其他路径」只记候选。
 *
 * 测试一律用 `setProductionDeps` 注入根与探针，不碰真实 ~/Movies 与资料库。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getVideoSettingsRaw } from "../../desktop/settings-video.js";
import { isWithin, readLibraryLocation, resolveDataDir } from "../../storage/storage-roots.js";
import { CHATCUT_EXPORT_DIR } from "../video/unregistered-cut.js";
import { ffprobeDuration, type Probe } from "./files.js";
import { movableWatchFolders } from "./sources.js";

export const INBOX_DIR = "0 原片放这里";
/** 「我的内容」视图目录名（与 my-content-view.VIEW_DIR 同值；那边会 import 本模块链，这里不反向引） */
const VIEW_DIR = "我的内容";

/** watch：开了「允许 agent 直接搬入」、复核通过的监视文件夹（1b §5；只认顶层文件，只收 A-roll） */
export interface MovableRoots { inbox: string | null; chatcut: string | null; jianying: string | null; watch?: string[] }

export interface ProductionDeps {
  roots?: (dataDir: string) => Promise<MovableRoots>;
  probe?: Probe;
  now?: () => number;
}

let deps: ProductionDeps = {};

export function setProductionDeps(patch: ProductionDeps | null): void {
  deps = patch ? { ...deps, ...patch } : {};
}

export const probe: Probe = (file) => (deps.probe ?? ffprobeDuration)(file);
export const now = (): number => (deps.now ?? Date.now)();

/** 收件箱只属于资料库里的工作区（旧版 ~/.autocrew 没有「我的内容」） */
export function inboxDir(dataDir: string): string | null {
  const location = readLibraryLocation();
  if (!location || !isWithin(location.root, path.resolve(resolveDataDir(dataDir)))) return null;
  return path.join(location.root, VIEW_DIR, INBOX_DIR);
}

async function real(dir: string | null | undefined): Promise<string | null> {
  if (!dir) return null;
  return fs.realpath(dir).catch(() => null);
}

async function defaultRoots(dataDir: string): Promise<MovableRoots> {
  const jianying = (await getVideoSettingsRaw(dataDir).catch(() => ({}) as { jianyingExportDir?: string })).jianyingExportDir ?? null;
  return { inbox: inboxDir(dataDir), chatcut: CHATCUT_EXPORT_DIR, jianying, watch: await movableWatchFolders(dataDir) };
}

/** 原片收件箱的应有位置（不管在不在）：启用时建出来 */
export async function inboxToCreate(dataDir: string): Promise<string | null> {
  return (await (deps.roots ?? defaultRoots)(dataDir)).inbox;
}

/** 可搬入根（realpath 之后；不存在的根当没有） */
export async function movableRoots(dataDir: string): Promise<MovableRoots> {
  const raw = await (deps.roots ?? defaultRoots)(dataDir);
  const watch = (await Promise.all((raw.watch ?? []).map(real))).filter((d): d is string => Boolean(d));
  return { inbox: await real(raw.inbox), chatcut: await real(raw.chatcut), jianying: await real(raw.jianying), watch };
}

export type Location = "project" | "inbox" | "export" | "watch" | "other";

export function classify(file: string, projectRoot: string, roots: MovableRoots): Location {
  if (isWithin(projectRoot, file)) return "project";
  if (roots.inbox && isWithin(roots.inbox, file)) return "inbox";
  if ((roots.watch ?? []).includes(path.dirname(file))) return "watch";
  if ((roots.chatcut && isWithin(roots.chatcut, file)) || (roots.jianying && isWithin(roots.jianying, file))) return "export";
  return "other";
}
