/**
 * 简报素材的下载段（深调研 spec §7）：综合产出的 assetPicks 逐张下载入研究素材库。
 *
 * 四条纪律：
 * 1. **绝不影响 job 终态**：本模块**不抛**。一张图下不下来，跟这轮调研成不成功没关系——
 *    失败逐条降级成「仅链接」并把**人话原因**写进该条 pick（§7），简报照常发布。
 * 2. **预算是硬闸，三层同时算**：张数 / 累计字节 / 下载段总墙钟。任何一层触顶后，
 *    剩下的 pick 直接降级——不是静默丢弃，每条都带得到解释的 downloadError。
 *    单张的 timeout 还会按「剩余墙钟」收窄，一个吊死的连接拖不垮整段预算。
 * 3. **字节预算只能事后算**：图有多大要下完才知道，所以判据是「**已用**是否触顶」，
 *    单张 5MB 上限（fetchExternalImage 自带）把超出量钉死在一张图以内，如实记在这里。
 * 4. **全军覆没要点名**：一张都没存下来时返回一条 gap，由调用方并进 brief.gaps——
 *    「素材区空着」和「素材区被防盗链打光了」对写稿的人是两件事（§7）。
 */
import type { BriefAssetPick } from "./brief-store.js";
import { FetchImageError, fetchExternalImage } from "./fetch-image.js";
import { saveResearchAsset } from "./research-asset-store.js";

/** 每 job 最多下载的张数（超出的直接降级为仅链接） */
export const ASSET_DOWNLOAD_MAX_COUNT = 12;
/** 每 job 下载字节累计上限：30MB */
export const ASSET_DOWNLOAD_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
/** 下载段总墙钟上限：3 分钟 */
export const ASSET_DOWNLOAD_DEADLINE_MS = 3 * 60_000;
/** 单张下载的默认硬超时（与 fetchExternalImage 缺省一致，会被剩余墙钟进一步收窄） */
const PER_IMAGE_TIMEOUT_MS = 30_000;

export interface AssetDownloadOptions {
  dataDir: string;
  topicId: string;
  /** 测试注入；生产走真实出网 */
  fetchImageImpl?: typeof fetchExternalImage;
  now?: () => number;
  maxCount?: number;
  maxTotalBytes?: number;
  deadlineMs?: number;
}

export interface AssetDownloadResult {
  /** 与入参同序、同长度的 picks，成功的补 assetId，失败的补 downloadError */
  picks: BriefAssetPick[];
  storedCount: number;
  /** 全军覆没时的点名（并进 brief.gaps）；有任何一张存下来就没有 */
  gap?: string;
}

const BUDGET_SPENT = "本轮素材下载预算已用尽，这张只保留链接";

/** errorCode → 人话。写稿的人看到的是这句，不是 `http_403` */
function humanize(err: FetchImageError): string {
  const code = err.errorCode;
  if (code.startsWith("http_")) {
    const status = Number(code.slice("http_".length));
    if (status === 403 || status === 401) return "对方站点拒绝取图（多半是防盗链）";
    if (status === 404 || status === 410) return "图片链接已失效";
    return `对方站点返回 ${status}`;
  }
  switch (code) {
    case "invalid_url":
    case "unsupported_protocol":
      return "图片地址不合法";
    case "ssrf_blocked":
      return "图片地址指向内网，已拒绝";
    case "too_many_redirects":
      return "跳转次数过多";
    case "svg_rejected":
      return "SVG 属可执行内容，不入素材库";
    case "unsupported_format":
      return "格式不收（只要 PNG / JPEG / WebP）";
    case "bad_image":
      return "文件头解析不出图片，判为坏图";
    case "image_too_large":
      return "像素尺寸超出上限";
    case "body_too_large":
      return "文件超过 5MB 上限";
    case "timeout":
      return "下载超时";
    default:
      return "下载失败（网络或对方站点问题）";
  }
}

interface Budget {
  count: number;
  bytes: number;
  maxCount: number;
  maxTotalBytes: number;
  deadlineAt: number;
  now: () => number;
}

/** 三层预算的统一判据：任一层触顶都返回剩余墙钟 <= 0 或直接 null */
function remainingMs(b: Budget): number {
  return b.deadlineAt - b.now();
}

function overBudget(b: Budget): boolean {
  return b.count >= b.maxCount || b.bytes >= b.maxTotalBytes || remainingMs(b) <= 0;
}

/** 下一张：成功回 assetId，失败回人话原因。**不抛** */
async function downloadOne(
  pick: BriefAssetPick,
  budget: Budget,
  opts: AssetDownloadOptions,
): Promise<BriefAssetPick> {
  const fetchImage = opts.fetchImageImpl ?? fetchExternalImage;
  try {
    const image = await fetchImage(pick.url, {
      timeoutMs: Math.max(1, Math.min(PER_IMAGE_TIMEOUT_MS, remainingMs(budget))),
    });
    budget.count += 1;
    budget.bytes += image.bytes.length;
    const asset = await saveResearchAsset(
      {
        topicId: opts.topicId,
        // 登记跟随全部重定向后的最终 URL，不是最初那个可能已换站的链接
        sourceUrl: image.finalUrl,
        sourcePageUrl: pick.sourcePageUrl,
        caption: pick.caption,
      },
      image,
      opts.dataDir,
    );
    return { ...pick, assetId: asset.assetId };
  } catch (err) {
    if (err instanceof FetchImageError) return { ...pick, downloadError: humanize(err) };
    // 存盘失败（磁盘满/权限）同样只降级这一张：简报不为一张图陪葬
    return { ...pick, downloadError: "存入素材库失败，只保留链接" };
  }
}

/**
 * 逐张下载并入库。返回的 picks 与入参同序同长——**降级不是删除**，
 * 每一条都要么带 assetId 要么带 downloadError，界面上不会凭空少一张。
 */
export async function downloadBriefAssets(
  picks: BriefAssetPick[],
  opts: AssetDownloadOptions,
): Promise<AssetDownloadResult> {
  const now = opts.now ?? Date.now;
  const budget: Budget = {
    count: 0,
    bytes: 0,
    maxCount: opts.maxCount ?? ASSET_DOWNLOAD_MAX_COUNT,
    maxTotalBytes: opts.maxTotalBytes ?? ASSET_DOWNLOAD_MAX_TOTAL_BYTES,
    deadlineAt: now() + (opts.deadlineMs ?? ASSET_DOWNLOAD_DEADLINE_MS),
    now,
  };

  const out: BriefAssetPick[] = [];
  for (const pick of picks) {
    out.push(
      overBudget(budget) ? { ...pick, downloadError: BUDGET_SPENT } : await downloadOne(pick, budget, opts),
    );
  }

  const storedCount = out.filter((p) => p.assetId).length;
  return {
    picks: out,
    storedCount,
    ...(picks.length > 0 && storedCount === 0
      ? { gap: `${picks.length} 张素材候选一张都没能下载（防盗链或网络问题），简报里只剩链接` }
      : {}),
  };
}
