/**
 * 引擎配置 — 进程内生成的 model provider 接入（PRD §9：国产模型 + 薄云中转）。
 * baseUrl 即未来的中转地址：dogfood 直连 DeepSeek，正式版改 engine.json 不改代码。
 * 优先级：<dataDir>/engine.json > 环境变量 > 默认值。key 永不入仓库。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

export type EngineProtocol = "openai" | "anthropic";

/**
 * 备用端点（DeepSeek 官方 API 兜底）：主端点重试烧完仍是可重试类错误时顶上本次调用。
 * 共用一套档位（强/快），不做 per-route 备用——主端点的 route 专属模型统一落到备用强档。
 */
export interface EngineFallbackConfig {
  baseUrl: string;
  apiKey: string;
  strongModel: string;
  fastModel: string;
  protocol: EngineProtocol;
}

export interface EngineConfig {
  apiKey: string;
  baseUrl: string;
  /** 核心生成（口播脚本） */
  strongModel: string;
  /** 过滤/排版/打标（后续计划消费） */
  fastModel: string;
  /** 任务级模型路由；未配置的任务继续使用 strongModel/fastModel。 */
  routes?: EngineRoutes;
  /**
   * 备用端点；未配置 = 主端点失败即报错（今天的行为）。
   * route 不单独配备用，resolveEngineRoute 原样继承顶层这一块。
   */
  fallback?: EngineFallbackConfig;
  /**
   * 上游协议:openai = /chat/completions(缺省);anthropic = /v1/messages
   * (Claude 系中转,创始人实际付费通道 2026-07-08)。loadEngineConfig 必解析;
   * 自动识别:sk-ant 前缀 key 或 baseUrl 含 claude/anthropic → anthropic。
   * 可选字段:手工构造的 config(测试/注入)缺省视为 openai。
   */
  protocol?: "openai" | "anthropic";
  /**
   * 运行日志落点(V5.6 可观测性):loadEngineConfig 必填;
   * 手工构造的 config(测试/注入)缺省 = 不落日志,引擎行为零变化。
   */
  dataDir?: string;
}

export type EngineRouteName = "writer" | "analytics" | "scout" | "codex";

export interface EngineRouteConfig {
  baseUrl: string;
  model: string;
  protocol?: "openai" | "anthropic";
  /** 可选模型清单，供设置页和后续模型选择器展示。 */
  models?: string[];
}

export interface EngineRoutes {
  writer?: EngineRouteConfig;
  analytics?: EngineRouteConfig;
  scout?: EngineRouteConfig;
  codex?: EngineRouteConfig;
}

export const ENGINE_ROUTE_PRESETS = {
  writer: {
    baseUrl: "https://code.newcli.com/claude/ultra",
    model: "claude-opus-4-8",
    protocol: "anthropic" as const,
  },
  analytics: {
    baseUrl: "https://code.newcli.com/claude/ultra",
    model: "claude-opus-4-8",
    protocol: "anthropic" as const,
  },
  scout: {
    baseUrl: "https://code.newcli.com/claude/ultra",
    model: "claude-sonnet-5",
    protocol: "anthropic" as const,
  },
  codex: {
    baseUrl: "https://code.newcli.com/codex/v1",
    model: "gpt-5.6-sol",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    protocol: "openai" as const,
  },
};

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

function inferProtocol(
  apiKey: string,
  baseUrl: string,
  explicit?: "openai" | "anthropic",
): "openai" | "anthropic" {
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  return apiKey.startsWith("sk-ant") || /claude|anthropic/i.test(baseUrl) ? "anthropic" : "openai";
}

function normalizeRoute(value: unknown): EngineRouteConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const route = value as Partial<EngineRouteConfig>;
  if (typeof route.baseUrl !== "string" || !route.baseUrl.trim()) return undefined;
  if (typeof route.model !== "string" || !route.model.trim()) return undefined;
  const models = Array.isArray(route.models)
    ? route.models.filter((m): m is string => typeof m === "string" && Boolean(m.trim())).map((m) => m.trim())
    : undefined;
  return {
    baseUrl: route.baseUrl.trim().replace(/\/+$/, ""),
    model: route.model.trim(),
    ...(route.protocol === "openai" || route.protocol === "anthropic" ? { protocol: route.protocol } : {}),
    ...(models?.length ? { models } : {}),
  };
}

