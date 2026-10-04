/**
 * 写稿上下文里的传播方法页（传播方法规格 §10）：只读 <资料库>/craft/method.md，最多 6000 字。
 * 拆解卡和原始抓取一律不进写稿上下文。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";

export const METHOD_MAX_CHARS = 6000;

export interface CraftMethod { text: string | null; note: string | null; error: string | null }

export async function loadCraftMethod(dataDir?: string): Promise<CraftMethod> {
  const file = path.join(getDataDir(dataDir), "craft", "method.md");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { text: null, note: "还没有拆解库（资料库里没有 craft/method.md）；照常写，但要告诉创始人", error: null };
    return { text: null, note: null, error: `方法页读不了：${(e as Error).message}` };
  }
  const chars = Array.from(raw.trim());
  if (!chars.length) return { text: null, note: "还没有拆解库（craft/method.md 是空的）；照常写，但要告诉创始人", error: null };
  if (chars.length <= METHOD_MAX_CHARS) return { text: chars.join(""), note: null, error: null };
  return { text: chars.slice(0, METHOD_MAX_CHARS).join(""), note: `方法页超过 ${METHOD_MAX_CHARS} 字，只附了前 ${METHOD_MAX_CHARS} 字`, error: null };
}
