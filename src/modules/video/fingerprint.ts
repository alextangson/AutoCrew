/**
 * 素材指纹（设计 spec §4.2）。
 *
 * A-roll 是**引用不复制**的（2GB 素材复制一份既慢又占盘），代价是原文件随时可能被
 * 改名/替换/剪掉一段——所以每个 phase 开跑前都要复检指纹，漂移就 `blocked: aroll_drifted`，
 * 由人确认后重转写或换文件，绝不拿旧转写去切新文件。
 *
 * **显式取舍**：quickHash 只读首 1MB + 末 1MB + 文件长度，不做全量 hash。
 * 覆盖「换文件 / 重新导出 / 截断」这些真实场景；**不覆盖**「长度不变、只改中间某几帧」
 * 这种理论情况——那需要全量读 2GB，每个 phase 都读一遍是不可接受的成本。
 * 这条盲区由单测钉住，别人改实现时会看见。
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AssetFingerprint } from "./types.js";

const CHUNK_BYTES = 1024 * 1024;
/** 小于两个 chunk 的文件首尾会重叠，索性整读——小文件全量 hash 不心疼 */
const WHOLE_FILE_LIMIT = CHUNK_BYTES * 2;

async function readAt(fh: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** `sha256(首1MB + 末1MB + size)`；<2MB 的文件整读 + size */
export async function quickHash(filePath: string): Promise<string> {
  const fh = await fs.open(filePath, "r");
  try {
    const { size } = await fh.stat();
    const hash = createHash("sha256");
    if (size <= WHOLE_FILE_LIMIT) {
      hash.update(await readAt(fh, 0, size));
    } else {
      hash.update(await readAt(fh, 0, CHUNK_BYTES));
      hash.update(await readAt(fh, size - CHUNK_BYTES, CHUNK_BYTES));
    }
    // 长度进 hash：首尾相同、中间长度不同的文件（如重复导出的不同码率）才区分得开
    hash.update(String(size));
    return hash.digest("hex");
  } finally {
    await fh.close();
  }
}

export async function fingerprintFile(filePath: string): Promise<AssetFingerprint> {
  const st = await fs.stat(filePath);
  return { size: st.size, mtimeMs: st.mtimeMs, quickHash: await quickHash(filePath) };
}

/**
 * 复检：文件不在了、读不了、或内容指纹对不上 → false。
 *
 * **不比 mtime**：把素材从备份盘拷回来、rsync 一次、Finder 拖动一下都会改 mtime，
 * 内容却一个字节没变。拿 mtime 阻断生产线等于制造假警报；mtime 只作为记录留在指纹里。
 */
export async function verifyFingerprint(
  filePath: string,
  fingerprint: AssetFingerprint,
): Promise<boolean> {
  try {
    const current = await fingerprintFile(filePath);
    return current.size === fingerprint.size && current.quickHash === fingerprint.quickHash;
  } catch {
    return false;
  }
}
