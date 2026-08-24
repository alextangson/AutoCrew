// src/storage/library-store.ts
/**
 * Library store — 引用式素材库（S2.9）。
 *
 * 「库是索引，项目是快照」：只存元数据 JSON，原文件留在原地不复制；
 * 删除素材 = 删记录，永不碰原文件。挂接到稿件时由 ipc 层走 local-store
 * addAsset 的硬链接语义（同卷共享字节，跨卷退回复制）。
 *
 * ~/.autocrew/library/
 *   folders.json        — LibraryFolder[]（扁平，v1 不嵌套）
 *   assets/<id>.json    — 每素材一文件（原子写；损坏跳过 + warn）
 *
 * missing 为 list 时计算值（fs.access），不持久化。
 *
 * 写操作假定单一串行调用方（单抽屉面板经 IPC）；在引入第二个写入方
 * （如未来有写能力的 chat 工具）之前必须加写队列（参照 chat-persist
 * 的逐键 promise 链）。
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

/** 视频/音频的客观事实（ffprobe 读出，入库时钉住）。与 local-store 的 AssetMedia 同形 */
export interface LibraryAssetMedia {
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
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
  /**
   * 常备素材池成员（视频线 lifecycle spec §1）。**显式布尔而不是保留字标签**：
   * tags 是整组替换的自由元数据，误删误触的代价是「这条素材从此不进任何片子的目录」。
   * 开启的前置是 description 非空——判定在 modules/video/library-pool.ts，不是这里
   * （storage 只存事实，业务前置留给业务层，否则改说明的顺序会被存储层绑死）。
   */
  reusable?: boolean;
  /** 入库时 ffprobe 探测的时长/画幅；视频候选没有它就排不进剪辑师目录 */
  media?: LibraryAssetMedia;
  addedAt: string;
}

export interface LibraryAssetView extends LibraryAsset {
  missing: boolean;
  /**
   * 字节是直传进工作区的副本（`library/uploads/` 里那份），不是对外部原件的引用。
   * 移除它会连文件一起删——所以这个事实必须能传到 UI，让确认框说真话。
   */
  uploaded: boolean;
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

/** 单一事实源：main.ts 的 dialog:pick_media 过滤器从这里取，避免双份扩展名清单漂移 */
export const MEDIA_EXTENSIONS = {
  video: [...VIDEO_EXTS],
  image: [...IMAGE_EXTS],
  audio: [...AUDIO_EXTS],
} as const;

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

/**
 * 素材直传的落点。这一层里的文件是**我们自己复制进工作区的副本**（不是引用），
 * 所以它是「删记录连带删文件」的唯一例外范围；库外的引用路径永远不碰。
 * 路径口径的单一事实源：直传端点写它，removeAsset 按它判定要不要清理。
 */
export function uploadsDir(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "library", "uploads");
}

/** 这条素材的字节是不是直传副本；库外引用（人自己 Movies 里的原件）永远是 false */
export function isUploadedCopy(filePath: string, dataDir?: string): boolean {
  return path.resolve(filePath).startsWith(uploadsDir(dataDir) + path.sep);
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

/** 记录形状校验：缺 name/addedAt/tags 的半残记录会炸 sort 与 search，一律跳过 */
function isValidAssetRecord(record: LibraryAsset | null): record is LibraryAsset {
  return (
    record !== null &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.path === "string" &&
    typeof record.addedAt === "string" &&
    Array.isArray(record.tags)
  );
}

/** 读全部素材记录（损坏/半残跳过 + warn）；不算 missing——纯磁盘视图 */
async function loadAssetRecords(root: string): Promise<LibraryAsset[]> {
  const entries = await fs.readdir(path.join(root, "assets"));
  const records: LibraryAsset[] = [];
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const record = await readJson<LibraryAsset>(path.join(root, "assets", e));
    if (!isValidAssetRecord(record)) {
      console.warn(`[library-store] 跳过损坏素材：${e}`);
      continue;
    }
    records.push(record);
  }
  return records;
}

export async function createFolder(name: string, dataDir?: string): Promise<LibraryFolder> {
  if (!name.trim()) throw new Error("文件夹名称不能为空");
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
  // 先素材回根、最后才写 folders.json——中途崩溃不留悬空 folderId
  // （逐个改写；本地规模数百条，顺序 IO 足够）
  const records = await loadAssetRecords(root);
  for (const record of records) {
    if (record.folderId === id) {
      const p = safeAssetPath(root, record.id);
      if (p) await writeJsonAtomic(p, { ...record, folderId: null });
    }
  }
  await writeJsonAtomic(path.join(root, "folders.json"), folders.filter((f) => f.id !== id));
  return true;
}

/** 单文件导入：源不可读/非普通文件/记录写不出 → null（调用方记 skipped） */
async function importOne(
  root: string,
  abs: string,
  targetFolder: string | null,
): Promise<LibraryAsset | null> {
  let size = 0;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
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
  if (!p) return null;
  await writeJsonAtomic(p, asset);
  return asset;
}

