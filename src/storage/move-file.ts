/**
 * 把库外文件挪进资料库（P6 §13.4-F「素材只写路径」，评审 #9）：挪，不复制——大素材不再占双份。
 *
 * 同卷直接 rename；跨卷先复制（不覆盖已有文件）、校验 sha256 一致再删源。删源失败不算失败，
 * 回 `sourceLeft` 让调用方照实说「原件还在」。挪完再算一次目标的 sha256：和挪之前不一致
 * （挪的途中源还在被写）就把目标删掉 / 挪回并报错，不登记一份没人核过的字节。
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { assertManagedPathAvailable } from "./storage-roots.js";

async function digestFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export interface MovedFile { sha256: string; sourceLeft: boolean }

const CHANGED = "素材在挪动时发生变化（可能还在写入），请等它写完再登记";

export async function moveFileVerified(src: string, dest: string): Promise<MovedFile> {
  assertManagedPathAvailable(dest);
  const st = await fs.lstat(src);
  if (!st.isFile()) throw new Error(`不是普通文件（符号链接或目录不收）：${src}`);
  if (await fs.lstat(dest).then(() => true, () => false)) throw new Error(`目标已存在，不覆盖：${dest}`);
  const sha256 = await digestFile(src);
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    return crossVolume(src, dest, sha256);
  }
  if (await digestFile(dest) !== sha256) {
    await fs.rename(dest, src).catch(() => undefined);
    throw new Error(CHANGED);
  }
  return { sha256, sourceLeft: false };
}

async function crossVolume(src: string, dest: string, sha256: string): Promise<MovedFile> {
  await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
  if (await digestFile(dest) !== sha256 || await digestFile(src) !== sha256) {
    await fs.rm(dest, { force: true });
    throw new Error(CHANGED);
  }
  const sourceLeft = await fs.rm(src).then(() => false, () => true);
  return { sha256, sourceLeft };
}
