/**
 * 纯 Node PNG 垂直居中裁切(node:zlib,零新依赖——仓库刻意保持单运行时依赖)。
 * 场景:Gemini 原生只有 21:9/16:9 等比例,公众号封面要 2.35:1——宽度不动,
 * 裁掉上下多余行。PNG 行滤波依赖上一行,必须先解滤波、切行、再以 filter 0 重编码。
 * 支持 8-bit 非隔行的灰度(0)/RGB(2)/灰度+alpha(4)/RGBA(6);其余抛 PngUnsupportedError,
 * 调用方(wide-crop)降级为交付未裁切原图。
 */
import zlib from "node:zlib";

export class PngUnsupportedError extends Error {}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
const COLOR_TYPE_BY_CHANNELS: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  /** 解滤波后的原始行(每行 width×channels 字节) */
  rows: Buffer[];
}

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngUnsupportedError("不是 PNG 文件");
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height || idat.length === 0) throw new PngUnsupportedError("PNG 结构不完整");
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (bitDepth !== 8 || channels === undefined || interlace !== 0) {
    throw new PngUnsupportedError(`不支持的 PNG 形态(bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { width, height, channels, rows: unfilterRows(raw, width, height, channels) };
}

function unfilterRows(raw: Buffer, width: number, height: number, channels: number): Buffer[] {
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new PngUnsupportedError("像素数据长度不符");
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    const row = Buffer.from(raw.subarray(base + 1, base + 1 + stride));
    applyUnfilter(filter, row, prev, channels);
    rows.push(row);
    prev = row;
  }
  return rows;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function applyUnfilter(filter: number, row: Buffer, prev: Buffer, bpp: number): void {
  if (filter === 0) return;
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = prev[i];
    const upLeft = i >= bpp ? prev[i - bpp] : 0;
    if (filter === 1) row[i] = (row[i] + left) & 0xff;
    else if (filter === 2) row[i] = (row[i] + up) & 0xff;
    else if (filter === 3) row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
    else if (filter === 4) row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
    else throw new PngUnsupportedError(`未知滤波类型 ${filter}`);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crcBuf]);
}

/** 以 filter 0 编码(输出给平台/浏览器,不追求压缩率) */
export function encodePng(width: number, height: number, channels: number, rows: Buffer[]): Buffer {
  const colorType = COLOR_TYPE_BY_CHANNELS[channels];
  if (colorType === undefined) throw new PngUnsupportedError(`不支持的通道数 ${channels}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rows[y].copy(raw, y * (stride + 1) + 1, 0, stride);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 垂直居中裁切到目标宽高比(宽度不变);目标高 ≥ 原高时原样返回。 */
export function cropPngVerticalCenter(buf: Buffer, targetAspect: number): Buffer {
  const { width, height, channels, rows } = decodePng(buf);
  const targetHeight = Math.round(width / targetAspect);
  if (targetHeight >= height) return buf;
  const top = Math.floor((height - targetHeight) / 2);
  return encodePng(width, targetHeight, channels, rows.slice(top, top + targetHeight));
}