export async function addAssets(
  paths: string[],
  folderId: string | null,
  dataDir?: string,
): Promise<{ added: LibraryAsset[]; skipped: string[] }> {
  const root = await libraryRoot(dataDir);
  const folders = await loadFolders(root);
  const targetFolder = folderId && folders.some((f) => f.id === folderId) ? folderId : null;
  const records = await loadAssetRecords(root);
  const knownPaths = new Set(records.map((a) => path.resolve(a.path)));

  const added: LibraryAsset[] = [];
  const skipped: string[] = [];
  for (const raw of paths) {
    const abs = path.resolve(raw);
    if (knownPaths.has(abs)) {
      skipped.push(raw);
      continue;
    }
    const asset = await importOne(root, abs, targetFolder);
    if (!asset) {
      skipped.push(raw);
      continue;
    }
    knownPaths.add(abs);
    added.push(asset);
  }
  return { added, skipped };
}

export async function listLibrary(dataDir?: string): Promise<LibraryView> {
  const root = await libraryRoot(dataDir);
  const folders = await loadFolders(root);
  const records = await loadAssetRecords(root);
  const assets: LibraryAssetView[] = [];
  for (const record of records) {
    let missing = false;
    try {
      await fs.access(record.path);
    } catch {
      missing = true;
    }
    assets.push({ ...record, missing, uploaded: isUploadedCopy(record.path, dataDir) });
  }
  assets.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return { folders, assets };
}

export async function getAsset(id: string, dataDir?: string): Promise<LibraryAsset | null> {
  const root = await libraryRoot(dataDir);
  const p = safeAssetPath(root, id);
  if (!p) return null;
  const record = await readJson<LibraryAsset>(p);
  return isValidAssetRecord(record) ? record : null;
}

export interface LibraryAssetPatch {
  name?: string;
  tags?: string[];
  description?: string;
  folderId?: string | null;
  path?: string;
  reusable?: boolean;
  media?: LibraryAssetMedia;
}

export async function updateAsset(
  id: string,
  patch: LibraryAssetPatch,
  dataDir?: string,
): Promise<LibraryAsset | null> {
  const root = await libraryRoot(dataDir);
  const existing = await getAsset(id, dataDir);
  if (!existing) return null;
  const next: LibraryAsset = { ...existing };
  if (typeof patch.name === "string" && patch.name.trim()) next.name = patch.name.trim();
  if (Array.isArray(patch.tags)) next.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof patch.description === "string") next.description = patch.description;
  if (typeof patch.reusable === "boolean") next.reusable = patch.reusable;
  if (patch.media) next.media = patch.media;
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
      // 重定位换了文件，旧的探测事实立即作废；下次进常备池时补探，不留一份对不上号的时长
      delete next.media;
    } catch {
      return null; // 重定位目标不存在：不动原记录
    }
  }
  const file = safeAssetPath(root, id);
  if (!file) return null;
  await writeJsonAtomic(file, next);
  return next;
}

/**
 * 常备素材池成员（视频线 lifecycle spec §1）。
 *
 * 两道闸都在这里合并判定：`reusable === true` **且** description 非空。
 * 第二条不是重复校验——它挡的是「先开常备、后把说明清空」与手改 JSON 两条路，
 * 常备池必须永远是「人写过说明的素材」（没说明的素材对剪辑师等于不存在）。
 */
export async function listReusableAssets(dataDir?: string): Promise<LibraryAsset[]> {
  const root = await libraryRoot(dataDir);
  const records = await loadAssetRecords(root);
  return records
    .filter((a) => a.reusable === true && (a.description ?? "").trim() !== "")
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 直传副本的连带清理：只清 `library/uploads/` 里那份。
 * 判定按路径前缀而不是按标记位——手改过的记录、旧版本写的记录都能对上号，
 * 而库外引用（人自己 Movies 里的原件）无论如何都落不进这个前缀。
 *
 * 挂接是硬链接（local-store addAsset）：这里的 rm 只断 uploads 这条链接，
 * 已挂接稿件的 `contents/<id>/assets/` 那条链接与数据原样还在——最后一条
 * 链接删除时数据才真正消失，所以无需查引用计数，硬链接语义天然正确。
 */
async function removeUploadedCopy(filePath: string, dataDir?: string): Promise<void> {
  if (!isUploadedCopy(filePath, dataDir)) return;
  const abs = path.resolve(filePath);
  try {
    await fs.rm(abs, { force: true });
    // 每次直传独占一个时间戳目录，文件走了目录就空了；非空说明不是我们那套，留着不猜
    await fs.rmdir(path.dirname(abs));
  } catch {
    /* 清不掉不阻断：记录已经删了，最坏结果只是工作区里留一份没人引用的字节 */
  }
}

export async function removeAsset(id: string, dataDir?: string): Promise<boolean> {
  // 只删记录，永不碰 record.path 指向的原文件（引用模式安全底线）。唯一例外是
  // library/uploads/ 里的直传副本：那是入库时我们复制进来的，记录一没就再没人引用它，
  // 留着只会让工作区烂成一堆孤儿字节（GB 级的 A-roll，一条就是一次磁盘事故）。
  const root = await libraryRoot(dataDir);
  const p = safeAssetPath(root, id);
  if (!p) return false;
  const record = await readJson<LibraryAsset>(p);
  try {
    await fs.unlink(p);
  } catch {
    return false;
  }
  if (typeof record?.path === "string") await removeUploadedCopy(record.path, dataDir);
  return true;
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
