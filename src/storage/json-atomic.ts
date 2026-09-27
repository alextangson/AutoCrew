// src/storage/json-atomic.ts
/**
 * 共享 JSON 原子读写（S2.8 conversation-store 抽出，S2.9 library-store 共用）。
 * 写入 temp+rename：进程中断不留半个 JSON；失败 best-effort 清理 tmp。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { assertManagedPathAvailable } from "./storage-roots.js";

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  assertManagedPathAvailable(filePath);
  const rnd = Math.random().toString(36).slice(2, 6);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${rnd}`;
  try {
    await fs.writeFile(tmp, content, "utf-8");
    assertManagedPathAvailable(filePath);
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  assertManagedPathAvailable(filePath);
  const rnd = Math.random().toString(36).slice(2, 6);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${rnd}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
    assertManagedPathAvailable(filePath);
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // best-effort cleanup, ignore unlink errors
    }
    throw err;
  }
}

/**
 * 项目目录里的写入：手动导入的项目只有 00-project/01-script 骨架，空子目录也会被同步盘/迁移丢掉，
 * 所以先建父目录。先过受管路径检查，挂载点不在时不会在本机凭空建目录。
 */
export async function writeJsonAtomicMkdir(filePath: string, value: unknown): Promise<void> {
  assertManagedPathAvailable(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeJsonAtomic(filePath, value);
}

export async function writeTextAtomicMkdir(filePath: string, content: string): Promise<void> {
  assertManagedPathAvailable(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeTextAtomic(filePath, content);
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}
