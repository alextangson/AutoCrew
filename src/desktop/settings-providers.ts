/**
 * 自定义端点的设置面读写（设计 §Phase 4：端点即用户数据）。
 *
 * 与引擎读取路径（config.ts 的 normalizeProviders：逐条 fail-closed）**不是同一套规矩**：
 * 写入必须整份原子校验——设置页提交的是全量数组，逐条丢弃等于替用户删数据。
 * 任何一条非法/重复 id → 拒绝整次提交并说清是哪一条，一个字节都不落盘。
 *
 * 密钥口径：读回只给 `apiKeySet` 布尔（不回原文也不回掩码——掩码遇上"数组整体替换"
 * 会被当成真值写回去）；写入按 id merge：非空即替换、留空且 id 已存在则保留原值、
 * 新 id 无 key 直接拒。
 */
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  PROVIDER_ID_RE,
  normalizeProviderBaseUrl,
  resolveEngineConfigPath,
  type EngineProtocol,
  type EngineProviderConfig,
} from "../engine/config.js";

/** settings:get 里的一条端点：**无 key、无掩码**，只有一个"配没配"的布尔 */
export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  /** 显式协议；null = 未指定（引擎按 key 前缀与域名推断） */
  protocol: EngineProtocol | null;
  models: string[];
  apiKeySet: boolean;
}

/** 落盘形状：protocol 只有用户显式选过才写（不写 = 交给 inferProtocol 每次按当前 key/域名推断） */
type StoredProvider = Omit<EngineProviderConfig, "protocol"> & { protocol?: EngineProtocol };

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 文件里的 providers → 设置页视图。宽容读：坏条目也照样显示（用户得看得见才能改），
 * 真正的把关在写入侧。
 */
export function providerViews(raw: unknown): ProviderView[] {
  return asArray(raw)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((p) => ({
      id: typeof p.id === "string" ? p.id : "",
      name: typeof p.name === "string" ? p.name : "",
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
      protocol: p.protocol === "openai" || p.protocol === "anthropic" ? p.protocol : null,
      models: asArray(p.models).filter((m): m is string => typeof m === "string" && Boolean(m.trim())).map((m) => m.trim()),
      apiKeySet: typeof p.apiKey === "string" && Boolean(p.apiKey.trim()),
    }));
}

/** 文件里已存的 key（按 id 索引）——留空提交时靠它保住原值 */
function existingKeys(raw: unknown): Map<string, string> {
  const keys = new Map<string, string>();
  for (const item of asArray(raw)) {
    const p = item as { id?: unknown; apiKey?: unknown };
    if (typeof p?.id === "string" && typeof p.apiKey === "string" && p.apiKey.trim()) {
      keys.set(p.id.trim(), p.apiKey.trim());
    }
  }
  return keys;
}

/**
 * 设置页提交的 providers 数组 → 落盘数组。整份原子：返回 error 就是一条都不写。
 * 语义（codex 快审 #5+6 #7）：非空 apiKey 替换 / 已有 id 留空保留原值 / 新 id 无 key 拒绝 /
 * 数组里缺席的 id = 删除 / 数组内重复 id = 拒绝整次提交。
 */
export function mergeProviders(
  submitted: unknown,
  existingRaw: unknown,
): { value: StoredProvider[] } | { error: string } {
  if (!Array.isArray(submitted)) return { error: "providers 必须是数组" };
  const keys = existingKeys(existingRaw);
  const out: StoredProvider[] = [];
  const seen = new Set<string>();
  for (const [i, item] of submitted.entries()) {
    const at = `第 ${i + 1} 个端点`;
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `${at}不是对象` };
    const p = item as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) return { error: `${at}缺名称——它就是切换器上的分组标题` };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!PROVIDER_ID_RE.test(id)) {
      return { error: `端点「${name}」的 id 不合法：只允许小写字母、数字、连字符，1–32 位` };
    }
    if (seen.has(id)) return { error: `端点 id「${id}」重复——同一个 id 只能有一条` };
    seen.add(id);
    const baseUrl = normalizeProviderBaseUrl(p.baseUrl);
    if (!baseUrl) {
      return { error: `端点「${name}」的地址不合法：只支持 http/https，且不能带账密、查询串或锚点` };
    }
    const models = asArray(p.models)
      .filter((m): m is string => typeof m === "string" && Boolean(m.trim()))
      .map((m) => m.trim());
    if (!models.length) return { error: `端点「${name}」至少要填一个模型名` };
    let protocol: EngineProtocol | undefined;
    if (p.protocol !== undefined && p.protocol !== null && p.protocol !== "") {
      if (p.protocol !== "openai" && p.protocol !== "anthropic") {
        return { error: `端点「${name}」的 protocol 只能是 openai 或 anthropic（留空 = 自动推断）` };
      }
      protocol = p.protocol;
    }
    const submittedKey = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
    const apiKey = submittedKey || keys.get(id) || "";
    if (!apiKey) return { error: `端点「${name}」是新增的，必须填 API Key` };
    out.push({ id, name, baseUrl, apiKey, models, ...(protocol ? { protocol } : {}) });
  }
  return { value: out };
}

/**
 * 打开**实际生效**的 engine.json（dsh 式逃生门）。子工作区继承默认工作区配置时，
 * 打开的是真正读到的那一份，不是继承前的空路径。
 * 平台分支照 bin/autocrew.mjs 的 openBrowser：darwin=open / win32=cmd start / 其余=xdg-open。
 */
export async function openEngineConfigFile(
  payload: Record<string, unknown>,
  deps?: { spawnImpl?: typeof spawn; platform?: NodeJS.Platform },
): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const filePath = await resolveEngineConfigPath((payload._dataDir as string) || undefined);
  try {
    await fs.access(filePath);
  } catch {
    return { ok: false, error: `还没有配置文件（${filePath}）——先在上面保存一次引擎配置，它就会出现` };
  }
  const platform = deps?.platform ?? process.platform;
  const spawnImpl = deps?.spawnImpl ?? spawn;
  const opener = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  try {
    const child = spawnImpl(opener, args, { detached: true, stdio: "ignore" });
    child.unref?.();
    return { ok: true, data: { path: filePath, opened: true } };
  } catch (err) {
    // 打不开不是灾难：把真实路径给出去，用户自己去开
    return { ok: true, data: { path: filePath, opened: false, error: err instanceof Error ? err.message : String(err) } };
  }
}
