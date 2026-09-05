/**
 * 把 bundle 自带的 `autocrew` agent preset 装进 `$DSH_HOME/.agent-presets/`。
 *
 * 为什么是「复制」而不是「声明一个 preset 根」:dsh launcher（`lib/profile-boot-*.js`）
 * 合成 host composition 时把 `agent-presets.roots` **整体覆盖**成只剩它自带的那个根,
 * bundle 经 `cordis.patch.yml` 加根加不进去。roster 剩下的唯一入口是用户根
 * `<dshHome>/.agent-presets`（`includeUserRoot` 默认开）,而用户根只认磁盘上的目录。
 *
 * 三条不变量:
 *   1. **幂等**——版本戳 + skillsDir 都没变就一个字节都不写（preset 的 mtime 变了
 *      会让 roster 起新 generation,而旧 generation 永远不回收）。
 *   2. **只覆盖自带文件**——用户在这个目录里加的文件一个都不删。人会把 preset
 *      当自己的东西改,升级不能悄悄吃掉他的东西。
 *   3. **只碰 `autocrew` 这一个 id**——每一次写路径都过 `resolveInside` 断言,
 *      越界当场抛,而不是写出去之后再发现。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** preset 目录名,也是 roster 里的 preset id（`[a-z0-9][a-z0-9-]*`）。 */
export const PRESET_ID = "autocrew";

/** 用户 preset 根,由 `dsh-agent-presets` 从 dshHome 推导,名字是它定的。 */
export const PRESET_ROOT_DIR = ".agent-presets";

/** 版本戳文件名。点开头,不会被 roster 当成 preset 目录扫到。 */
export const STAMP_FILE = ".dsh-autocrew.json";

/** preset 里等待安装器替换成绝对路径的占位符。 */
export const SKILLS_DIR_PLACEHOLDER = "__AUTOCREW_SKILLS_DIR__";

/**
 * preset 内容的版本。**改了 `agent-presets/autocrew/` 下任何文件就要 +1**,
 * 否则已装过的机器不会被覆盖。刻意与 package.json 的版本脱钩:一次不碰 preset
 * 的 patch 发布不该去重写用户手上的 preset。
 */
export const PRESET_VERSION = "4";

/** dsh 自己复制 preset 时的权限:文件 0o600、目录 0o700。 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface InstallPresetOptions {
  /** 已解析的 dsh home 绝对路径（`resolveDshHome()`）。 */
  dshHome: string;
  /** bundle 里 preset 源目录的绝对路径。 */
  presetSource: string;
  /** AutoCrew skills 目录的绝对路径,替换掉占位符。 */
  skillsDir: string;
  /** 内容版本,与已装的版本戳比对。 */
  version: string;
}

export interface InstallPresetResult {
  /** preset 落地的绝对路径。 */
  target: string;
  /** false = 版本戳与 skillsDir 都没变,这一趟一个字节都没写。 */
  written: boolean;
  /** 这份 bundle 自带的文件（相对 preset 目录）。 */
  files: string[];
}

interface Stamp {
  version: string;
  installedAt: string;
  skillsDir: string;
}

/**
 * 拼路径并断言结果没走出 `root`。每一次写都过它——`..`、绝对路径、符号链接名
 * 都在这里被挡下,而不是写出去之后才发现。
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...segments);
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    throw new Error(`refusing to write outside ${base}: ${candidate}`);
  }
  return candidate;
}

/** `<dshHome>/.agent-presets/autocrew`。失败日志也要报这个路径,所以单独导出。 */
export function presetTargetDir(dshHome: string): string {
  return resolveInside(dshHome, PRESET_ROOT_DIR, PRESET_ID);
}

/**
 * bundle 自己的包根。`dist/index.js` 与 `src/index.ts` 都在包根下一层,所以
 * 上两级在两种布局下都落在 `adapters/dsh`。
 *
 * 用 `import.meta.url` 推路径在这里是安全的:推的是 **bundle 自己**的位置。
 * README 检查单里那条警告说的是被内联进 bundle 的 AutoCrew 源码——那些文件
 * 打包后不再有自己的 URL,推出来的 `REPO_ROOT` 必然指错。
 */
