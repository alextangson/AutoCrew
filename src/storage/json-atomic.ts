// src/storage/json-atomic.ts
/**
 * 共享 JSON 原子读写（S2.8 conversation-store 抽出，S2.9 library-store 共用）。
 * 写入 temp+rename：进程中断不留半个 JSON；失败 best-effort 清理 tmp。
 */
import fs from "node:fs/promises";

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 6);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${rnd}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
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

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}
