/**
 * 深调研素材下载器（深调研 spec §7）。信任边界同收件箱抓取：URL 出自模型读过的外部
 * 页面，不是与本机同信任级的用户输入——所以走同一条加固链（协议白名单 → 每跳 SSRF
 * 复检 → ≤5 跳 → 流式封顶 → 硬超时），骨架直接复用 `utils/guarded-fetch`。
 *
 * 图片侧多三道裁决：
 * 1. **magic bytes 说了算**：Content-Type 只是门票（`image/*` 才放进来），真正定格式的是
 *    文件头。「标成 image/png、体是 SVG」是最省事的一招，只信 header 等于不设防。
 * 2. **SVG 明确拒绝**：SVG 是可执行文档（script / 外链 / entity），落进素材库后只要被
 *    渲染就是主动内容。Content-Type 与内容任一路命中即拒，给独立错误码 `svg_rejected`——
 *    简报里要能点名说「这张是 SVG，不收」，不能混进笼统的格式不符里。
 * 3. **白名单只有 PNG/JPEG/WebP**：GIF/BMP/AVIF/HEIC 一律 unsupported_format。收窄的代价
 *    是偶尔漏一张图（该素材降级「仅链接」），放宽的代价是解析面变大——素材不缺这一张。
 *
 * 残余风险（显式接受，同 spec §7「不引新图像依赖、不做真实解码」）：
 * (a) 像素尺寸从**格式头**读，不解码。构造样本可以让头里写 100×100、实际像素巨大，
 *     从而穿过 6000 上限；本模块不解码所以自身无损，但**下游任何缩放/转码环节才是
 *     解码炸弹的真实暴露面**，那一层必须自带像素与内存上限，不能假定这里已经挡住。
 * (b) 不校验像素数据完整性：截断或花屏的图这里照收，要到渲染时才看得出来。
 * (c) JPEG 只扫 SOF0/1/2（基线/扩展顺序/渐进），其余 SOF 变体（无损、算术编码）判
 *     bad_image —— 真实网页里近乎绝迹，宁可漏收一张也不扩大解析分支。
 */
import {
  fetchFollowingRedirects,
  type FetchImpl,
  type LookupFn,
} from "../../utils/guarded-fetch.js";

/** 与 fetch-external 的码集对齐（同名同义），图片侧另加四个格式/尺寸码 */
export type FetchImageErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "ssrf_blocked"
  | "too_many_redirects"
  | "unsupported_format"
  | "svg_rejected"
  | "bad_image"
  | "image_too_large"
  | "body_too_large"
  | "timeout"
  | "fetch_failed"
  | `http_${number}`;

export class FetchImageError extends Error {
  constructor(
    readonly errorCode: FetchImageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FetchImageError";
  }
}

export type ImageFormat = "png" | "jpeg" | "webp";

export interface FetchedImage {
  bytes: Buffer;
  format: ImageFormat;
  width: number;
  height: number;
  /** 跟随全部重定向后的最终 URL —— 素材登记用它，不是最初那个短链 */
  finalUrl: string;
}

export interface FetchImageOptions {
  /** 全流程硬超时，默认 30_000ms（覆盖全部跳数与读体） */
  timeoutMs?: number;
  /** 响应体字节上限，默认 5MB，超限即断连 */
  maxBytes?: number;
  /** 重定向上限，默认 5 跳 */
  maxRedirects?: number;
  /** 仅测试注入：让环回测试服在 SSRF 守卫眼中呈现为公网地址 */
  lookup?: LookupFn;
  /** 仅测试注入：模拟传输层故障 */
  fetchImpl?: FetchImpl;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
/** 任一边超过即拒：解码炸弹面的粗闸（6000×6000 已经比任何配图需求大一个量级） */
export const MAX_IMAGE_SIDE_PX = 6000;

const REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 AutoCrew/1.0",
  accept: "image/png,image/jpeg,image/webp,image/*;q=0.8",
};

// ─── 格式判定（magic bytes 是裁决，Content-Type 只是门票）────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function detectFormat(b: Buffer): ImageFormat | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  if (b.length >= 3 && b.subarray(0, 3).equals(JPEG_MAGIC)) return "jpeg";
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * 内容层的 SVG 判定：BOM/空白穿透后以 `<?xml` 或 `<svg` 开头即判。
 * 更花哨的开头（注释、DOCTYPE 打头）不在这里认——它们过不了 magic bytes，
 * 会落到 unsupported_format，同样是拒绝，只是码不同。
 */
function looksLikeSvg(b: Buffer): boolean {
  // BOM 用转义序列写，别把真实字节嵌进源码（隐形字符对 grep 与 review 都不可见）
  const head = b.subarray(0, 256).toString("utf-8").replace(/^\uFEFF/, "").trimStart();
  return /^<\?xml/i.test(head) || /^<svg\b/i.test(head);
}

/** Content-Type 门票：不合格返回要抛的错误，合格返回 null */
function ticketError(header: string | null): FetchImageError | null {
  const mime = (header ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "image/svg+xml" || mime === "image/svg") {
    return new FetchImageError("svg_rejected", `SVG 属主动内容，不入素材库：${mime}`);
  }
  if (!mime.startsWith("image/")) {
    return new FetchImageError(
      "unsupported_format",
      `Content-Type 不是图片：${header ?? "(缺失)"}`,
    );
  }
  return null;
}

// ─── 像素尺寸（只读格式头，不解码）──────────────────────────────────────────

