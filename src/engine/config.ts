/**
 * 引擎配置 — 进程内生成的 model provider 接入（PRD §9：国产模型 + 薄云中转）。
 * baseUrl 即未来的中转地址：dogfood 直连 DeepSeek，正式版改 engine.json 不改代码。
 * 优先级：<dataDir>/engine.json > 环境变量 > 默认值。key 永不入仓库。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

export interface EngineConfig {
  apiKey: string;
  baseUrl: string;
  /** 核心生成（口播脚本） */
  strongModel: string;
  /** 过滤/排版/打标（后续计划消费） */
  fastModel: string;
}

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  strongModel: "deepseek-v4-pro",
  fastModel: "deepseek-v4-flash",
};

function parseEngineJson(raw: string, filePath: string): Partial<EngineConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`engine.json 解析失败（${filePath}）：${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`engine.json 解析失败（${filePath}）：不是 JSON 对象`);
  }
  return parsed as Partial<EngineConfig>;
}

export async function loadEngineConfig(dataDir?: string): Promise<EngineConfig> {
  let fromFile: Partial<EngineConfig> = {};
  const filePath = path.join(getDataDir(dataDir), "engine.json");
  try {
    fromFile = parseEngineJson(await fs.readFile(filePath, "utf-8"), filePath);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  const apiKey = fromFile.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "引擎未配置 model provider：设置环境变量 DEEPSEEK_API_KEY，或在 ~/.autocrew/engine.json 写入 {\"apiKey\": \"...\"}",
    );
  }
  return {
    apiKey,
    baseUrl: fromFile.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULTS.baseUrl,
    strongModel: fromFile.strongModel ?? DEFAULTS.strongModel,
    fastModel: fromFile.fastModel ?? DEFAULTS.fastModel,
  };
}
