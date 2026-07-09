/**
 * 封面生成配置(cover.json):桌面路径的 Gemini key 存取。
 * 背景:desktop 的 /api/invoke 会 sanitize 掉 renderer 侧的 _ 前缀键,
 * MCP/插件路径的 geminiConfigMiddleware 又不经过 desktop——所以桌面要自己的
 * key 槽位,由 handler 在 server 端注入(可信),renderer 永远拿不到原文。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

export type CoverGeminiModel = "auto" | "gemini-native" | "imagen-4";

export interface CoverSettings {
  geminiApiKey?: string;
  geminiModel?: CoverGeminiModel;
}

const FILE = "cover.json";

export async function loadCoverSettings(dataDir?: string): Promise<CoverSettings> {
  try {
    return JSON.parse(await fs.readFile(path.join(getDataDir(dataDir), FILE), "utf-8")) as CoverSettings;
  } catch {
    return {};
  }
}

export async function saveCoverSettings(updates: CoverSettings, dataDir?: string): Promise<CoverSettings> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, FILE);
  const merged = { ...(await loadCoverSettings(dataDir)), ...updates };
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return merged;
}

/** key 解析:cover.json → env GEMINI_API_KEY → 无 */
export async function resolveCoverGemini(
  dataDir?: string,
): Promise<{ apiKey: string | null; model: CoverGeminiModel; source: "file" | "env" | "none" }> {
  const cfg = await loadCoverSettings(dataDir);
  const model = cfg.geminiModel ?? "auto";
  if (cfg.geminiApiKey) return { apiKey: cfg.geminiApiKey, model, source: "file" };
  const env = process.env.GEMINI_API_KEY;
  if (env) return { apiKey: env, model, source: "env" };
  return { apiKey: null, model, source: "none" };
}
