/**
 * 研究素材库（深调研 spec §0.3 裁决 + §7）——**选题级**，不是 content 级：
 * 深调研发生在选题期，那时还没有 contentId，而既有 content 素材模型强制绑 contentId、
 * library 模型是「引用本地已有文件」，两套都不适配（也都没有 candidate 态与来源字段）。
 * 所以另起一处：`<dataDir>/research/assets/<topicId>/`，开写后在配图放置时**导入**为
 * 该 content 的素材（拷贝 + 登记来源，走既有人工确认流程）。
 *
 * 三条硬约束：
 * 1. **文件内容寻址、全库共享**：文件落在 `research/assets/files/<sha256 前 16 位>.<magic 定的扩展名>`，
 *    **不按选题分目录**。不信 URL 里的后缀（`.jpg` 结尾的 PNG 到处都是，更不用说 `.php?id=`）；
 *    同一张图被两个页面、两个选题各引用一次时，索引里是两条记录、盘上只有一份字节。
 * 2. **索引 append-only + fsync**：`index.jsonl` 按 assetId latest-wins，与收件箱台账
 *    同一套读写纪律。不提供删除 API——素材的来源与授权状态要能回溯。
 * 3. **去重是选题级的**（创始人裁决，R1b-B）：键是 `(topicId, 规范化 sourceUrl)`。
 *    素材库是**按选题组织的候选清单**，A 选题存过的图不该让 B 选题的清单里凭空少一张；
 *    但字节层没有理由存两遍，所以记录各自成条、文件按内容 hash 共享。
 *    license 恒为 unknown：抓来的图授权未知，放置界面必须标「授权需自查」。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isTopicId } from "../../storage/entity-id.js";
import { canonicalizeUrl } from "../inbox/url-canonical.js";
import type { FetchedImage, ImageFormat } from "./fetch-image.js";

/**
 * candidate = 下载入库、等人挑；imported = 至少被导入过一次正文配图（§7 硬闸只管
 * 「不自动进正文」，导入是人点出来的动作）。imported 不是「已用完」——同一张图可以
 * 进多篇稿子，状态只记「这条候选被采用过」。
 */
export type ResearchAssetStatus = "candidate" | "imported";
/** 抓来的图授权一律未知——没有任何自动判定能替代人工确认 */
export type ResearchAssetLicense = "unknown";

export interface ResearchAsset {
  assetId: string;
  topicId: string;
  /** 相对 dataDir 的路径（`research/assets/files/<hash>.<ext>`），落盘用 posix 分隔符 */
  file: string;
  format: ImageFormat;
  width: number;
  height: number;
  /** 文件字节数（= 落盘内容长度） */
  bytes: number;
  /** 图片自身的 URL（下载后的 finalUrl） */
  sourceUrl: string;
  /** 图片所在的页面 —— 授权自查与出处标注都靠它，不是图片直链 */
  sourcePageUrl: string;
  caption: string;
  capturedAt: string;
  status: ResearchAssetStatus;
  license: ResearchAssetLicense;
}

/** 登记一条素材所需的元信息；尺寸/格式/字节数从 FetchedImage 取，不让调用方转述 */
export interface NewResearchAsset {
  topicId: string;
  sourceUrl: string;
  sourcePageUrl: string;
  caption: string;
}

const RESEARCH_DIR = "research";
const ASSETS_DIR = "assets";
/** 字节层：内容寻址、跨选题共享的一个平目录 */
const FILES_DIR = "files";
const INDEX_FILE = "index.jsonl";

/** 扩展名由 magic 定：jpeg 落 `.jpg`（通用惯例），另两种同名 */
const FORMAT_EXT: Record<ImageFormat, string> = { png: "png", jpeg: "jpg", webp: "webp" };

export function researchAssetsDir(dataDir: string): string {
  return path.join(dataDir, RESEARCH_DIR, ASSETS_DIR);
}

function indexPath(dataDir: string): string {
  return path.join(researchAssetsDir(dataDir), INDEX_FILE);
}

/** topicId 会成为路径片段：非法 id 直接拒，别让它拼出 `../` */
function assertTopicId(topicId: string): void {
  if (!isTopicId(topicId)) throw new Error(`非法选题 id：${topicId}`);
}

function contentName(image: FetchedImage): string {
  const hash = createHash("sha256").update(image.bytes).digest("hex").slice(0, 16);
  return `${hash}.${FORMAT_EXT[image.format]}`;
}

// ─── 索引读写（append-only + fsync，照 inbox-store）──────────────────────────

async function readJournal(dataDir: string): Promise<ResearchAsset[]> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const assets: ResearchAsset[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ResearchAsset;
      // 单行损坏（崩在写一半）不清空整个读视图，也不让半条记录冒充素材
      if (parsed && typeof parsed.assetId === "string") assets.push(parsed);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return assets;
}

