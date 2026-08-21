/**
 * 引擎设置 — 设置页「开发者区」的读写（PRD §7.3 个性化中心）。
 * 读：engine.json + env 回退，key 永远掩码返回（renderer 拿不到原文）。
 * 写：merge 进 <dataDir>/engine.json。dogfood 期的默认路径；终端用户
 * 版本此区折叠隐藏，积分中转上线后整区退役（§9）。
 *
 * 两种落盘根，别混：本文件的 engine/search/publish 都走**工作区** <dataDir>
 * （server 端从注册表解析后注入 _dataDir）；收件箱走**全局根** ~/.autocrew/，
 * 不随工作区切换，因此单独放 settings-inbox.ts（下方原样转出，设置页从这里取）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  ENGINE_DEFAULTS,
  ENGINE_ROUTE_PRESETS,
  type EngineConfig,
  type EngineRouteConfig,
  type EngineRouteName,
} from "../engine/config.js";
import { getDataDir } from "../storage/local-store.js";
import { mergeProviders, providerViews } from "./settings-providers.js";

// 自定义端点的逃生门（打开实际生效的 engine.json）——设置页统一从 settings.ts 取
export { openEngineConfigFile } from "./settings-providers.js";

// 收件箱设置（全局根 ~/.autocrew/inbox.json，不随工作区）——设置面统一从 settings.ts 取
export {
  getInboxSettings,
  setInboxSettings,
  getInboxSettingsRaw,
  onInboxSettingsChanged,
  type InboxSettings,
} from "./settings-inbox.js";

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
        routes: {
          writer: fromFile.routes?.writer ?? null,
          analytics: fromFile.routes?.analytics ?? null,
          scout: fromFile.routes?.scout ?? null,
          codex: fromFile.routes?.codex ?? null,
        },
        routePresets: ENGINE_ROUTE_PRESETS,
        // 自定义端点:无 key 无掩码,只回"配没配"——掩码遇上数组整体替换会被当真值写回去
        providers: providerViews(fromFile.providers),
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

/** 发布配置读(V5.6 设置收口):publish.json 可视化,key 掩码 */
export async function getPublishSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const { loadWechatMpConfig } = await import("../modules/publish/wechat-config.js");
    const { listWechatThemes } = await import("../modules/publish/wechat-themes.js");
    const cfg = await loadWechatMpConfig((payload._dataDir as string) || undefined);
    return {
      ok: true,
      data: {
        imageConfigured: Boolean(cfg.imageApiKey),
        imageApiKeyMasked: cfg.imageApiKey ? maskKey(cfg.imageApiKey) : null,
        imageBaseUrl: cfg.imageBaseUrl ?? null,
        // 选题雷达 X 源 key:只回状态与掩码
        xConfigured: Boolean(cfg.xApiKey),
        xApiKeyMasked: cfg.xApiKey ? maskKey(cfg.xApiKey) : null,
        imageModel: cfg.imageModel ?? null,
        // 生图通道链:回显时抹掉 key,只留够认人的字段——设置页要能看清链的顺序
        imageChain: (cfg.imageChain ?? []).map((f) => ({
          name: f.name ?? null,
          kind: f.kind ?? "relay",
          baseUrl: f.baseUrl ?? null,
          apiKeyMasked: f.apiKey ? maskKey(f.apiKey) : null,
          model: f.model ?? null,
          dialect: f.dialect ?? "openai",
        })),
        theme: cfg.theme ?? null,
        themes: await listWechatThemes(),
        author: cfg.author ?? null,
        // 代理串含账密,只回状态不回显
        apiProxyConfigured: Boolean(cfg.apiProxy),
        // 公众号绑定(给别人用的可视化配置):secret 永不回显,只回状态与掩码 appid
        wechatConfigured: Boolean(cfg.wechatAppId && cfg.wechatAppSecret),
        wechatAppIdMasked: cfg.wechatAppId ? maskKey(cfg.wechatAppId) : null,
        openComment: cfg.openComment === true,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface ParsedImageProvider {
  name?: string;
  kind?: "relay" | "codex";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dialect?: "openai" | "ark";
}

/**
 * 生图通道链:设置页传 JSON 文本(一条链最多几家,JSON 比自造行格式可靠)。
 * 解析失败要说清是哪一条坏了——生图链配错的代价是故障时才发现,那时已经太迟。
 * codex 通道不需要凭证(借本地 Codex CLI 的 ChatGPT 订阅),所以只对 relay 查 baseUrl/apiKey。
 */
export function parseImageChain(raw: unknown): { value: ParsedImageProvider[] } | { error: string } {
  let list: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return { value: [] };
    try {
      list = JSON.parse(text);
    } catch (err) {
      return { error: `生图通道链 JSON 解析失败：${(err as Error).message}` };
    }
  }
  if (!Array.isArray(list)) {
    return { error: "生图通道链必须是数组，例如 [{\"kind\":\"codex\"},{\"baseUrl\":\"...\",\"apiKey\":\"...\"}]" };
  }
  const value: ParsedImageProvider[] = [];
  for (const [i, item] of list.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { error: `第 ${i + 1} 条通道不是对象` };
    }
    const f = item as Record<string, unknown>;
    const kind = f.kind === undefined ? "relay" : f.kind;
    if (kind !== "relay" && kind !== "codex") {
      return { error: `第 ${i + 1} 条通道的 kind 只能是 relay（中转）或 codex（本地 Codex CLI）` };
    }
    const name = typeof f.name === "string" && f.name.trim() ? f.name.trim() : undefined;
    if (kind === "codex") {
      value.push({ ...(name ? { name } : {}), kind: "codex" });
      continue;
    }
    if (typeof f.baseUrl !== "string" || !f.baseUrl.trim()) return { error: `第 ${i + 1} 条通道缺 baseUrl` };
    if (typeof f.apiKey !== "string" || !f.apiKey.trim()) return { error: `第 ${i + 1} 条通道缺 apiKey` };
    if (f.dialect !== undefined && f.dialect !== "openai" && f.dialect !== "ark") {
      return { error: `第 ${i + 1} 条通道的 dialect 只能是 openai 或 ark（即梦/火山 Seedream 用 ark）` };
    }
    value.push({
      ...(name ? { name } : {}),
      kind: "relay",
      baseUrl: f.baseUrl.trim(),
      apiKey: f.apiKey.trim(),
      ...(typeof f.model === "string" && f.model.trim() ? { model: f.model.trim() } : {}),
      ...(f.dialect ? { dialect: f.dialect as "openai" | "ark" } : {}),
    });
  }
  return { value };
}

