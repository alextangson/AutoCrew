/**
 * 把要看的文件放进会话的文件夹（spec 2026-10-06 proactive-chat-review §2）：桌面端文件栏只开会话文件夹里的文件。
 * 放在 `<preview_dir>/review-preview/<短标题>/`：图片复制，视频硬链接（不占空间）；放不进去就用预览 / QuickTime 打开并说原因。
 * 清理只碰 review-preview/ 这一棵：定掉的事的文件、放了超过 7 天的文件。
 *
 * 接受的残余风险：这里的链接检查都是「先查后做」，挡不住有进程在查和做之间把会话文件夹里的目录换成链接。
 * 能这么做的进程本来就能直接删这些文件，不在威胁模型里（Node 也没有 openat 式的锚定操作）。
 * 叶子一层便宜地堵上：放文件只用独占创建（复制带 COPYFILE_EXCL、硬链接本来就不覆盖），撞上 EEXIST 报问题、绝不覆盖。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const PREVIEW_ROOT = "review-preview";
const INDEX = ".index.json";
const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface PreviewFile { source: string; name: string; video: boolean }
export interface PreviewResult { files: Array<{ name: string; path: string }>; opened: Array<{ name: string; app: string; reason: string }>; problems: string[] }
type Index = { files: Record<string, { content_id: string; item_id: string; placed_at: number }> };

export interface PreviewDeps {
  open: (file: string, app: string) => Promise<void>;
  link: (src: string, dest: string) => Promise<void>;
  copy: (src: string, dest: string) => Promise<void>;
  now: () => number;
}
const realOpen = (file: string, app: string) => new Promise<void>((resolve, reject) => {
  // 测试绝不打开真的 App：必须经 setPreviewDeps 注入
  if (process.env.VITEST) return reject(new Error("测试里要注入 open"));
  execFile("open", ["-a", app, file], (e) => (e ? reject(e) : resolve()));
});
const DEFAULTS: PreviewDeps = { open: realOpen, link: (s, d) => fs.link(s, d), copy: (s, d) => fs.copyFile(s, d, FS.COPYFILE_EXCL), now: () => Date.now() };
let deps: PreviewDeps = DEFAULTS;
export function setPreviewDeps(d: Partial<PreviewDeps> | null): void { deps = d ? { ...DEFAULTS, ...d } : DEFAULTS; }

/** 短标题：去掉路径不允许的字符，最多 20 字 */
export function shortTitle(title: string, fallback: string): string {
  const t = title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 20).trim();
  return t || fallback;
}

/** 文件夹名：短标题 + 稳定的短 id（同标题前缀的两条稿、同一稿的几件事各有各的文件夹） */
export function previewFolder(title: string, key: { content_id: string; item_id: string }): string {
  const id = createHash("sha256").update(`${key.content_id}\u0000${key.item_id}`).digest("hex").slice(0, 6);
  return `${shortTitle(title, key.content_id)}-${id}`;
}

/** review-preview/ 的根：preview_dir 必须是已有的绝对目录；根若是符号链接就不碰 */
export async function previewRoot(previewDir: string): Promise<{ ok: true; root: string } | { ok: false; reason: string }> {
  if (!path.isAbsolute(previewDir)) return { ok: false, reason: `preview_dir 要是绝对路径（会话的工作目录），收到的是「${previewDir}」` };
  const st = await fs.stat(previewDir).catch((e: NodeJS.ErrnoException) => e);
  if (st instanceof Error) return { ok: false, reason: `会话文件夹打不开（${st.code ?? st.message}）` };
  if (!st.isDirectory()) return { ok: false, reason: "preview_dir 不是文件夹" };
  const root = path.join(previewDir, PREVIEW_ROOT);
  const l = await fs.lstat(root).catch(() => null);
  if (l && !l.isDirectory()) return { ok: false, reason: `${PREVIEW_ROOT} 不是普通文件夹（可能是链接），不往里放` };
  return { ok: true, root };
}

const inside = (root: string, p: string) => { const r = path.relative(root, p); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r); };

