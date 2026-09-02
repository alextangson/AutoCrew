/**
 * 插件配置。Schemastery 在 `apply` 之前校验并填好默认值，所以下面每个字段进到
 * apply 时一定存在。字段与 AutoCrew 的 PluginConfig 一一对应（那边是 snake_case，
 * dsh/cordis 这边是 camelCase，映射放在 toPluginConfig）。
 */
import z from "@deepseek-ai/schemastery";
import type { PluginConfig } from "../../../src/runtime/context.js";

export interface Config {
  /** 本地数据目录。留空 = `~/.autocrew`。 */
  dataDir: string;
  /** AutoCrew Pro key（深度抓取、竞品监控、数据分析）。留空 = 免费版。 */
  proApiKey: string;
  /** Pro 服务地址。留空 = 官方默认。 */
  proApiUrl: string;
  /** 平台抓取用的浏览器 CDP 代理地址。留空 = 不启用。 */
  cdpProxyUrl: string;
  /** 封面生成用的 Gemini key。留空 = 不生成封面。 */
  geminiApiKey: string;
  /** 图像模型档位：auto / gemini-native / imagen-4。 */
  geminiModel: string;
  /**
   * 是否把自带的 `autocrew` agent preset 装进 `$DSH_HOME/.agent-presets/`。
   * 默认开——launcher 覆盖了 preset 根，这是 preset 唯一的到达路径（见
   * preset-install.ts）。部署方想自己管 preset 目录时关掉它。
   */
  installPreset: boolean;
}

export const Config: z<Config> = z.object({
  dataDir: z.string().default(""),
  proApiKey: z.string().default(""),
  proApiUrl: z.string().default(""),
  cdpProxyUrl: z.string().default(""),
  geminiApiKey: z.string().default(""),
  geminiModel: z.string().default(""),
  installPreset: z.boolean().default(true),
});

/** 空字符串 = 未配置，要丢掉而不是当成空值传下去——AutoCrew 靠 falsy 走自己的默认。 */
export function toPluginConfig(config: Config): PluginConfig {
  const mapped: PluginConfig = {};
  if (config.dataDir) mapped.data_dir = config.dataDir;
  if (config.proApiKey) mapped.pro_api_key = config.proApiKey;
  if (config.proApiUrl) mapped.pro_api_url = config.proApiUrl;
  if (config.cdpProxyUrl) mapped.cdp_proxy_url = config.cdpProxyUrl;
  if (config.geminiApiKey) mapped.gemini_api_key = config.geminiApiKey;
  if (config.geminiModel) mapped.gemini_model = config.geminiModel;
  return mapped;
}
