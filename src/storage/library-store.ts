// src/storage/library-store.ts
/**
 * Library store — 引用式素材库（S2.9）。
 *
 * 「库是索引，项目是快照」：只存元数据 JSON，原文件留在原地不复制；
 * 删除素材 = 删记录，永不碰原文件。挂接到稿件时由 ipc 层走 local-store
 * addAsset 的复制语义。
 *
 * ~/.autocrew/library/
 *   folders.json        — LibraryFolder[]（扁平，v1 不嵌套）
 *   assets/<id>.json    — 每素材一文件（原子写；损坏跳过 + warn）
 *
 * missing 为 list 时计算值（fs.access），不持久化。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { getDataDir } from "./local-store.js";
import { writeJsonAtomic, readJson } from "./json-atomic.js";

export type LibraryAssetType = "video" | "image" | "audio" | "other";

export interface LibraryFolder {
  id: string;
  name: string;
  createdAt: string;
}

export interface LibraryAsset {
  id: string;
  name: string;
  /** 原文件绝对路径（引用，不复制） */
  path: string;
  type: LibraryAssetType;
  ext: string;
  /** 入库时记录的字节数 */
  size: number;
  folderId: string | null;
  tags: string[];
  description?: string;
  addedAt: string;
}

export interface LibraryAssetView extends LibraryAsset {
  missing: boolean;
}

export interface LibraryView {
  folders: LibraryFolder[];
  assets: LibraryAssetView[];
}

const ASSET_ID_RE = /^asset-\d+-[a-z0-9]+$/;
const FOLDER_ID_RE = /^folder-\d+-[a-z0-9]+$/;

const VIDEO_EXTS = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm", "flv"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp", "tiff", "svg"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg"]);

export function detectType(filePath: string): { type: LibraryAssetType; ext: string } {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  if (VIDEO_EXTS.has(ext)) return { type: "video", ext };
  if (IMAGE_EXTS.has(ext)) return { type: "image", ext };
  if (AUDIO_EXTS.has(ext)) return { type: "audio", ext };
  return { type: "other", ext };
}

async function libraryRoot(dataDir?: string): Promise<string> {
  const root = path.join(getDataDir(dataDir), "library");
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  return root;
}

async function loadFolders(root: string): Promise<LibraryFolder[]> {
  const folders = await readJson<LibraryFolder[]>(path.join(root, "folders.json"));
  if (folders === null) return []; // 不存在或损坏均视为空；下次成功写入修复
  return Array.isArray(folders) ? folders : [];
}

/** 校验 id 并拼 asset JSON 路径；非法 id → null（防路径穿越） */
function safeAssetPath(root: string, id: string): string | null {
  if (!ASSET_ID_RE.test(id)) return null;
  return path.join(root, "assets", `${id}.json`);
}

export async function createFolder(name: string, dataDir?: string): Promise<LibraryFolder> {
  const root = await libraryRoot(dataDir);
  const folders = await loadFolders(root);
  const folder: LibraryFolder = {
    id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
  folders.push(folder);
  await writeJsonAtomic(path.join(root, "folders.json"), folders);
  return folder;
}

export async function removeFolder(id: string, dataDir?: string): Promise<boolean> {
  if (!FOLDER_ID_RE.test(id)) return false;
  const root = await libraryRoot(dataDir);
  const folders = await loadFolders(root);
  if (!folders.some((f) => f.id === id)) return false;
  await writeJsonAtomic(path.join(root, "folders.json"), folders.filter((f) => f.id !== id));
  // 文件夹内素材回根（逐个改写；本地规模数百条，顺序 IO 足够）
  const view = await listLibrary(dataDir);
  for (const a of view.assets) {
    if (a.folderId === id) {
      const p = safeAssetPath(root, a.id);
      if (p) {
        const { missing: _missing, ...record } = a;
        await writeJsonAtomic(p, { ...record, folderId: null });
      }
    }
  }
  return true;
}

export async function addAssets(
  paths: string[],
  folderId: string | null,
  dataDir?: string,
): Promise<{ added: LibraryAsset[]; skipped: string[] }> {
  const root = await libraryRoot(dataDir);
  const folders = await loadFolders(root);
  const targetFolder = folderId && folders.some((f) => f.id === folderId) ? folderId : null;
  const existing = await listLibrary(dataDir);
  const knownPaths = new Set(existing.assets.map((a) => path.resolve(a.path)));

  const added: LibraryAsset[] = [];
  const skipped: string[] = [];
  for (const raw of paths) {
    const abs = path.resolve(raw);
    if (knownPaths.has(abs)) {
      skipped.push(raw);
      continue;
    }
    let size = 0;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) {
        skipped.push(raw);
        continue;
      }
      size = st.size;
    } catch {
      skipped.push(raw);
      continue;
    }
    const { type, ext } = detectType(abs);
    const asset: LibraryAsset = {
      id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: path.basename(abs),
      path: abs,
      type,
      ext,
      size,
      folderId: targetFolder,
      tags: [],
      addedAt: new Date().toISOString(),
    };
    const p = safeAssetPath(root, asset.id);
    if (!p) {
      skipped.push(raw);
      continue;
    }
    await writeJsonAtomic(p, asset);
    knownPaths.add(abs);
    added.push(asset);
  }
  return { added, skipped };
}

