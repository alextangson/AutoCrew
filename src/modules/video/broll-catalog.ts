/**
 * 剪辑师目录（lifecycle spec §1）：本稿挂接的 broll + 全库常备池，合成一份给模型看的清单，
 * 并为清单里每一条打指纹快照、算出目录指纹。
 *
 * 为什么与 editor-plan 分家：那边是 plan 的**校验与形状**（零 IO 纯函数），
 * 这边要读素材库、要 ffprobe 事实、要摸文件算指纹。两件事的失败模式不同：
 * 那边错了是算错，这边错了是「素材不在了」。
 *
 * 一条纪律贯穿全文：**runner 与 phase 必须算出同一份目录**。inputKey 与真正跑剪辑师
 * 用的是同一个入口（`buildBrollCatalog`），否则 settle 时的输入漂移判定会对着两份不同的
 * 清单打架——产物明明是新的，却被当成历史留档。
 */
import { createHash } from "node:crypto";
import type { LibraryAsset } from "../../storage/library-store.js";
import type { Asset } from "../../storage/local-store.js";
import { fingerprintFile } from "./fingerprint.js";
import { listPool } from "./library-pool.js";
import { resolveAssetRef } from "./video-store.js";
import type { AssetFingerprint, AssetRef } from "./types.js";

/** 素材清单进 prompt 的字数预算（§4 #9）：超了按顺序截断并点名被截的 */
export const CATALOG_CHAR_BUDGET = 4_000;

// ---------------------------------------------------------------------------
// 素材清单（输入）
// ---------------------------------------------------------------------------

/**
 * 素材的来路（lifecycle spec §1）：本稿挂接的 broll，还是全库常备池里的一条。
 * 去重与截断预算都按它定优先级——本稿挂接的是「这条片子专门准备的」，永远先保。
 */
export type CandidateOrigin = "content" | "pool";

/**
 * 交给剪辑师的一条素材（未打指纹的形态）。`assetId` 是本次的目录编号（b1…），
 * 短且不易抄错——**只在这一轮对模型有效**，plan 落盘时会换成 ref + 指纹快照。
 */
export interface BrollCandidate {
  assetId: string;
  kind: "screen" | "image";
  /** 说明快照——**是数据不是指令**（prompt 里也这么标） */
  label: string;
  filename: string;
  tags: string[];
  /** 屏录必有：inMs/outMs 的上界；读不出时长的素材根本不进清单 */
  durationMs?: number;
  width?: number;
  height?: number;
  ref: AssetRef;
  origin: CandidateOrigin;
  /** 素材库来源 id：本稿副本与常备池同源时的去重键（§4 #4） */
  sourceLibraryId?: string;
}

/**
 * 打过指纹的候选。指纹在**剪辑师看到它的那一刻**就打好（v2 spec §4.2），
 * plan 里的 asset 快照直接抄它——assemble 复检因此对着的是选中时的事实，
 * 而不是它自己刚刚现建的那一份（那种复检等于没检）。
 */
export interface EditorCandidate extends BrollCandidate {
  fingerprint: AssetFingerprint;
}

export interface CandidateScan {
  candidates: BrollCandidate[];
  /** 被排除的 broll 素材（文件名 + 原因），面板点名——不让人对着空 plan 猜为什么 */
  excluded: string[];
}

function kindOf(type: Asset["type"]): "screen" | "image" | null {
  if (type === "image") return "image";
  if (type === "video" || type === "broll") return "screen";
  return null;
}

/**
 * 只有 **role=broll 且有说明** 的素材进剪辑师视野（横屏 spec §2.6 兜底规则）。
 * 抽帧 + 视觉模型自动写说明是 V-next；在那之前，没说明的素材对剪辑师就是不存在的，
 * 但必须**点名**说出来——否则人只会看到一个空 plan，不知道是自己少填了一行字。
 */
