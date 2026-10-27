/**
 * 建资料库并当场生效（onboarding-connect §7.3「建库立即生效」）：`autocrew init` 和网页引导「资料放哪」共用。
 * 落地仍走 library-manager 的 queue + apply（同一套校验、清单、原子发布），只是不等下次 `npm start`。
 *
 * 边界：O13 非空且不是资料库的文件夹不往里写；O14 Desktop/Documents/Downloads、NAS 没挂载说清原因，
 * 不静默落回 ~/.autocrew；O15 旧 ~/.autocrew 里有稿 → 先问搬不搬，搬前备份，不自动搬；O16 重跑幂等。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_FILES, applyPendingStorage, inventory, queueStorage, type StoragePlan } from "./library-manager.js";
import { assertLibraryWriter, holdProcessLibraryLock } from "./library-lock.js";
import { LIBRARY_MARKER, assertLibraryAvailable, canonicalTarget, getConfigDir, getMachineDir, readLibraryLocation } from "./storage-roots.js";

export const DEFAULT_LIBRARY_NAME = "AutoCrew资料库";
export function defaultLibraryPath(home = process.env.HOME || os.homedir()): string {
  return path.join(home, DEFAULT_LIBRARY_NAME);
}

export type TargetCheck =
  | { kind: "new"; target: string }
  | { kind: "library"; target: string }
  | { kind: "refused"; code: "not_absolute" | "privacy_folder" | "not_mounted" | "no_parent" | "not_empty" | "not_folder"; target: string; error: string; suggestion?: string };

const IGNORABLE = new Set([".DS_Store", ".localized"]);
const PRIVACY_FOLDERS: Record<string, string> = { Desktop: "桌面", Documents: "文稿", Downloads: "下载" };

async function lstatOrNull(p: string) {
  try { return await fs.stat(p); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
}

function privacyFolder(target: string, home: string, platform: NodeJS.Platform): string | null {
  if (platform !== "darwin") return null;
  for (const [name, label] of Object.entries(PRIVACY_FOLDERS)) {
    const rel = path.relative(path.join(home, name), target);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return label;
  }
  return null;
}

/** 只看不写：这个路径能不能当资料库 */
export async function checkLibraryTarget(input: string, opts: { home?: string; platform?: NodeJS.Platform } = {}): Promise<TargetCheck> {
  const home = opts.home ?? (process.env.HOME || os.homedir());
  const raw = input.trim().replace(/^~(?=$|\/)/, home);
  if (!path.isAbsolute(raw)) return { kind: "refused", code: "not_absolute", target: raw, error: "请填完整路径（以 / 或 ~ 开头）" };
  const target = path.resolve(raw);
  const privacy = privacyFolder(target, home, opts.platform ?? process.platform);
  if (privacy) {
    return { kind: "refused", code: "privacy_folder", target, suggestion: defaultLibraryPath(home),
      error: `「${privacy}」文件夹受 macOS 隐私保护，导演椅在后台常常读不到里面的东西。换一个位置，比如 ${defaultLibraryPath(home)}` };
  }
  const volume = target.match(/^\/Volumes\/[^/]+/)?.[0];
  if (volume && !(await lstatOrNull(volume))) {
    return { kind: "refused", code: "not_mounted", target, error: `${volume} 现在没挂载（NAS 没连上或名字不对）。先在访达里连上 NAS，再填一次这个路径。` };
  }
  const stat = await lstatOrNull(target);
  if (!stat) {
    if (!(await lstatOrNull(path.dirname(target)))) return { kind: "refused", code: "no_parent", target, error: `上一级文件夹 ${path.dirname(target)} 不存在。先建好它，或换一个位置。` };
    return { kind: "new", target };
  }
  if (!stat.isDirectory()) return { kind: "refused", code: "not_folder", target, error: `${target} 是一个文件，不是文件夹。换一个位置。` };
  if (await lstatOrNull(path.join(target, LIBRARY_MARKER))) return { kind: "library", target };
  const names = (await fs.readdir(target)).filter((n) => !IGNORABLE.has(n));
  if (!names.length) return { kind: "new", target };
  const sub = path.join(target, DEFAULT_LIBRARY_NAME);
  return { kind: "refused", code: "not_empty", target, suggestion: sub,
    error: `${target} 里已经有别的东西（${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}），不往里面写。换一个空文件夹，或用它下面的子文件夹 ${sub}` };
}

export interface LegacyData { drafts: number; files: number }

/**
 * 旧位置（没建库时的 ~/.autocrew）有什么资料（O15 问之前先数）：和迁移用同一份清单——
 * 默认工作区、注册过的 ws-* 工作区、稿件的目录版和平铺 JSON 版都算；钥匙配置不算资料。
 */