/** 发布配置写:merge 进 <dataDir>/publish.json 的 wechatMp 段(600 权限,key 不回显) */
export async function setPublishSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const updates: Record<string, string | boolean> = {};
  const fields: Array<[string, string]> = [
    ["imageApiKey", "image_api_key"],
    ["imageBaseUrl", "image_base_url"],
    ["imageModel", "image_model"],
    ["theme", "theme"],
    ["author", "author"],
    ["apiProxy", "api_proxy"],
    ["wechatAppId", "wechat_app_id"],
    ["wechatAppSecret", "wechat_app_secret"],
    ["xApiKey", "x_api_key"],
  ];
  for (const [target, source] of fields) {
    const v = payload[source];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.trim() === "") {
      return { ok: false, error: `${source} 必须是非空字符串` };
    }
    updates[target] = v.trim();
  }
  // 备用生图通道链:整条替换(不是 merge)——链的顺序就是降级顺序,半更新会让顺序不可预期。
  // 空串=不改(设置页每次提交都会带上这个字段,当成清空会把链默默删掉);要清空请显式填 []。
  const rawFallbacks = payload.image_chain;
  if (rawFallbacks !== undefined && !(typeof rawFallbacks === "string" && rawFallbacks.trim() === "")) {
    const parsed = parseImageChain(rawFallbacks);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    (updates as Record<string, unknown>).imageChain = parsed.value;
  }
  // 留言开关是布尔:GUI 下拉传 "1"/"0"
  if (payload.open_comment !== undefined) {
    const v = payload.open_comment;
    if (v === "1" || v === true) updates.openComment = true;
    else if (v === "0" || v === false) updates.openComment = false;
    else return { ok: false, error: 'open_comment 必须是 "1"(开) 或 "0"(关)' };
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "没有可写入的字段（image_api_key / image_base_url / image_model / theme / author / wechat_app_id / wechat_app_secret / x_api_key / open_comment）" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const { getDataDir } = await import("../storage/local-store.js");
    const filePath = path.join(getDataDir(dataDir), "publish.json");
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
    } catch { /* 首次 */ }
    const wechatMp = { ...((existing.wechatMp as Record<string, unknown>) ?? {}), ...updates };
    await fs.writeFile(filePath, JSON.stringify({ ...existing, wechatMp }, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    return getPublishSettings({ _dataDir: dataDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const engineSettingsListeners: Array<() => void> = [];

/** 引擎配置保存成功后的通知（收件箱 runtime 用它唤醒 blocked 项）；返回退订函数 */
export function onEngineSettingsChanged(cb: () => void): () => void {
  engineSettingsListeners.push(cb);
  return () => {
    const at = engineSettingsListeners.indexOf(cb);
    if (at >= 0) engineSettingsListeners.splice(at, 1);
  };
}

function notifyEngineSettingsChanged(): void {
  for (const cb of [...engineSettingsListeners]) {
    try {
      cb();
    } catch {
      // 监听者的异常不该让保存失败
    }
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
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const { filePath, fromFile } = await readEngineJson(dataDir);
    const routes = { ...(fromFile.routes ?? {}) };
    const routeFields: Array<{
      name: EngineRouteName;
      baseField: string;
      modelField: string;
      protocol: "openai" | "anthropic";
    }> = [
      { name: "writer", baseField: "writer_base_url", modelField: "writer_model", protocol: "anthropic" },
      { name: "analytics", baseField: "analytics_base_url", modelField: "analytics_model", protocol: "anthropic" },
      { name: "scout", baseField: "scout_base_url", modelField: "scout_model", protocol: "anthropic" },
      { name: "codex", baseField: "codex_base_url", modelField: "codex_model", protocol: "openai" },
    ];
    for (const spec of routeFields) {
      const baseInput = payload[spec.baseField];
      const modelInput = payload[spec.modelField];
      if (baseInput === undefined && modelInput === undefined) continue;
      if (baseInput !== undefined && (typeof baseInput !== "string" || !baseInput.trim())) {
        return { ok: false, error: `${spec.baseField} 必须是非空字符串` };
      }
      if (modelInput !== undefined && (typeof modelInput !== "string" || !modelInput.trim())) {
        return { ok: false, error: `${spec.modelField} 必须是非空字符串` };
      }
      const existing = routes[spec.name] as EngineRouteConfig | undefined;
      const preset = ENGINE_ROUTE_PRESETS[spec.name];
      routes[spec.name] = {
        baseUrl: (typeof baseInput === "string" ? baseInput.trim() : existing?.baseUrl ?? preset.baseUrl).replace(/\/+$/, ""),
        model: typeof modelInput === "string" ? modelInput.trim() : existing?.model ?? preset.model,
        protocol: spec.protocol,
        ...(spec.name === "codex" ? { models: ENGINE_ROUTE_PRESETS.codex.models } : {}),
      };
    }
    // 自定义端点按**字段存在性**判定:未提交 = 保留文件现值(随 ...fromFile 原样带过去);
    // 空数组 = 清空;有数组 = 经 merge 整体替换(整份原子校验,不部分写)
    const submittedProviders = Object.prototype.hasOwnProperty.call(payload, "providers") ? payload.providers : undefined;
    let providers: unknown;
    if (submittedProviders !== undefined) {
      const merged = mergeProviders(submittedProviders, fromFile.providers);
      if ("error" in merged) return { ok: false, error: merged.error };
      providers = merged.value;
    }
    if (
      Object.keys(updates).length === 0 &&
      JSON.stringify(routes) === JSON.stringify(fromFile.routes ?? {}) &&
      providers === undefined
    ) {
      return {
        ok: false,
        error:
          "没有可写入的字段（api_key / base_url / strong_model / fast_model / writer_* / analytics_* / scout_* / codex_* / providers）",
      };
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ ...fromFile, ...updates, routes, ...(providers !== undefined ? { providers } : {}) }, null, 2) + "\n",
      { mode: 0o600 },
    );
    await fs.chmod(filePath, 0o600);
    notifyEngineSettingsChanged();
    return getEngineSettings({ _dataDir: dataDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