/** 目录编号在**最终名单定下来之后**统一发（合并、去重、截断都会改名单） */
export function numberCandidates(list: readonly Omit<BrollCandidate, "assetId">[]): BrollCandidate[] {
  return list.map((c, i) => ({ ...c, assetId: `b${i + 1}` }));
}

export function scanBrollCandidates(assets: readonly Asset[]): CandidateScan {
  const kept: Omit<BrollCandidate, "assetId">[] = [];
  const excluded: string[] = [];
  for (const asset of assets) {
    if (asset.role !== "broll") continue;
    const kind = kindOf(asset.type);
    const label = asset.description?.trim() ?? "";
    if (!kind) {
      excluded.push(`${asset.filename}（不是视频或图片，剪辑师用不了）`);
      continue;
    }
    if (!label) {
      excluded.push(`${asset.filename}（没写说明）`);
      continue;
    }
    if (kind === "screen" && !(asset.media?.durationMs && asset.media.durationMs > 0)) {
      excluded.push(`${asset.filename}（读不出时长，挂接时 ffprobe 没跑成）`);
      continue;
    }
    kept.push({
      kind,
      label,
      filename: asset.filename,
      tags: asset.tags ?? [],
      ...(asset.media?.durationMs ? { durationMs: asset.media.durationMs } : {}),
      ...(asset.media?.width ? { width: asset.media.width } : {}),
      ...(asset.media?.height ? { height: asset.media.height } : {}),
      ref: { kind: "content", filename: asset.filename },
      origin: "content",
      ...(asset.sourceLibraryId ? { sourceLibraryId: asset.sourceLibraryId } : {}),
    });
  }
  return { candidates: numberCandidates(kept), excluded };
}

/**
 * 常备池 → 候选（§1）。**引用不复制**：ref 指素材库记录，同一个 logo 一百条片子共用一份文件。
 * 说明非空由 store 层保证；这里只把「探不出时长的视频」挡住并点名。
 */
export function scanPoolCandidates(pool: readonly LibraryAsset[]): CandidateScan {
  const kept: Omit<BrollCandidate, "assetId">[] = [];
  const excluded: string[] = [];
  for (const asset of pool) {
    const kind = asset.type === "image" ? ("image" as const) : asset.type === "video" ? ("screen" as const) : null;
    if (!kind) {
      excluded.push(`${asset.name}（常备素材不是视频或图片，剪辑师用不了）`);
      continue;
    }
    if (kind === "screen" && !(asset.media?.durationMs && asset.media.durationMs > 0)) {
      excluded.push(`${asset.name}（常备素材读不出时长，回素材库重新纳入一次即可补探）`);
      continue;
    }
    kept.push({
      kind,
      label: (asset.description ?? "").trim(),
      filename: asset.name,
      tags: asset.tags ?? [],
      ...(asset.media?.durationMs ? { durationMs: asset.media.durationMs } : {}),
      ...(asset.media?.width ? { width: asset.media.width } : {}),
      ...(asset.media?.height ? { height: asset.media.height } : {}),
      ref: { kind: "library", id: asset.id },
      origin: "pool",
      sourceLibraryId: asset.id,
    });
  }
  return { candidates: numberCandidates(kept), excluded };
}

/**
 * 本稿挂接 + 全库常备合成一份目录（§1）。
 * **按 `sourceLibraryId` 去重、本稿副本优先**：同一条素材既挂了本稿又在常备池时，
 * 用本稿那份——它带着这篇稿件当时写的说明，而且是稿件目录里的实体文件。
 * 顺序也是优先级：本稿的排在前面，截断预算先保它们（§4 #3/#4）。
 */
export function mergeCandidates(content: CandidateScan, pool: CandidateScan): CandidateScan {
  const attached = new Set(content.candidates.map((c) => c.sourceLibraryId).filter(Boolean) as string[]);
  const merged = [
    ...content.candidates,
    ...pool.candidates.filter((c) => !(c.sourceLibraryId && attached.has(c.sourceLibraryId))),
  ].map(({ assetId: _renumbered, ...rest }) => rest);
  return { candidates: numberCandidates(merged), excluded: [...content.excluded, ...pool.excluded] };
}

