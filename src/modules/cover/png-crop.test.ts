/**
 * png-crop.test.ts — 纯函数 PNG 编解码与垂直居中裁切
 */
import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { encodePng, decodePng, cropPngVerticalCenter, cropPngCenterToAspect, PngUnsupportedError, crc32 } from "./png-crop.js";

function gradientRows(width: number, height: number, channels: number): Buffer[] {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * channels);
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) row[x * channels + c] = (x * 3 + y * 7 + c * 13) & 0xff;
    }
    rows.push(row);
  }
  return rows;
}

/** 测试侧的 chunk 构造(与实现独立,用于手工拼非常规 PNG) */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crcBuf]);
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildPng(width: number, height: number, bitDepth: number, colorType: number, interlace: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 正向滤波(测试自产滤波数据,验证 decode 的解滤波) */
function filterRow(type: number, row: Buffer, prev: Buffer, bpp: number): Buffer {
  const out = Buffer.alloc(row.length);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = prev[i];
    const upLeft = i >= bpp ? prev[i - bpp] : 0;
    if (type === 1) out[i] = (row[i] - left) & 0xff;
    else if (type === 2) out[i] = (row[i] - up) & 0xff;
    else if (type === 3) out[i] = (row[i] - ((left + up) >> 1)) & 0xff;
    else if (type === 4) out[i] = (row[i] - paeth(left, up, upLeft)) & 0xff;
    else out.set(row);
  }
  return out;
}

describe("png-crop 编解码", () => {
  it("decode(encode(x)) 往返一致(RGB)", () => {
    const rows = gradientRows(20, 12, 3);
    const decoded = decodePng(encodePng(20, 12, 3, rows));
    expect(decoded).toMatchObject({ width: 20, height: 12, channels: 3 });
    for (let y = 0; y < 12; y++) expect(decoded.rows[y].equals(rows[y])).toBe(true);
  });

  it.each([1, 2, 3, 4])("滤波类型 %i 能正确解滤波", (ft) => {
    const width = 9, height = 5, channels = 3;
    const rows = gradientRows(width, height, channels);
    const stride = width * channels;
    const raw = Buffer.alloc(height * (stride + 1));
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = ft;
      filterRow(ft, rows[y], prev, channels).copy(raw, y * (stride + 1) + 1);
      prev = rows[y];
    }
    const decoded = decodePng(buildPng(width, height, 8, 2, 0, raw));
    for (let y = 0; y < height; y++) expect(decoded.rows[y].equals(rows[y])).toBe(true);
  });

  it("16-bit 位深 → PngUnsupportedError", () => {
    const raw = Buffer.alloc(5 * (4 * 3 * 2 + 1));
    expect(() => decodePng(buildPng(4, 5, 16, 2, 0, raw))).toThrow(PngUnsupportedError);
  });

  it("隔行扫描 → PngUnsupportedError;非 PNG → PngUnsupportedError", () => {
    const raw = Buffer.alloc(5 * (4 * 3 + 1));
    expect(() => decodePng(buildPng(4, 5, 8, 2, 1, raw))).toThrow(PngUnsupportedError);
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(PngUnsupportedError);
  });
});

describe("cropPngVerticalCenter", () => {
  it("21:9 → 2.35:1(宽不变、裁中间行,RGBA)", () => {
    const rows = gradientRows(210, 90, 4);
    const out = decodePng(cropPngVerticalCenter(encodePng(210, 90, 4, rows), 2.35));
    expect(out.width).toBe(210);
    expect(out.height).toBe(Math.round(210 / 2.35)); // 89
    const top = Math.floor((90 - out.height) / 2);
    expect(out.rows[0].equals(rows[top])).toBe(true);
    expect(out.rows[out.height - 1].equals(rows[top + out.height - 1])).toBe(true);
  });

  it("16:9 兜底源也能裁(高度 ≈76%)", () => {
    const rows = gradientRows(160, 90, 3);
    const out = decodePng(cropPngVerticalCenter(encodePng(160, 90, 3, rows), 2.35));
    expect(out.width).toBe(160);
    expect(out.height).toBe(Math.round(160 / 2.35)); // 68
  });

  it("已达目标比例 → 原 buffer 原样返回", () => {
    const buf = encodePng(235, 100, 3, gradientRows(235, 100, 3));
    expect(cropPngVerticalCenter(buf, 2.35)).toBe(buf);
  });
});

describe("cropPngCenterToAspect(任意方向)", () => {
  it("目标更宽 → 裁行(与垂直裁同径)", () => {
    const rows = gradientRows(160, 90, 3);
    const out = decodePng(cropPngCenterToAspect(encodePng(160, 90, 3, rows), 2.35));
    expect(out.width).toBe(160);
    expect(out.height).toBe(Math.round(160 / 2.35));
  });

  it("目标更窄 → 裁列(宽度变,中间列保留;中转 3:2 → 4:3 场景)", () => {
    const width = 15, height = 10, channels = 3;
    const rows = gradientRows(width, height, channels);
    const out = decodePng(cropPngCenterToAspect(encodePng(width, height, channels, rows), 4 / 3));
    const targetWidth = Math.round(height * (4 / 3)); // 13
    expect(out.height).toBe(height);
    expect(out.width).toBe(targetWidth);
    const left = Math.floor((width - targetWidth) / 2);
    for (let y = 0; y < height; y++) {
      expect(out.rows[y].equals(rows[y].subarray(left * channels, (left + targetWidth) * channels))).toBe(true);
    }
  });

  it("2:3 竖图 → 3:4(中转封面主场景):1024x1536 → 1024x1365", () => {
    const out = decodePng(cropPngCenterToAspect(encodePng(64, 96, 3, gradientRows(64, 96, 3)), 3 / 4));
    expect(out.width).toBe(64);
    expect(out.height).toBe(Math.round(64 / (3 / 4))); // 85
  });

  it("已达比例 → 原样返回", () => {
    const buf = encodePng(40, 30, 3, gradientRows(40, 30, 3));
    expect(cropPngCenterToAspect(buf, 4 / 3)).toBe(buf);
  });
});