export function bundlePackageDir(moduleUrl: string): string {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}

/** bundle 里 preset 源目录。 */
export function presetSourceDir(bundlePkgDir: string): string {
  return path.join(bundlePkgDir, "agent-presets", PRESET_ID);
}

/**
 * AutoCrew 的 skills 目录。两种布局各一个候选:
 *   - `<pkg>/skills`        npm 包布局（skills 随包发出去）
 *   - `<pkg>/../../skills`  仓库布局(`dsh plugin add ./adapters/dsh` 的 link 安装)
 */
export async function resolveSkillsDir(bundlePkgDir: string): Promise<string> {
  const candidates = [path.join(bundlePkgDir, "skills"), path.resolve(bundlePkgDir, "..", "..", "skills")];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  throw new Error(`AutoCrew skills dir not found; looked at: ${candidates.join(", ")}`);
}

/**
 * 装 preset。返回 `written: false` 表示这次跳过了（已是当前版本 + 同一个 skillsDir）。
 */
export async function installPreset(options: InstallPresetOptions): Promise<InstallPresetResult> {
  const { presetSource, skillsDir, version } = options;
  if (!path.isAbsolute(options.dshHome)) {
    throw new Error(`dshHome must be an absolute path, got ${JSON.stringify(options.dshHome)}`);
  }
  if (!path.isAbsolute(skillsDir)) {
    throw new Error(`skillsDir must be an absolute path, got ${JSON.stringify(skillsDir)}`);
  }

  const target = presetTargetDir(options.dshHome);
  const files = (await listFiles(presetSource)).filter((rel) => rel !== STAMP_FILE).sort();
  // 空源目录会装出一个「broken preset」——roster 会把它列出来并报 broken,
  // 但那时已经没人知道是安装器写空的。在这里就停。
  if (!files.includes("agent.cordis.yml")) {
    throw new Error(`preset source is missing agent.cordis.yml: ${presetSource}`);
  }

  const stamp = await readStamp(target);
  const current =
    stamp?.version === version &&
    stamp.skillsDir === skillsDir &&
    // 版本戳在、composition 被人删了 —— 戳会撒谎,重装。
    (await exists(resolveInside(target, "agent.cordis.yml")));
  if (current) return { target, written: false, files };

  await mkdirMode(target);
  for (const rel of files) {
    const dest = resolveInside(target, rel);
    await mkdirMode(path.dirname(dest));
    await writeFileMode(dest, template(await fs.readFile(path.join(presetSource, rel)), skillsDir));
  }

  const next: Stamp = { version, installedAt: new Date().toISOString(), skillsDir };
  await writeFileMode(resolveInside(target, STAMP_FILE), Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"));
  return { target, written: true, files };
}

/**
 * 占位符替换。先在字节层面找,找不到就原样写回——preset 以后要带二进制资源
 * （字体、图）时不会被 utf8 往返毁掉。
 */
function template(raw: Buffer, skillsDir: string): Buffer {
  if (!raw.includes(SKILLS_DIR_PLACEHOLDER)) return raw;
  return Buffer.from(raw.toString("utf8").split(SKILLS_DIR_PLACEHOLDER).join(skillsDir), "utf8");
}

/** 递归列出相对路径。符号链接按它指向的东西算,复制出来的目录才是自足的。 */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    const abs = path.join(dir, entry.name);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) out.push(...(await listFiles(abs, rel)));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

/** mkdir 的 mode 受 umask 影响,所以建完再 chmod 一次;已存在的目录也要收紧。 */
async function mkdirMode(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE);
}

/** writeFile 的 mode 只在新建时生效,覆盖已存在的文件要显式 chmod。 */
async function writeFileMode(file: string, body: Buffer): Promise<void> {
  await fs.writeFile(file, body, { mode: FILE_MODE });
  await fs.chmod(file, FILE_MODE);
}

/** 读不到、坏了、形状不对 —— 一律当「没装过」,重装一遍总是安全的。 */
async function readStamp(target: string): Promise<Stamp | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(resolveInside(target, STAMP_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { version, skillsDir } = parsed as Partial<Stamp>;
    if (typeof version !== "string" || typeof skillsDir !== "string") return undefined;
    return parsed as Stamp;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
