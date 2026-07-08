/**
 * 引擎设置 — 设置页「开发者区」的读写（PRD §7.3 个性化中心）。
 * 读：engine.json + env 回退，key 永远掩码返回（renderer 拿不到原文）。
 * 写：merge 进 <dataDir>/engine.json。dogfood 期的默认路径；终端用户
 * 版本此区折叠隐藏，积分中转上线后整区退役（§9）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ENGINE_DEFAULTS, type EngineConfig } from "../engine/config.js";
import { getDataDir } from "../storage/local-store.js";

function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function readEngineJson(dataDir?: string): Promise<{ filePath: string; fromFile: Partial<EngineConfig> }> {
  const filePath = path.join(getDataDir(dataDir), "engine.json");
  try {
    return { filePath, fromFile: JSON.parse(await fs.readFile(filePath, "utf-8")) as Partial<EngineConfig> };
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    return { filePath, fromFile: {} };
  }
}

export async function getEngineSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const { fromFile } = await readEngineJson((payload._dataDir as string) || undefined);
    const envKey = process.env.DEEPSEEK_API_KEY;
    const apiKey = fromFile.apiKey ?? (envKey || undefined);
    const source = fromFile.apiKey ? "file" : envKey ? "env" : "none";
    return {
      ok: true,
      data: {
        configured: Boolean(apiKey),
        source,
        apiKeyMasked: apiKey ? maskKey(apiKey) : null,
        baseUrl: fromFile.baseUrl ?? (process.env.DEEPSEEK_BASE_URL || undefined) ?? ENGINE_DEFAULTS.baseUrl,
        strongModel: fromFile.strongModel ?? ENGINE_DEFAULTS.strongModel,
        fastModel: fromFile.fastModel ?? ENGINE_DEFAULTS.fastModel,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 搜索 provider 配置读(V5.3):key 掩码返回,renderer 拿不到原文 */
export async function getSearchSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const { loadSearchConfig } = await import("../modules/research/search-provider.js");
    const cfg = await loadSearchConfig((payload._dataDir as string) || undefined);
    return {
      ok: true,
      data: cfg
        ? { configured: true, provider: cfg.provider, apiKeyMasked: maskKey(cfg.apiKey), baseUrl: cfg.baseUrl ?? null }
        : { configured: false, provider: null, apiKeyMasked: null, baseUrl: null },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 搜索 provider 配置写(V5.3):写 <dataDir>/search.json(600 权限) */
export async function setSearchSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const provider = payload.provider;
  if (provider !== "bocha" && provider !== "tavily") {
    return { ok: false, error: "provider 必须是 bocha 或 tavily" };
  }
  const apiKey = payload.api_key;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return { ok: false, error: "api_key 必须是非空字符串" };
  }
  const baseUrl = typeof payload.base_url === "string" && payload.base_url.trim() ? payload.base_url.trim() : undefined;
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const { saveSearchConfig } = await import("../modules/research/search-provider.js");
    await saveSearchConfig({ provider, apiKey: apiKey.trim(), ...(baseUrl ? { baseUrl } : {}) }, dataDir);
    return getSearchSettings({ _dataDir: dataDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setEngineSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const updates: Partial<EngineConfig> = {};
  const fields: Array<["apiKey" | "baseUrl" | "strongModel" | "fastModel", string]> = [
    ["apiKey", "api_key"],
    ["baseUrl", "base_url"],
    ["strongModel", "strong_model"],
    ["fastModel", "fast_model"],
  ];
  for (const [target, source] of fields) {
    const v = payload[source];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.trim() === "") {
      return { ok: false, error: `${source} 必须是非空字符串` };
    }
    updates[target] = v.trim();
  }
  // protocol 单独收(枚举校验,不走裸 string 路径);缺省由 loadEngineConfig 自动识别
  if (payload.protocol !== undefined) {
    if (payload.protocol !== "openai" && payload.protocol !== "anthropic") {
      return { ok: false, error: "protocol 必须是 openai 或 anthropic" };
    }
    updates.protocol = payload.protocol;
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "没有可写入的字段（api_key / base_url / strong_model / fast_model）" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const { filePath, fromFile } = await readEngineJson(dataDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ ...fromFile, ...updates }, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    return getEngineSettings({ _dataDir: dataDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
