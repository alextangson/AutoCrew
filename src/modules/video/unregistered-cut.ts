/**
 * 剪完未登记提醒（spec 2026-09-29-unregistered-cut-reminder）。
 *
 * 直派/场外剪的视频导出了、封面也做了，却从没 handoff / register，看板一直停在已过审。
 * 这里只负责「看见」：三种信号任一命中就算剪完未登记。不交接、不登记、不改状态。
 * SessionStart hook 每次都跑，所以每个目录只 readdir 一次、不递归、不读文件内容。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getVideoSettingsRaw } from "../../desktop/settings-video.js";
import { resolveContentProject } from "../../storage/content-project.js";
import type { Content } from "../../storage/local-store.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";

/** ChatCut 本地导出的固定目录 */
export const CHATCUT_EXPORT_DIR = path.join(os.homedir(), "Movies", "ChatCut");

const VIDEO_EXT = new Set([".mp4", ".mov"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MIN_PREFIX = 6;

export interface CutSignals {
  /** 对上标题的导出文件名（可多个，给人判断） */
  export_files: string[];
  /** content.assets 里 type=cover 的个数 */
  cover_assets: number;
  /** 项目 05-cover/ 下有图的子目录名 */
  project_cover_dirs: string[];
}

export interface CutScan {
  hits: Map<string, CutSignals>;
  warnings: string[];
}

export interface CutScanOptions {
  /** 测试注入：替换 ChatCut 导出目录，不碰真实 ~/Movies */
  chatcutDir?: string;
}

/** 去空白与标点，只留汉字/字母/数字，字母小写 */
export function normalizeTitle(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/** 文件名：去扩展名，按 - / _ 切取第一段，再规范化 */
function normalizeFileStem(filename: string): string {
  const stem = path.basename(filename, path.extname(filename));
  return normalizeTitle(stem.split(/[-_]/)[0] ?? "");
}

/** 文件名规范化结果是标题规范化结果的前缀，且长度 ≥ 6 才算命中 */
export function exportMatchesTitle(filename: string, title: string): boolean {
  if (!VIDEO_EXT.has(path.extname(filename).toLowerCase())) return false;
  const stem = normalizeFileStem(filename);
  return Array.from(stem).length >= MIN_PREFIX && normalizeTitle(title).startsWith(stem);
}

/** 读一个导出目录的顶层文件名；ENOENT = 没信号，其他错误进 warnings */
async function readExportDir(dir: string, label: string, warnings: string[]): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code !== "ENOENT") warnings.push(`读不了${label}导出目录：${dir}（${code}）`);
    return [];
  }
}

async function exportFiles(dataDir: string, opts: CutScanOptions, warnings: string[]): Promise<string[]> {
  const chatcut = opts.chatcutDir ?? CHATCUT_EXPORT_DIR;
  const dirs: Array<[string, string]> = [[chatcut, " ChatCut "]];
  const jianying = (await getVideoSettingsRaw(dataDir)).jianyingExportDir;
  if (jianying && jianying !== chatcut) dirs.push([jianying, "剪映"]);
  const lists = await Promise.all(dirs.map(([d, label]) => readExportDir(d, label, warnings)));
  return lists.flat();
}

/** 项目 05-cover/ 下有图的子目录；没绑定项目、目录不在都算没信号 */
async function projectCoverDirs(contentId: string, dataDir: string): Promise<string[]> {
  let root: string;
  try {
    const binding = resolveContentProject(contentId, dataDir);
    if (!binding) return [];
    root = binding.project_root;
  } catch {
    return []; // 旧库稿没绑定项目：这一路信号本来就不存在
  }
  const coverRoot = path.join(root, "05-cover");
  const subs = await fs.readdir(coverRoot, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(subs.filter((d) => d.isDirectory()).map(async (d) => {
    const files = await fs.readdir(path.join(coverRoot, d.name)).catch(() => [] as string[]);
    return files.some((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())) ? d.name : null;
  }));
  return found.filter((n): n is string => n !== null);
}

export function isCutCandidate(c: Content): boolean {
  return isVideoPlatform(c.platform) && (c.status === "draft_ready" || c.status === "approved");
}

async function signalsOf(c: Content, files: string[], dataDir: string): Promise<CutSignals | null> {
  const signals: CutSignals = {
    export_files: files.filter((f) => exportMatchesTitle(f, c.title)),
    cover_assets: (c.assets ?? []).filter((a) => a.type === "cover").length,
    project_cover_dirs: await projectCoverDirs(c.id, dataDir),
  };
  const hit = signals.export_files.length > 0 || signals.cover_assets > 0 || signals.project_cover_dirs.length > 0;
  return hit ? signals : null;
}

/** 扫一遍候选稿：导出目录各读一次，命中的稿带信号返回 */
export async function scanUnregisteredCuts(contents: Content[], dataDir: string, opts: CutScanOptions = {}): Promise<CutScan> {
  const warnings: string[] = [];
  const candidates = contents.filter(isCutCandidate);
  const hits = new Map<string, CutSignals>();
  if (candidates.length === 0) return { hits, warnings };
  const files = await exportFiles(dataDir, opts, warnings);
  for (const c of candidates) {
    const s = await signalsOf(c, files, dataDir);
    if (s) hits.set(c.id, s);
  }
  return { hits, warnings };
}

export const CUT_UNREGISTERED_NEXT_ACTION =
  "成片已在外面导出但没交接：先交接（handoff），成片与最终字幕放进项目 04-edit、封面放 05-cover/vNNN，创始人工作台批完再 register";

export const COVER_ASSET_WARNING =
  "这张封面只存成了附件，进不了封面审批（gate4）：交接后放进项目 05-cover/vNNN/（带 cover-manifest.json），在工作台批";