export async function listLibrary(dataDir?: string): Promise<LibraryView> {
  const root = await libraryRoot(dataDir);
  const folders = await loadFolders(root);
  const entries = await fs.readdir(path.join(root, "assets"));
  const assets: LibraryAssetView[] = [];
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const record = await readJson<LibraryAsset>(path.join(root, "assets", e));
    if (!record || typeof record.id !== "string" || typeof record.path !== "string") {
      console.warn(`[library-store] 跳过损坏素材：${e}`);
      continue;
    }
    let missing = false;
    try {
      await fs.access(record.path);
    } catch {
      missing = true;
    }
    assets.push({ ...record, missing });
  }
  assets.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return { folders, assets };
}

export async function getAsset(id: string, dataDir?: string): Promise<LibraryAsset | null> {
  const root = await libraryRoot(dataDir);
  const p = safeAssetPath(root, id);
  if (!p) return null;
  const record = await readJson<LibraryAsset>(p);
  if (!record || typeof record.id !== "string" || typeof record.path !== "string") return null;
  return record;
}

export async function updateAsset(
  id: string,
  patch: { name?: string; tags?: string[]; description?: string; folderId?: string | null; path?: string },
  dataDir?: string,
): Promise<LibraryAsset | null> {
  const root = await libraryRoot(dataDir);
  const existing = await getAsset(id, dataDir);
  if (!existing) return null;
  const next: LibraryAsset = { ...existing };
  if (typeof patch.name === "string" && patch.name.trim()) next.name = patch.name.trim();
  if (Array.isArray(patch.tags)) next.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof patch.description === "string") next.description = patch.description;
  if (patch.folderId !== undefined) {
    const folders = await loadFolders(root);
    next.folderId = patch.folderId !== null && folders.some((f) => f.id === patch.folderId) ? patch.folderId : null;
  }
  if (typeof patch.path === "string") {
    const abs = path.resolve(patch.path);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) return null;
      next.path = abs;
      next.size = st.size;
      const dt = detectType(abs);
      next.type = dt.type;
      next.ext = dt.ext;
    } catch {
      return null; // 重定位目标不存在：不动原记录
    }
  }
  const file = safeAssetPath(root, id);
  if (!file) return null;
  await writeJsonAtomic(file, next);
  return next;
}

export async function removeAsset(id: string, dataDir?: string): Promise<boolean> {
  // 只删记录，永不碰 record.path 指向的原文件（引用模式安全底线）
  const root = await libraryRoot(dataDir);
  const p = safeAssetPath(root, id);
  if (!p) return false;
  try {
    await fs.unlink(p);
    return true;
  } catch {
    return false;
  }
}

export async function searchAssets(
  query: string,
  type?: LibraryAssetType,
  dataDir?: string,
): Promise<LibraryAssetView[]> {
  const view = await listLibrary(dataDir);
  const q = query.trim().toLowerCase();
  return view.assets.filter(
    (a) =>
      (type === undefined || a.type === type) &&
      (q === "" || a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q))),
  );
}