interface Dimensions {
  width: number;
  height: number;
}

/** IHDR 必须是第一个 chunk（PNG 规范强制）：类型对不上就是坏文件，不去后面找 */
function pngDimensions(b: Buffer): Dimensions | null {
  if (b.length < 24 || b.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** 基线 / 扩展顺序 / 渐进 —— 覆盖真实网页里的绝大多数 JPEG */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2]);
/** 无载荷标记：TEM/SOI/EOI/RSTn —— 把它们后两字节当长度读会把偏移带飞 */
const JPEG_STANDALONE = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

/** 逐段跳到 SOF：段边界对不上就判坏图，不猜、不扫描式碰运气 */
function jpegDimensions(b: Buffer): Dimensions | null {
  let at = 2; // 跳过 SOI
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++; // 段间填充字节，合法
      continue;
    }
    if (JPEG_STANDALONE.has(marker)) {
      at += 2;
      continue;
    }
    const len = b.readUInt16BE(at + 2);
    if (len < 2) return null;
    if (!JPEG_SOF.has(marker)) {
      at += 2 + len;
      continue;
    }
    // SOF 载荷：precision(1) height(2) width(2) …
    if (at + 8 >= b.length) return null;
    return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
  }
  return null;
}

/** 三种 WebP 头各读各的；chunk 类型不认识（动画 ANIM 等无画布头）判坏图 */
function webpDimensions(b: Buffer): Dimensions | null {
  const chunk = b.length >= 16 ? b.subarray(12, 16).toString("latin1") : "";
  if (chunk === "VP8 ") {
    // 有损：3 字节 frame tag + 3 字节同步码，随后各 14 位宽高（高 2 位是缩放，掩掉）
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // 无损：签名 0x2F + 32 位打包（宽 14 位、高 14 位，存的都是「实际值 - 1」）
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const packed = b.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // 扩展：flags(1) + reserved(3) 后是 24 位画布宽高（同样是「实际值 - 1」）
    if (b.length < 30) return null;
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function dimensionsOf(format: ImageFormat, bytes: Buffer): Dimensions | null {
  const size =
    format === "png"
      ? pngDimensions(bytes)
      : format === "jpeg"
        ? jpegDimensions(bytes)
        : webpDimensions(bytes);
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return size;
}

// ─── 读体与裁决 ─────────────────────────────────────────────────────────────

/** 流式读，字节封顶即断连——不允许先整体 arrayBuffer()。 */
async function readCappedBytes(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FetchImageError("body_too_large", `图片超过 ${maxBytes} 字节上限，已中止下载`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function readImage(res: Response, finalUrl: URL, maxBytes: number): Promise<FetchedImage> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FetchImageError(`http_${res.status}`, `上游返回 ${res.status}`);
  }
  const ticket = ticketError(res.headers.get("content-type"));
  if (ticket) {
    await res.body?.cancel().catch(() => {});
    throw ticket;
  }
  const bytes = await readCappedBytes(res, maxBytes);
  // 顺序不可换：先认 SVG 再认 magic —— 「Content-Type 谎报 image/png、体是 SVG」
  // 必须落到 svg_rejected（主动内容要被点名），而不是笼统的 unsupported_format
  if (looksLikeSvg(bytes)) {
    throw new FetchImageError("svg_rejected", "响应体是 SVG（主动内容），已拒绝");
  }
  const format = detectFormat(bytes);
  if (!format) {
    throw new FetchImageError(
      "unsupported_format",
      `文件头不属 PNG/JPEG/WebP（只认这三种）：${bytes.subarray(0, 8).toString("hex") || "(空响应)"}`,
    );
  }
  const size = dimensionsOf(format, bytes);
  if (!size) {
    throw new FetchImageError("bad_image", `${format} 文件头解析不出像素尺寸，判为坏图`);
  }
  if (size.width > MAX_IMAGE_SIDE_PX || size.height > MAX_IMAGE_SIDE_PX) {
    throw new FetchImageError(
      "image_too_large",
      `像素尺寸 ${size.width}×${size.height} 超过 ${MAX_IMAGE_SIDE_PX} 上限，已拒绝`,
    );
  }
  return { bytes, format, width: size.width, height: size.height, finalUrl: finalUrl.href };
}

function toImageError(err: unknown, timedOut: boolean): FetchImageError {
  if (err instanceof FetchImageError) return err;
  const name = err instanceof Error ? err.name : "";
  if (timedOut || name === "AbortError" || name === "TimeoutError") {
    return new FetchImageError("timeout", "图片下载超时");
  }
  return new FetchImageError(
    "fetch_failed",
    `图片下载失败：${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * 下载一张外部图片。失败一律抛 `FetchImageError`，带稳定 errorCode——
 * 调用方据此把该素材降级为「仅链接」并在简报里点名（spec §7）。
 */
export async function fetchExternalImage(
  url: string,
  opts: FetchImageOptions = {},
): Promise<FetchedImage> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const { res, finalUrl } = await fetchFollowingRedirects({
      url,
      maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      signal: controller.signal,
      headers: REQUEST_HEADERS,
      lookup: opts.lookup,
      fetchImpl: opts.fetchImpl,
      makeError: (code, message) => new FetchImageError(code, message),
    });
    return await readImage(res, finalUrl, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  } catch (err) {
    throw toImageError(err, timedOut);
  } finally {
    clearTimeout(timer);
  }
}
