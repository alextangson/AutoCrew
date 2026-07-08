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
  /**
   * 上游协议:openai = /chat/completions(缺省);anthropic = /v1/messages
   * (Claude 系中转,创始人实际付费通道 2026-07-08)。loadEngineConfig 必解析;
   * 自动识别:sk-ant 前缀 key 或 baseUrl 含 claude/anthropic → anthropic。
   * 可选字段:手工构造的 config(测试/注入)缺省视为 openai。
   */
  protocol?: "openai" | "anthropic";
}

export const ENGINE_DEFAULTS = {
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
    // 多工作区:子工作区（<default>/workspaces/ 下,即注册表创建的）没有自己的 engine.json 时
    // 回退默认工作区——同一个人,key 不用配两遍。判据收紧到 workspaces/ 前缀:
    // 任意外部 dataDir（MCP 调用方/测试临时目录）不得静默回退偷读用户真实 key。
    const workspacesRoot = path.join(getDataDir(), "workspaces") + path.sep;
    if (getDataDir(dataDir).startsWith(workspacesRoot)) {
      const defaultPath = path.join(getDataDir(), "engine.json");
      try {
        fromFile = parseEngineJson(await fs.readFile(defaultPath, "utf-8"), defaultPath);
      } catch (fallbackErr) {
        if ((fallbackErr as { code?: string }).code !== "ENOENT") throw fallbackErr;
      }
    }
  }
  const apiKey = fromFile.apiKey ?? (process.env.DEEPSEEK_API_KEY || undefined);
  if (!apiKey) {
    throw new Error(
      "引擎未配置 model provider：设置环境变量 DEEPSEEK_API_KEY，或在 ~/.autocrew/engine.json 写入 {\"apiKey\": \"...\"}",
    );
  }
  const baseUrl = fromFile.baseUrl ?? (process.env.DEEPSEEK_BASE_URL || undefined) ?? ENGINE_DEFAULTS.baseUrl;
  const protocol =
    fromFile.protocol === "anthropic" || fromFile.protocol === "openai"
      ? fromFile.protocol
      : apiKey.startsWith("sk-ant") || /claude|anthropic/i.test(baseUrl)
        ? "anthropic"
        : "openai";
  return {
    apiKey,
    baseUrl,
    strongModel: fromFile.strongModel ?? ENGINE_DEFAULTS.strongModel,
    fastModel: fromFile.fastModel ?? ENGINE_DEFAULTS.fastModel,
    protocol,
  };
}