/**
 * 备用端点解析。baseUrl/apiKey 缺任一 → 整块忽略并 warn 一行：
 * 半配的备用比没有更危险——等主端点真挂了才发现备用也打不通。
 * 模型档位缺省用 DeepSeek 官方两档；协议未填走与主端点同一套推断。
 */
function normalizeFallback(value: unknown): EngineFallbackConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    console.warn("[engine] engine.json 的 fallback 不是对象，已忽略备用端点");
    return undefined;
  }
  const fb = value as Partial<EngineFallbackConfig>;
  const baseUrl = typeof fb.baseUrl === "string" ? fb.baseUrl.trim().replace(/\/+$/, "") : "";
  const apiKey = typeof fb.apiKey === "string" ? fb.apiKey.trim() : "";
  if (!baseUrl || !apiKey) {
    console.warn("[engine] engine.json 的 fallback 缺 baseUrl 或 apiKey，已忽略备用端点：主端点失败将直接报错");
    return undefined;
  }
  const pick = (v: unknown, dflt: string) => (typeof v === "string" && v.trim() ? v.trim() : dflt);
  return {
    baseUrl,
    apiKey,
    strongModel: pick(fb.strongModel, ENGINE_DEFAULTS.strongModel),
    fastModel: pick(fb.fastModel, ENGINE_DEFAULTS.fastModel),
    protocol: inferProtocol(apiKey, baseUrl, fb.protocol),
  };
}

/**
 * 档位映射（纯函数）：请求的是主端点快档 → 备用快档；其余一律备用强档。
 * route 专属模型（如 writer 的 opus）也算强档——宁强勿弱，备用不许悄悄降质。
 * 未配置备用返回 undefined，调用方据此判定不切换。
 */
export function resolveFallbackModel(config: EngineConfig, requestedModel: string): string | undefined {
  const fb = config.fallback;
  if (!fb) return undefined;
  return requestedModel === config.fastModel ? fb.fastModel : fb.strongModel;
}

function normalizeRoutes(value: unknown): EngineRoutes | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const routes: EngineRoutes = {
    writer: normalizeRoute(input.writer),
    analytics: normalizeRoute(input.analytics),
    scout: normalizeRoute(input.scout),
    codex: normalizeRoute(input.codex),
  };
  return routes.writer || routes.analytics || routes.scout || routes.codex ? routes : undefined;
}

/**
 * 为指定任务选择独立端点/模型。路由共用主 API key，避免重复保存凭证；
 * 未配置时原样返回主引擎，兼容已有工作区和测试注入。
 */
export function resolveEngineRoute(
  config: EngineConfig,
  name: EngineRouteName,
  fallbackModel: string,
): { config: EngineConfig; model: string } {
  const route = config.routes?.[name];
  if (!route) return { config, model: fallbackModel };
  const baseUrl = route.baseUrl.replace(/\/+$/, "");
  return {
    config: {
      ...config,
      baseUrl,
      protocol: inferProtocol(config.apiKey, baseUrl, route.protocol),
    },
    model: route.model,
  };
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
  const protocol = inferProtocol(apiKey, baseUrl, fromFile.protocol);
  const routes = normalizeRoutes(fromFile.routes);
  const fallback = normalizeFallback(fromFile.fallback);
  return {
    apiKey,
    baseUrl,
    strongModel: fromFile.strongModel ?? ENGINE_DEFAULTS.strongModel,
    fastModel: fromFile.fastModel ?? ENGINE_DEFAULTS.fastModel,
    protocol,
    dataDir: getDataDir(dataDir),
    ...(routes ? { routes } : {}),
    ...(fallback ? { fallback } : {}),
  };
}
