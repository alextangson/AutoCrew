/**
 * 设置面的读写汇总口（PRD §7.3 个性化中心）。key 永远掩码返回（renderer 拿不到原文）。
 * 引擎那一块搬去了 settings-engine.ts（v2 端点表的写入是固定四步，塞不进这里的增量 merge），
 * 本文件保留搜索 / 发布 / 生图链，并把引擎与收件箱原样转出——设置页只认 settings.ts 一个入口。
 *
 * 两种落盘根，别混：本文件的 engine/search/publish 都走**工作区** <dataDir>
 * （server 端从注册表解析后注入 _dataDir）；收件箱走**全局根** ~/.autocrew/，
 * 不随工作区切换，因此单独放 settings-inbox.ts（下方原样转出，设置页从这里取）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { maskKey } from "./settings-engine.js";

// 自定义端点的逃生门（打开实际生效的 engine.json）——设置页统一从 settings.ts 取
export { openEngineConfigFile } from "./settings-providers.js";

// 引擎配置（v2 一张端点表：读取迁移 + 写入四步）——设置面统一从 settings.ts 取
export {
  getEngineSettings,
  setEngineSettings,
  onEngineSettingsChanged,
  maskKey,
} from "./settings-engine.js";

// 收件箱设置（全局根 ~/.autocrew/inbox.json，不随工作区）——设置面统一从 settings.ts 取
export {
  getInboxSettings,
  setInboxSettings,
  getInboxSettingsRaw,
  onInboxSettingsChanged,
  type InboxSettings,
} from "./settings-inbox.js";

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
        // Reddit 源 OAuth 凭据:id/secret 齐了才算配好,secret 永不回显
        redditConfigured: Boolean(cfg.redditClientId && cfg.redditClientSecret),
        redditClientIdMasked: cfg.redditClientId ? maskKey(cfg.redditClientId) : null,
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
    ["redditClientId", "reddit_client_id"],
    ["redditClientSecret", "reddit_client_secret"],
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
    return { ok: false, error: "没有可写入的字段（image_api_key / image_base_url / image_model / theme / author / wechat_app_id / wechat_app_secret / x_api_key / reddit_client_id / reddit_client_secret / open_comment）" };
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
