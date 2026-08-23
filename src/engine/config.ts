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

/**
 * 用户自定义端点（设计 §Phase 4：端点即用户数据）。主端点与 fallback 是引擎默认档与
 * 自动兜底，providers 只是**额外**可选端点：只有对话切换器点名时才用到，
 * routes/写手席/analytics 一概不受影响。
 * id 由创建方生成一次并落盘（改名不重算）——切换器的选项 id 靠它稳定。
 */
export interface EngineProviderConfig {
  id: string;
  /** 显示名（切换器的 optgroup 标题）；缺省回落 id */
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: EngineProtocol;
  /** 至少一个；切换器按 端点 × 模型 展开 */
  models: string[];
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
   * 用户自定义端点（可选）；缺失/全非法 = 与今天完全一致（切换器只有四档）。
   * 读取路径逐条 fail-closed（见 normalizeProviders），永不因为一条坏配置拖垮引擎加载。
   */
  providers?: EngineProviderConfig[];
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

/** reviewer = AI 审稿 agent（审稿 spec §2.6）：未配置时落 strongModel——审稿是品味活，判错比慢贵 */
export type EngineRouteName = "writer" | "analytics" | "scout" | "codex" | "reviewer";

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
  reviewer?: EngineRouteConfig;
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
  reviewer: {
    baseUrl: "https://code.newcli.com/claude/ultra",
    model: "claude-opus-4-8",
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

/** 自定义端点 id 的字符集：切换器的选项 id 是 `p:<id>:<model>`，冒号定界要求 id 里不能有冒号 */
export const PROVIDER_ID_RE = /^[a-z0-9-]{1,32}$/;

/**
 * 端点 baseUrl 归一化（读取与写入两路共用同一把尺）：
 * 只认 http/https、禁 userinfo（账密会随日志外泄）/查询串/锚点、去尾斜杠；
 * localhost 显式放行——本地跑的模型服务是常见形态。
 * 返回 null = 不合法（读取路径丢弃该条，写入路径拒绝整次提交）。
 */
export function normalizeProviderBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (!url.hostname) return null;
  return url.href.replace(/\/+$/, "");
}

/**
 * 自定义端点解析（**读取路径**：逐条 fail-closed，坏的丢掉、好的照用）。
 * 三条纪律：
 * 1. id 格式非法 / baseUrl 非法 / 缺 apiKey / models 为空 → 丢弃该条并 warn 一行。
 * 2. **重复 id 全部失效**：首赢还是末赢都是静默换端点，最贵的那种失败——两条都丢。
 * 3. 全程不 throw：一条坏端点不该让整个引擎起不来。
 * 写入路径是另一套规矩（settings:set 整份原子校验，不逐条丢弃——那会丢用户数据）。
 */
export function normalizeProviders(value: unknown): EngineProviderConfig[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    console.warn("[engine] engine.json 的 providers 不是数组，已忽略全部自定义端点");
    return undefined;
  }
  // 先数一遍 id：重复的整组失效，不进解析
  const counts = new Map<string, number>();
  for (const item of value) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id === "string" && PROVIDER_ID_RE.test(id.trim())) {
      const key = id.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const warnedDup = new Set<string>();
  const parsed: EngineProviderConfig[] = [];
  for (const [i, item] of value.entries()) {
    const at = `第 ${i + 1} 条自定义端点`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      console.warn(`[engine] ${at}不是对象，已丢弃`);
      continue;
    }
    const p = item as Partial<EngineProviderConfig>;
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!PROVIDER_ID_RE.test(id)) {
      console.warn(`[engine] ${at}的 id 不合法（只允许小写字母/数字/连字符，1–32 位），已丢弃`);
      continue;
    }
    if ((counts.get(id) ?? 0) > 1) {
      if (!warnedDup.has(id)) {
        console.warn(`[engine] 自定义端点 id「${id}」重复，同 id 的条目全部失效——请在设置里改成唯一 id`);
        warnedDup.add(id);
      }
      continue;
    }
    const baseUrl = normalizeProviderBaseUrl(p.baseUrl);
    if (!baseUrl) {
      console.warn(`[engine] 自定义端点「${id}」的 baseUrl 不合法（只支持 http/https，且不能带账密/查询串/锚点），已丢弃`);
      continue;
    }
    const apiKey = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
    if (!apiKey) {
      console.warn(`[engine] 自定义端点「${id}」缺 apiKey，已丢弃`);
      continue;
    }
    const models = Array.isArray(p.models)
      ? p.models.filter((m): m is string => typeof m === "string" && Boolean(m.trim())).map((m) => m.trim())
      : [];
    if (!models.length) {
      console.warn(`[engine] 自定义端点「${id}」没有可用模型（models 至少要有一个），已丢弃`);
      continue;
    }
    parsed.push({
      id,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : id,
      baseUrl,
      apiKey,
      protocol: inferProtocol(apiKey, baseUrl, p.protocol),
      models,
    });
  }
  return parsed.length ? parsed : undefined;
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
    reviewer: normalizeRoute(input.reviewer),
  };
  return routes.writer || routes.analytics || routes.scout || routes.codex || routes.reviewer
    ? routes
    : undefined;
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

export async function loadEngineConfig(dataDir?: string): Promise<EngineConfig> {
  let fromFile: Partial<EngineConfig> = {};
  const filePath = await resolveEngineConfigPath(dataDir);
  try {
    fromFile = parseEngineJson(await fs.readFile(filePath, "utf-8"), filePath);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
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
  const providers = normalizeProviders(fromFile.providers);
  return {
    apiKey,
    baseUrl,
    strongModel: fromFile.strongModel ?? ENGINE_DEFAULTS.strongModel,
    fastModel: fromFile.fastModel ?? ENGINE_DEFAULTS.fastModel,
    protocol,
    dataDir: getDataDir(dataDir),
    ...(routes ? { routes } : {}),
    ...(fallback ? { fallback } : {}),
    ...(providers ? { providers } : {}),
  };
}
