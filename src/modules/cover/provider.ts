/**
 * 封面生图 provider(V5.6.1 创始人裁决:默认走中转 image2,Gemini 保留为可选)。
 * cover.json 存 provider 选择与模型覆盖;中转凭证不另配——复用 publish.json 的
 * 生图 Key/端点(公众号配图同一条,已实战验证)。模块层实现,desktop 与 MCP 工具共用。
 * key 权限 0600,renderer 永远只见掩码。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { loadWechatMpConfig } from "../publish/wechat-config.js";

export type CoverProvider = "relay" | "gemini";
export type CoverGeminiModel = "auto" | "gemini-native" | "imagen-4";

export interface CoverSettings {
  /** 缺省 relay(中转 image2) */
  provider?: CoverProvider;
  /** 中转生图模型覆盖;缺省 publish.json imageModel,再缺省 gpt-image-2 */
  relayModel?: string;
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

export interface ResolvedCoverProvider {
  provider: CoverProvider;
  /** 中转凭证(publish.json);未配齐 = null */
  relay: { apiKey: string; baseUrl: string; model: string } | null;
  gemini: { apiKey: string | null; model: CoverGeminiModel; source: "file" | "env" | "none" };
  /** 当前选中的 provider 是否可用 */
  ok: boolean;
  hint?: string;
}

export const RELAY_HINT = "中转生图未配置——设置·发布 填「生图 Key + 生图端点」(公众号配图同一条);或在 设置·封面生成 切到 Gemini";
export const GEMINI_HINT = "Gemini Key 未配置——设置·封面生成 填入(免费获取:https://aistudio.google.com/apikey);或切回中转 image2";

export async function resolveCoverProvider(dataDir?: string): Promise<ResolvedCoverProvider> {
  const cfg = await loadCoverSettings(dataDir);
  const provider: CoverProvider = cfg.provider ?? "relay";
  const wechat = await loadWechatMpConfig(dataDir).catch(() => ({}) as { imageApiKey?: string; imageBaseUrl?: string; imageModel?: string });
  const relay =
    wechat.imageApiKey && wechat.imageBaseUrl
      ? { apiKey: wechat.imageApiKey, baseUrl: wechat.imageBaseUrl, model: cfg.relayModel ?? wechat.imageModel ?? "gpt-image-2" }
      : null;
  const envKey = process.env.GEMINI_API_KEY || null;
  const gemini = {
    apiKey: cfg.geminiApiKey ?? envKey,
    model: cfg.geminiModel ?? ("auto" as CoverGeminiModel),
    source: (cfg.geminiApiKey ? "file" : envKey ? "env" : "none") as "file" | "env" | "none",
  };
  const ok = provider === "relay" ? relay !== null : gemini.apiKey !== null;
  return { provider, relay, gemini, ok, ...(ok ? {} : { hint: provider === "relay" ? RELAY_HINT : GEMINI_HINT }) };
}