/** 预览记录：是链接就拒（不读不写穿它）；写时先写同目录临时文件再改名，绝不写穿已有的 inode */
async function readIndex(root: string): Promise<Index> {
  const file = path.join(root, INDEX);
  const l = await fs.lstat(file).catch(() => null);
  if (l && !l.isFile()) throw new Error(`${INDEX} 不是普通文件（可能是链接），不碰`);
  try { const v = JSON.parse(await fs.readFile(file, "utf8")) as Index; return v?.files ? v : { files: {} }; } catch { return { files: {} }; }
}
async function writeIndex(root: string, idx: Index): Promise<void> {
  const file = path.join(root, INDEX);
  const l = await fs.lstat(file).catch(() => null);
  if (l && !l.isFile()) throw new Error(`${INDEX} 不是普通文件（可能是链接），不碰`);
  const tmp = path.join(root, `.index.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(idx, null, 1), { flag: "wx" });
  await fs.rename(tmp, file);
}

/** 建 / 核 review-preview 和它下面的标题文件夹：每一层都必须是真文件夹（不是链接），真实路径不出 review-preview */
async function safeDir(root: string, dir: string): Promise<void> {
  for (const d of [root, dir]) {
    const l = await fs.lstat(d).catch(() => null);
    if (!l) await fs.mkdir(d);
    else if (l.isSymbolicLink() || !l.isDirectory()) throw Object.assign(new Error(`${path.basename(d)} 不是普通文件夹（可能是链接），不往里放`), { code: "ELINK" });
  }
  const realRoot = await fs.realpath(root);
  const realDir = await fs.realpath(dir);
  if (!inside(realRoot, realDir)) throw Object.assign(new Error("预览文件夹指到了 review-preview 外面，不往里放"), { code: "ELINK" });
}

/** 放不进去：用预览 / QuickTime 打开，原因写给创始人看 */
async function openInstead(f: PreviewFile, why: string, out: PreviewResult): Promise<void> {
  const app = f.video ? "QuickTime Player" : "Preview";
  try {
    await deps.open(f.source, app);
    out.opened.push({ name: f.name, app, reason: `${why}，已经用 ${app === "Preview" ? "预览" : "QuickTime"} 打开了` });
  } catch (e) {
    out.problems.push(`「${f.name}」${why}，也没能打开（${(e as Error).message}）`);
  }
}

async function placeOne(root: string, dir: string, f: PreviewFile, out: PreviewResult): Promise<string | null> {
  const dest = path.join(dir, f.name);
  try {
    await fs.access(f.source);
  } catch {
    out.problems.push(`「${f.name}」找不到了（可能挪走或删了）`);
    return null;
  }
  try {
    await safeDir(root, dir);
    const d = await fs.lstat(dest).catch(() => null);
    if (d && !d.isFile()) throw Object.assign(new Error(`「${f.name}」那个位置不是普通文件（可能是链接），不覆盖`), { code: "ELINK" });
    if (d) await fs.rm(dest);
    await (f.video ? deps.link : deps.copy)(f.source, dest);
    return path.relative(path.dirname(root), dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === "EEXIST" ? "放的时候那个位置又冒出了一个文件，没覆盖它" : code === "ELINK" ? (e as Error).message : f.video && code === "EXDEV" ? "原文件和会话文件夹不在同一块盘上，放进来就得复制一整份" : `没能放进会话文件夹（${code ?? (e as Error).message}）`;
    await openInstead(f, why, out);
    return null;
  }
}

/** 放这件事的文件；返回相对 preview_dir 的路径 */
export async function placePreview(previewDir: string, title: string, key: { content_id: string; item_id: string }, files: PreviewFile[]): Promise<PreviewResult> {
  const out: PreviewResult = { files: [], opened: [], problems: [] };
  const r = await previewRoot(previewDir);
  if (!r.ok) {
    for (const f of files) await openInstead(f, r.reason, out);
    return out;
  }
  const dir = path.join(r.root, previewFolder(title, key));
  let idx: Index;
  try { idx = await readIndex(r.root); } catch (e) {
    for (const f of files) await openInstead(f, (e as Error).message, out);
    return out;
  }
  for (const f of files) {
    const rel = await placeOne(r.root, dir, f, out);
    if (!rel) continue;
    out.files.push({ name: f.name, path: rel });
    idx.files[path.relative(r.root, path.join(previewDir, rel))] = { ...key, placed_at: deps.now() };
  }
  if (out.files.length) await writeIndex(r.root, idx).catch((e) => out.problems.push(`预览记录没写上（${(e as Error).message}），过后可能清不掉`));
  return out;
}

async function walk(dir: string, errors: string[]): Promise<string[]> {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (e) {
    errors.push(`读不了 ${path.basename(dir)}（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）`);
    return [];
  }
  const out: string[] = [];
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, errors)));
    else if (e.isFile()) out.push(p); // 符号链接等不是我们放的，不碰
  }
  return out;
}

export interface SweepResult { removed: string[]; errors: string[] }

/**
 * 清理：still(content_id, item_id) 说这件事还在等；不在等的（已定）文件删掉；放了 7 天以上的删掉。
 * 只删 review-preview/ 里的普通文件，然后删空文件夹。读不了 / 删不掉的原因收进 errors，不吞。
 */
export async function sweepPreview(previewDir: string, still: (contentId: string, itemId: string) => boolean): Promise<SweepResult> {
  const out: SweepResult = { removed: [], errors: [] };
  const r = await previewRoot(previewDir);
  if (!r.ok || !(await fs.lstat(r.root).catch(() => null))) return out;
  const idx = await readIndex(r.root);
  for (const file of await walk(r.root, out.errors)) {
    if (!inside(r.root, file) || path.basename(file) === INDEX) continue;
    const rel = path.relative(r.root, file);
    const e = idx.files[rel];
    const placed = e?.placed_at ?? (await fs.lstat(file)).mtimeMs;
    if ((e && !still(e.content_id, e.item_id)) || deps.now() - placed > WEEK_MS) {
      try { await fs.rm(file, { force: true }); } catch (err) { out.errors.push(`删不掉 ${rel}（${(err as Error).message}）`); continue; }
      delete idx.files[rel];
      out.removed.push(rel);
    }
  }
  for (const rel of Object.keys(idx.files)) if (!(await fs.lstat(path.join(r.root, rel)).catch(() => null))) delete idx.files[rel];
  await writeIndex(r.root, idx);
  await removeEmptyDirs(r.root, out.errors);
  return out;
}

async function removeEmptyDirs(root: string, errors: string[]): Promise<void> {
  for (const e of await fs.readdir(root, { withFileTypes: true }).catch((err: Error) => { errors.push(`读不了 review-preview（${err.message}）`); return []; })) {
    if (!e.isDirectory()) continue;
    const d = path.join(root, e.name);
    try {
      if (!(await fs.readdir(d)).length) await fs.rmdir(d);
    } catch (err) {
      const msg = `空文件夹 ${e.name} 没删掉（${(err as NodeJS.ErrnoException).code ?? (err as Error).message}）`;
      if (!errors.some((x) => x.includes(e.name))) errors.push(msg);
    }
  }
}