/** 唯一写入口：append + fsync。停在页缓存里的一行 = 文件在盘上但库里查不到 */
async function appendIndex(asset: ResearchAsset, dataDir: string): Promise<void> {
  await fs.mkdir(researchAssetsDir(dataDir), { recursive: true });
  const fh = await fs.open(indexPath(dataDir), "a");
  try {
    await fh.writeFile(JSON.stringify(asset) + "\n", "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** latest-wins 读视图，按 capturedAt 升序（老的在前）；UI 要「新的在前」自己 reverse */
async function readAll(dataDir: string): Promise<ResearchAsset[]> {
  const journal = await readJournal(dataDir);
  const byId = new Map<string, ResearchAsset>();
  for (const asset of journal) byId.set(asset.assetId, asset);
  return [...byId.values()].sort(
    (a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.assetId.localeCompare(b.assetId),
  );
}

// ─── 落盘 ───────────────────────────────────────────────────────────────────

/**
 * 内容寻址写盘：同 hash 同大小的文件已在就不重写——不同来源的同一张图共享一份字节，
 * 也不会去动一个可能正被读的文件。写用 tmp + rename，读者要么看不到，要么看到完整的。
 */
async function writeAssetFile(dest: string, bytes: Buffer): Promise<void> {
  const existing = await fs.stat(dest).catch(() => null);
  if (existing?.isFile() && existing.size === bytes.length) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, dest);
  } finally {
    await fs.unlink(tmp).catch(() => {
      /* best-effort：rename 成功后 tmp 已不存在；残留也不影响正确性 */
    });
  }
}

/**
 * 索引里的相对路径落回绝对路径。**resolve 后必须仍在 assets 目录内**：index.jsonl 是
 * 普通文本，改一行就能把 `file` 变成 `../../../etc/passwd`。越界一律抛（不是返回 null）——
 * 能走到这步说明索引已被污染，静默当作「没有这条」会让污染继续躺在那里。
 */
export function resolveAssetPath(file: string, dataDir: string): string {
  const root = path.resolve(researchAssetsDir(dataDir));
  const full = path.resolve(dataDir, file);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`研究素材路径越界，已拒绝：${file}`);
  }
  return full;
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * 存一张已下载的图片。**按 `(topicId, 规范化 sourceUrl)` 去重**：同一张图被同一选题的
 * 两个视角各挑一次只出一条记录（返回既有的那条，不重写文件也不追加索引）；换个选题
 * 再挑则**另立一条**——素材清单是按选题看的，别的选题存过不该让这条选题少一张。
 * 同内容不同源同样各自成记录（出处不同，授权与标注就不同），但共享同一个 hash 文件。
 */
export async function saveResearchAsset(
  input: NewResearchAsset,
  image: FetchedImage,
  dataDir: string,
): Promise<ResearchAsset> {
  assertTopicId(input.topicId);
  const existing = await findResearchAssetByUrl(input.topicId, input.sourceUrl, dataDir);
  if (existing) return existing;

  const name = contentName(image);
  const file = `${RESEARCH_DIR}/${ASSETS_DIR}/${FILES_DIR}/${name}`;
  await writeAssetFile(resolveAssetPath(file, dataDir), image.bytes);

  const asset: ResearchAsset = {
    assetId: `rasset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    topicId: input.topicId,
    file,
    format: image.format,
    width: image.width,
    height: image.height,
    bytes: image.bytes.length,
    sourceUrl: input.sourceUrl,
    sourcePageUrl: input.sourcePageUrl,
    caption: input.caption,
    capturedAt: new Date().toISOString(),
    status: "candidate",
    license: "unknown",
  };
  await appendIndex(asset, dataDir);
  return asset;
}

/** 某选题的全部素材（capturedAt 升序） */
export async function listResearchAssets(
  topicId: string,
  dataDir: string,
): Promise<ResearchAsset[]> {
  assertTopicId(topicId);
  return (await readAll(dataDir)).filter((a) => a.topicId === topicId);
}

/**
 * 在**某个选题内**按图片 URL 查已有素材。两侧都现算 `canonicalizeUrl`，不在记录上冗余
 * 存规范化字段——规范化规则一旦改，冗余字段就变成对不上的历史包袱（同 inbox 的做法）。
 * 命中多条时返回**最早**那条：引用要指向原件。
 */
export async function findResearchAssetByUrl(
  topicId: string,
  sourceUrl: string,
  dataDir: string,
): Promise<ResearchAsset | null> {
  const key = canonicalizeUrl(sourceUrl);
  if (!key) return null;
  const assets = await readAll(dataDir);
  return (
    assets.find((a) => a.topicId === topicId && canonicalizeUrl(a.sourceUrl) === key) ?? null
  );
}

/** 一条素材记录；无此 assetId 返回 null */
export async function getResearchAsset(
  assetId: string,
  dataDir: string,
): Promise<ResearchAsset | null> {
  return (await readAll(dataDir)).find((a) => a.assetId === assetId) ?? null;
}

/** 素材文件的绝对路径；无此 assetId 返回 null，路径越界抛（见 resolveAssetPath） */
export async function getResearchAssetFile(
  assetId: string,
  dataDir: string,
): Promise<string | null> {
  const asset = await getResearchAsset(assetId, dataDir);
  if (!asset) return null;
  return resolveAssetPath(asset.file, dataDir);
}

/**
 * 标记「这条候选被采用过」。**幂等**：已经是 imported 就原样返回，不追加重复行；
 * 无此 assetId 返回 null（调用方据此报「素材不存在」，不静默成功）。
 */
export async function markResearchAssetImported(
  assetId: string,
  dataDir: string,
): Promise<ResearchAsset | null> {
  const asset = await getResearchAsset(assetId, dataDir);
  if (!asset) return null;
  if (asset.status === "imported") return asset;
  const updated: ResearchAsset = { ...asset, status: "imported" };
  await appendIndex(updated, dataDir);
  return updated;
}
