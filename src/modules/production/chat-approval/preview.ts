/**
 * 把要看的文件放进会话的文件夹（spec 2026-10-06 proactive-chat-review §2）：桌面端文件栏只开会话文件夹里的文件。
 * 放在 `<preview_dir>/review-preview/<短标题>/`：图片复制，视频硬链接（不占空间）；放不进去就用预览 / QuickTime 打开并说原因。
 * 清理只碰 review-preview/ 这一棵：定掉的事的文件、放了超过 7 天的文件。
 */
import { execFile } from "node:child_process";
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
const DEFAULTS: PreviewDeps = { open: realOpen, link: (s, d) => fs.link(s, d), copy: (s, d) => fs.copyFile(s, d), now: () => Date.now() };
let deps: PreviewDeps = DEFAULTS;
export function setPreviewDeps(d: Partial<PreviewDeps> | null): void { deps = d ? { ...DEFAULTS, ...d } : DEFAULTS; }

/** 短标题：去掉路径不允许的字符，最多 20 字 */
export function shortTitle(title: string, fallback: string): string {
  const t = title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 20).trim();
  return t || fallback;
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

async function readIndex(root: string): Promise<Index> {
  try { const v = JSON.parse(await fs.readFile(path.join(root, INDEX), "utf8")) as Index; return v?.files ? v : { files: {} }; } catch { return { files: {} }; }
}
const writeIndex = (root: string, idx: Index) => fs.writeFile(path.join(root, INDEX), JSON.stringify(idx, null, 1));

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
    await fs.mkdir(dir, { recursive: true });
    await fs.rm(dest, { force: true });
    await (f.video ? deps.link : deps.copy)(f.source, dest);
    return path.relative(path.dirname(root), dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = f.video && code === "EXDEV" ? "原文件和会话文件夹不在同一块盘上，放进来就得复制一整份" : `没能放进会话文件夹（${code ?? (e as Error).message}）`;
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
  const dir = path.join(r.root, shortTitle(title, key.content_id));
  const idx = await readIndex(r.root);
  for (const f of files) {
    const rel = await placeOne(r.root, dir, f, out);
    if (!rel) continue;
    out.files.push({ name: f.name, path: rel });
    idx.files[path.relative(r.root, path.join(previewDir, rel))] = { ...key, placed_at: deps.now() };
  }
  if (out.files.length) await writeIndex(r.root, idx).catch((e) => out.problems.push(`预览记录没写上（${(e as Error).message}），过后可能清不掉`));
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p); // 符号链接等不是我们放的，不碰
  }
  return out;
}

/**
 * 清理：still(content_id, item_id) 说这件事还在等；不在等的（已定）文件删掉；放了 7 天以上的删掉。
 * 只删 review-preview/ 里的普通文件，然后删空文件夹。
 */
export async function sweepPreview(previewDir: string, still: (contentId: string, itemId: string) => boolean): Promise<string[]> {
  const r = await previewRoot(previewDir);
  if (!r.ok) return [];
  const idx = await readIndex(r.root);
  const removed: string[] = [];
  for (const file of await walk(r.root)) {
    if (!inside(r.root, file) || path.basename(file) === INDEX) continue;
    const rel = path.relative(r.root, file);
    const e = idx.files[rel];
    const placed = e?.placed_at ?? (await fs.lstat(file)).mtimeMs;
    if ((e && !still(e.content_id, e.item_id)) || deps.now() - placed > WEEK_MS) {
      await fs.rm(file, { force: true });
      delete idx.files[rel];
      removed.push(rel);
    }
  }
  for (const rel of Object.keys(idx.files)) if (!(await fs.lstat(path.join(r.root, rel)).catch(() => null))) delete idx.files[rel];
  await writeIndex(r.root, idx).catch(() => undefined);
  await removeEmptyDirs(r.root);
  return removed;
}

async function removeEmptyDirs(root: string): Promise<void> {
  for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const d = path.join(root, e.name);
    if (!(await fs.readdir(d).catch(() => ["x"])).length) await fs.rmdir(d).catch(() => undefined);
  }
}