export async function legacyData(): Promise<LegacyData> {
  if (readLibraryLocation()) return { drafts: 0, files: 0 };
  const items = (await inventory()).items.filter((i) => !i.config);
  const drafts = new Set<string>();
  for (const i of items) {
    const m = i.relative.split(path.sep);
    const at = m.indexOf("contents");
    if (m[0] === "workspaces" && at === 2 && m[3]) drafts.add(`${m[1]}/${m[3].replace(/\.json$/, "")}`);
  }
  return { drafts: drafts.size, files: items.length };
}

/** 搬之前把旧资料整份复制一份到 ~/.autocrew-backup-<时间>：迁移清单里的每个资料文件都备份（钥匙和本机状态不复制） */
export async function backupLegacyData(now = new Date()): Promise<string> {
  const dest = `${getMachineDir()}-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
  await fs.mkdir(dest, { recursive: false, mode: 0o700 });
  for (const item of (await inventory()).items.filter((i) => !i.config)) {
    const to = path.join(dest, item.relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(item.source, to, fs.constants.COPYFILE_EXCL);
  }
  return dest;
}

/** 新建库时把旧位置的钥匙配置复制到新库的本机配置目录（不复制就等于引导里刚填的钥匙丢了）；旧文件原样留着 */
async function carryConfigs(fromDir: string): Promise<void> {
  const toDir = getConfigDir();
  if (path.resolve(toDir) === path.resolve(fromDir)) return;
  await fs.mkdir(toDir, { recursive: true, mode: 0o700 });
  for (const name of CONFIG_FILES) {
    const src = path.join(fromDir, name);
    if (!(await lstatOrNull(src))) continue;
    await fs.copyFile(src, path.join(toDir, name), fs.constants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    await fs.chmod(path.join(toDir, name), 0o600);
  }
}

export type LegacyChoice = "migrate" | "keep";
export type SetupResult =
  | { status: "already"; root: string }
  | { status: "created" | "opened" | "migrated"; root: string; backup?: string; plan: StoragePlan }
  | { status: "queued_restart"; root: string; backup: string }
  | { status: "needs_legacy_choice"; root: string; drafts: number; files: number }
  | { status: "refused"; code: string; error: string; root?: string; suggestion?: string };

export interface SetupOptions {
  target: string;
  legacy?: LegacyChoice;
  /** 运行中的服务自己调用：只能新建 / 打开，搬旧资料排到下次启动 */
  live?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
}

/** 激活后的收尾（钥匙配置复制 + 服务占写入权）：幂等，`already` 时也再跑一遍，中途失败的上一次能在重试时补完（O16） */
async function finishActivation(live: boolean): Promise<void> {
  const root = readLibraryLocation()!.root;
  if (live) {
    try { assertLibraryWriter(root); } catch { holdProcessLibraryLock(); }
  }
  await carryConfigs(getMachineDir());
}

async function alreadyConfigured(target: string, live: boolean): Promise<SetupResult | null> {
  const location = readLibraryLocation();
  if (!location) return null;
  assertLibraryAvailable(location);
  if (canonicalTarget(location.root) !== canonicalTarget(target)) {
    return { status: "refused", code: "other_library", root: location.root,
      error: `这台电脑已经在用 ${location.root} 这个资料库。要换位置，去 设置 → 模型 → 用户资料库 里迁移。` };
  }
  await finishActivation(live);
  return { status: "already", root: location.root };
}

export async function setupLibrary(opts: SetupOptions): Promise<SetupResult> {
  const check = await checkLibraryTarget(opts.target, opts);
  if (check.kind === "refused") return { status: "refused", code: check.code, error: check.error, root: check.target, ...(check.suggestion ? { suggestion: check.suggestion } : {}) };
  const done = await alreadyConfigured(check.target, Boolean(opts.live));
  if (done) return done;
  const legacy = check.kind === "library" ? { drafts: 0, files: 0 } : await legacyData();
  if (legacy.files > 0 && !opts.legacy) return { status: "needs_legacy_choice", root: check.target, ...legacy };
  const migrate = legacy.files > 0 && opts.legacy === "migrate";
  const backup = migrate ? await backupLegacyData() : undefined;
  const action = check.kind === "library" ? "open" : migrate ? "migrate" : "create";
  await queueStorage({ action, target: check.target });
  if (migrate && opts.live) return { status: "queued_restart", root: check.target, backup: backup! };
  const plan = await applyPendingStorage(undefined, { live: Boolean(opts.live) });
  if (!plan) throw new Error("资料库切换没有执行（待切换记录不见了），请重试");
  // 迁移时钥匙配置已随清单搬到新库；新建 / 打开时从旧位置复制，并让运行中的服务占住新库写入权
  if (action !== "migrate") await finishActivation(Boolean(opts.live));
  const status = action === "open" ? "opened" : action === "migrate" ? "migrated" : "created";
  return { status, root: check.target, plan, ...(backup ? { backup } : {}) };
}
