/**
 * 引擎配置读取入口（PRD §9：国产模型 + 薄云中转）。
 *
 * v2 起只有**一张端点表**：主端点、备用、岗位、聊天切换器全部按 id 指过去，密钥只存一份
 * （P2 spec §3）。老的 v1 文件（顶层 key + routes + fallback + providers 四处各填一遍）
 * 在**内存里**迁移成 v2，第一次保存时才写回磁盘（settings-engine.ts 负责备份与原子写）。
 *
 * 优先级：<dataDir>/engine.json > 环境变量 > 默认值。key 永不入仓库。
 * 分工：形状与尺子在 config-schema.ts，迁移在 config-migrate.ts，校验与投影在 config-validate.ts。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";
import { parseProviderTable, type EngineConfig, type EngineProviderConfig, type EngineRouteName } from "./config-schema.js";
import { migrateEngineConfig } from "./config-migrate.js";
import { projectEngineConfig, validateEngineGraph } from "./config-validate.js";

export {
  ENGINE_DEFAULTS,
  ENGINE_ROLE_LABELS,
  ENGINE_ROLE_NAMES,
  PROVIDER_ID_RE,
  hostOf,
  normalizeProviderBaseUrl,
  parseProviderTable,
  type EngineAssignment,
  type EngineAssignments,
  type EngineConfig,
  type EngineConfigV2,
  type EngineFallbackConfig,
  type EngineGraphDraft,
  type EnginePointer,
  type EngineProtocol,
  type EngineProviderConfig,
  type EngineRouteName,
} from "./config-schema.js";
export { migrateEngineConfig, type MigrationResult } from "./config-migrate.js";
export { projectEngineConfig, sameFamilyWarning, validateEngineGraph, type ValidationOutcome } from "./config-validate.js";

/** 未配置时的口径：终端用户看命令行提示，设置页会把它换成人话（settings-engine.ts） */
export const ENGINE_UNCONFIGURED =
  "引擎未配置 model provider：设置环境变量 DEEPSEEK_API_KEY，或在 ~/.autocrew/engine.json 写入 {\"apiKey\": \"...\"}";

function parseEngineJson(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`engine.json 解析失败（${filePath}）：${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`engine.json 解析失败（${filePath}）：不是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * 端点表解析的**读取路径**包装：逐条 fail-closed，坏的丢掉并 warn 一行、好的照用。
 * 一条坏端点不该让整个引擎起不来；写入路径是另一套规矩（整份原子校验）。
 */
export function normalizeProviders(value: unknown): EngineProviderConfig[] | undefined {
  const warnings: string[] = [];
  const parsed = parseProviderTable(value, warnings);
  for (const w of warnings) console.warn(`[engine] ${w}`);
  return parsed.length ? parsed : undefined;
}

/**
 * 档位映射（纯函数）：请求的是主端点快档 → 备用快档；其余一律备用强档。
 * 岗位专属模型（如 writer 的 opus）也算强档——宁强勿弱，备用不许悄悄降质。
 * 未配置备用返回 undefined，调用方据此判定不切换。
 */
export function resolveFallbackModel(config: EngineConfig, requestedModel: string): string | undefined {
  const fb = config.fallback;
  if (!fb) return undefined;
  return requestedModel === config.fastModel ? fb.fastModel : fb.strongModel;
}

/**
 * 为指定岗位选择端点/模型。**保留名字与返回形状**（调用点把 `.config` 直接喂 runLoop）：
 * 唯一的新东西是返回的 config 上带 `activeProvider: {id, role}`——P2a-2 的健康归因据此定位
 * 是哪条线在说话，调用点零改动。
 * 未分配的岗位原样返回主端点 + 传入的兜底模型（与 v1 的 miss 语义一致）。
 */
export function resolveEngineRoute(
  config: EngineConfig,
  name: EngineRouteName,
  fallbackModel: string,
): { config: EngineConfig; model: string } {
  const mainId = config.activeProvider?.id ?? "main";
  const assigned = config.assignments?.[name];
  const provider = assigned ? (config.providers ?? []).find((p) => p.id === assigned.provider) : undefined;
  if (!assigned || !provider) {
    return { config: { ...config, activeProvider: { id: mainId, role: name } }, model: fallbackModel };
  }
  return {
    config: {
      ...config,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      protocol: provider.protocol,
      activeProvider: { id: provider.id, role: name },
    },
    model: assigned.model,
  };
}

/**
 * 本次**实际生效**的 engine.json 路径（"打开配置文件"入口据此打开，不能打开继承前的空路径）。
 * 多工作区:子工作区（<default>/workspaces/ 下,即注册表创建的）没有自己的 engine.json 时
 * 回退默认工作区——同一个人,key 不用配两遍。判据收紧到 workspaces/ 前缀:
 * 任意外部 dataDir（MCP 调用方/测试临时目录）不得静默回退偷读用户真实 key。
 * 两处都没有文件时返回本工作区的路径——那正是保存时会写入的位置。
 */
export async function resolveEngineConfigPath(dataDir?: string): Promise<string> {
  const filePath = path.join(getDataDir(dataDir), "engine.json");
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    /* 本工作区没有,看看能不能继承默认工作区 */
  }
  const workspacesRoot = path.join(getDataDir(), "workspaces") + path.sep;
  if (getDataDir(dataDir).startsWith(workspacesRoot)) {
    const defaultPath = path.join(getDataDir(), "engine.json");
    try {
      await fs.access(defaultPath);
      return defaultPath;
    } catch {
      /* 默认工作区也没有 */
    }
  }
  return filePath;
}

/** engine.json 的原始 JSON（没有文件 = `{}`）——读取与写入两路共用同一把读法 */
export async function readEngineFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    return parseEngineJson(await fs.readFile(filePath, "utf-8"), filePath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    throw err;
  }
}

export function engineEnv(): { apiKey?: string | undefined; baseUrl?: string | undefined } {
  return { apiKey: process.env.DEEPSEEK_API_KEY || undefined, baseUrl: process.env.DEEPSEEK_BASE_URL || undefined };
}

export async function loadEngineConfig(dataDir?: string): Promise<EngineConfig> {
  const filePath = await resolveEngineConfigPath(dataDir);
  const raw = await readEngineFile(filePath);
  const migrated = migrateEngineConfig(raw, engineEnv());
  const outcome = validateEngineGraph(migrated.draft);
  const warnings = [...migrated.warnings, ...outcome.warnings];
  for (const w of warnings) console.warn(`[engine] ${w}`);
  // 主端点不成立 = 整份未配置。抛的是既有那句（调用点的错误分支一个字不改）
  if (!outcome.config) throw new Error(ENGINE_UNCONFIGURED);
  return projectEngineConfig(outcome.config, { dataDir: getDataDir(dataDir), warnings });
}