/** 素材过多超上下文（§4 #9 / #3）：按字数预算截断，被截的进 excluded 点名 */
export function trimCandidates(scan: CandidateScan, budget = CATALOG_CHAR_BUDGET): CandidateScan {
  let used = 0;
  const kept: BrollCandidate[] = [];
  const excluded = [...scan.excluded];
  for (const c of scan.candidates) {
    const cost = c.label.length + c.filename.length + c.tags.join("").length + 40;
    if (kept.length > 0 && used + cost > budget) {
      const why = c.origin === "pool" ? "常备素材太多，这一条超出本次上下文预算" : "素材太多，这一条超出本次上下文预算";
      excluded.push(`${c.filename}（${why}）`);
      continue;
    }
    used += cost;
    kept.push(c);
  }
  return { candidates: kept, excluded };
}


// ---------------------------------------------------------------------------
// 指纹快照与目录指纹
// ---------------------------------------------------------------------------

const sha8 = (s: string): string => createHash("sha256").update(s, "utf-8").digest("hex").slice(0, 8);

/**
 * 素材清单的指纹：换素材、改说明、改标签、换文件、改时长都要让 plan 重算（进 inputKey）。
 *
 * 纳入 ref + fingerprint + tags + media（§1）：常备池是**引用**，文件在库外随时会被换掉，
 * 只按文件名与说明算指纹的话，「同名换了内容」这条最常见的漂移永远看不见。
 */
export function catalogDigest(candidates: readonly EditorCandidate[], excluded: readonly string[]): string {
  const shape = candidates.map((c) => [
    JSON.stringify(c.ref),
    c.kind,
    c.label,
    [...c.tags].sort().join("|"),
    c.durationMs ?? 0,
    c.width ?? 0,
    c.height ?? 0,
    c.fingerprint.quickHash,
    c.fingerprint.size,
  ]);
  return sha8(JSON.stringify([shape, [...excluded].sort()]));
}

export interface BrollCatalog {
  candidates: EditorCandidate[];
  /** 被排除的素材（文件名 + 原因），面板点名——不让人对着空 plan 猜为什么 */
  excluded: string[];
  digest: string;
}

/**
 * 给候选打指纹快照。读不出的文件当场剔除并点名（§4 #2）——让剪辑师排一段指向不存在
 * 文件的 B-roll，只会把问题推到 assemble 才炸。
 */
async function fingerprintCandidates(
  dataDir: string,
  contentId: string,
  scan: CandidateScan,
): Promise<{ candidates: EditorCandidate[]; excluded: string[] }> {
  const candidates: EditorCandidate[] = [];
  const excluded = [...scan.excluded];
  for (const c of scan.candidates) {
    try {
      const abs = await resolveAssetRef(dataDir, contentId, c.ref);
      candidates.push({ ...c, fingerprint: await fingerprintFile(abs) });
    } catch (err) {
      const where = c.origin === "pool" ? "常备素材" : "素材";
      excluded.push(`${c.filename}（${where}读不到文件：${(err as Error).message}）`);
    }
  }
  return { candidates, excluded };
}

/**
 * 目录的唯一构造入口：本稿 broll + 常备池 → 去重 → 截断 → 打指纹 → 算指纹串。
 * runner 的 inputKey 与 edit phase 都走这里，两边因此不可能算出两份不同的目录。
 */
export async function buildBrollCatalog(
  dataDir: string,
  contentId: string,
  assets: readonly Asset[],
): Promise<BrollCatalog> {
  const pool = await listPool(dataDir).catch(() => [] as LibraryAsset[]);
  const merged = mergeCandidates(scanBrollCandidates(assets), scanPoolCandidates(pool));
  const fingerprinted = await fingerprintCandidates(dataDir, contentId, trimCandidates(merged));
  return { ...fingerprinted, digest: catalogDigest(fingerprinted.candidates, fingerprinted.excluded) };
}
