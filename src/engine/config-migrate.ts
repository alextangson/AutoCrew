/**
 * v1 → v2 迁移（P2 spec §3.2）。**纯函数、不碰磁盘**：读取路径在内存里跑它，
 * 写入路径也跑同一份（读原文件 → 迁移 → 套用提交 → 整图校验 → 原子写）。
 *
 * v1 的四个填 key 的地方（顶层 / routes / fallback / providers）在这里被折成一张端点表：
 * 按 `(baseUrl, apiKey)` 去重，id 取主机名 slug，指针指过去。这也是「创始人的备用和写稿
 * 是同一家」这件事第一次在数据里显形——同一份 key + 同一个地址，迁移后就是同一条 provider。
 */
import {
  ENGINE_DEFAULTS,
  ENGINE_ROLE_LABELS,
  ENGINE_ROLE_NAMES,
  hostOf,
  inferProtocol,
  mergeModels,
  normalizeProviderBaseUrl,
  parseProviderTable,
  slugFromHost,
  uniqueProviderId,
  type EngineAssignments,
  type EngineGraphDraft,
  type EnginePointer,
  type EngineProviderConfig,
  type EngineRouteName,
} from "./config-schema.js";

export interface MigrationResult {
  draft: EngineGraphDraft;
  warnings: string[];
  /** 主端点的 key 从哪来——settings:get 的 `source` 字段直接用 */
  source: "file" | "env" | "none";
}

export interface EngineEnv {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

interface AddSpec {
  preferredId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol?: unknown;
  models: string[];
}

/** 端点表构建器：同 `(baseUrl, apiKey)` 复用同一条，模型清单并集，id 冲突加 `-2` */
function tableBuilder(warnings: string[]) {
  const providers: EngineProviderConfig[] = [];
  const taken = new Set<string>();
  const index = new Map<string, string>();
  const add = (spec: AddSpec): string | undefined => {
    const baseUrl = normalizeProviderBaseUrl(spec.baseUrl);
    if (!baseUrl || !spec.apiKey) return undefined;
    const key = `${baseUrl}\n${spec.apiKey}`;
    const existingId = index.get(key);
    if (existingId) {
      const hit = providers.find((p) => p.id === existingId);
      if (hit) hit.models = mergeModels(hit.models, spec.models);
      return existingId;
    }
    const id = uniqueProviderId(spec.preferredId, taken);
    taken.add(id);
    index.set(key, id);
    providers.push({
      id,
      name: spec.name || hostOf(baseUrl) || id,
      baseUrl,
      apiKey: spec.apiKey,
      protocol: inferProtocol(spec.apiKey, baseUrl, spec.protocol),
      models: mergeModels(spec.models),
    });
    return id;
  };
  return { providers, add, taken, warnings };
}

type Builder = ReturnType<typeof tableBuilder>;

/** v1 `routes` → `assignments`；codex 专线丢弃（零消费者，spec §2） */
function migrateRoutes(raw: Record<string, unknown>, topKey: string, b: Builder): EngineAssignments {
  const routes = (raw.routes ?? {}) as Record<string, unknown>;
  const assignments: EngineAssignments = {};
  if (routes.codex) b.warnings.push("codex 专线已停用（无任何功能使用），迁移时已丢弃");
  for (const role of ENGINE_ROLE_NAMES) {
    const r = routes[role] as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const model = typeof r.model === "string" ? r.model.trim() : "";
    const apiKey = typeof r.apiKey === "string" && r.apiKey.trim() ? r.apiKey.trim() : topKey;
    const baseUrl = normalizeProviderBaseUrl(r.baseUrl);
    if (!model || !apiKey || !baseUrl) {
      b.warnings.push(`${ENGINE_ROLE_LABELS[role]}的配置不完整（缺地址、模型或 Key），迁移时已丢弃`);
      continue;
    }
    const models = mergeModels(Array.isArray(r.models) ? (r.models as string[]) : [], [model]);
    const id = b.add({ preferredId: slugFromHost(hostOf(baseUrl)), name: hostOf(baseUrl), baseUrl, apiKey, protocol: r.protocol, models });
    if (id) assignments[role as EngineRouteName] = { provider: id, model };
  }
  return assignments;
}

/** v1 `fallback` 块 → `fallback` 指针（同 `(baseUrl, apiKey)` 已存在则复用那条） */
function migrateFallback(raw: Record<string, unknown>, b: Builder): EnginePointer | undefined {
  const fb = raw.fallback;
  if (fb === undefined || fb === null) return undefined;
  if (typeof fb !== "object" || Array.isArray(fb)) {
    b.warnings.push("engine.json 的 fallback 不是对象，已忽略备用端点");
    return undefined;
  }
  const f = fb as Record<string, unknown>;
  const baseUrl = typeof f.baseUrl === "string" ? f.baseUrl.trim() : "";
  const apiKey = typeof f.apiKey === "string" ? f.apiKey.trim() : "";
  if (!baseUrl || !apiKey) {
    b.warnings.push("备用端点缺地址或 Key，已忽略：主端点失败将直接报错（半配的备用比没有更危险）");
    return undefined;
  }
  const pick = (v: unknown, dflt: string) => (typeof v === "string" && v.trim() ? v.trim() : dflt);
  const strong = pick(f.strongModel, ENGINE_DEFAULTS.strongModel);
  const fast = pick(f.fastModel, ENGINE_DEFAULTS.fastModel);
  const host = hostOf(normalizeProviderBaseUrl(baseUrl) ?? "");
  const id = b.add({ preferredId: "fallback", name: host, baseUrl, apiKey, protocol: f.protocol, models: [strong, fast] });
  if (!id) {
    b.warnings.push("备用端点的地址不合法（只支持 http/https，且不能带账密/查询串/锚点），已忽略");
    return undefined;
  }
  return { provider: id, strong, fast };
}

/** v1 顶层 `apiKey/baseUrl/strongModel/fastModel`（含 env 回退）→ 主端点 */
function migrateMain(raw: Record<string, unknown>, env: EngineEnv, b: Builder): { main?: EnginePointer; key: string; source: "file" | "env" | "none" } {
  const fileKey = typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : "";
  const envKey = env.apiKey?.trim() ?? "";
  const key = fileKey || envKey;
  if (!key) return { key: "", source: "none" };
  const source = fileKey ? "file" : "env";
  const rawBase = (typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? raw.baseUrl.trim() : "") || env.baseUrl?.trim() || ENGINE_DEFAULTS.baseUrl;
  const strong = typeof raw.strongModel === "string" && raw.strongModel.trim() ? raw.strongModel.trim() : ENGINE_DEFAULTS.strongModel;
  const fast = typeof raw.fastModel === "string" && raw.fastModel.trim() ? raw.fastModel.trim() : ENGINE_DEFAULTS.fastModel;
  const host = hostOf(normalizeProviderBaseUrl(rawBase) ?? "");
  const id = b.add({
    preferredId: source === "env" ? "env" : "main",
    name: host,
    baseUrl: rawBase,
    apiKey: key,
    protocol: raw.protocol,
    models: [strong, fast],
  });
  if (!id) {
    b.warnings.push("主端点地址不合法（只支持 http/https，且不能带账密/查询串/锚点）——引擎会被当成未配置");
    return { key, source: "none" };
  }
  return { main: { provider: id, strong, fast }, key, source };
}

function pointer(value: unknown): EnginePointer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  const provider = typeof p.provider === "string" ? p.provider.trim() : "";
  if (!provider) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { provider, strong: str(p.strong), fast: str(p.fast) };
}

function parseAssignments(value: unknown, warnings: string[]): EngineAssignments {
  const out: EngineAssignments = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const input = value as Record<string, unknown>;
  if (input.codex) warnings.push("codex 专线已停用（无任何功能使用），迁移时已丢弃");
  for (const role of ENGINE_ROLE_NAMES) {
    const a = input[role];
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const rec = a as Record<string, unknown>;
    const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
    const model = typeof rec.model === "string" ? rec.model.trim() : "";
    if (provider && model) out[role] = { provider, model };
  }
  return out;
}

/** 已是 v2 的文件：原样读，只做逐条 fail-closed 的端点解析（引用完整性交给校验） */
function readV2(raw: Record<string, unknown>, env: EngineEnv, warnings: string[]): MigrationResult {
  const providers = parseProviderTable(raw.providers, warnings);
  const main = pointer(raw.main);
  const draft: EngineGraphDraft = {
    version: 2,
    providers,
    ...(main ? { main } : {}),
    ...(raw.fallback === null ? { fallback: null } : {}),
    assignments: parseAssignments(raw.assignments, warnings),
  };
  const fb = raw.fallback === null ? undefined : pointer(raw.fallback);
  if (fb) draft.fallback = fb;
  const hasMain = Boolean(main && providers.some((p) => p.id === main.provider));
  return { draft, warnings, source: hasMain ? "file" : "none" };
}

/** 文件里没有可用主端点、但环境变量有 key → 合成一条 `env` 端点（v1 的 env 回退路径不变） */
function synthesizeEnv(result: MigrationResult, env: EngineEnv): MigrationResult {
  const key = env.apiKey?.trim();
  if (!key) return result;
  const { draft } = result;
  if (draft.main && draft.providers.some((p) => p.id === draft.main?.provider)) return result;
  const baseUrl = env.baseUrl?.trim() || ENGINE_DEFAULTS.baseUrl;
  const b = tableBuilder(result.warnings);
  b.providers.push(...draft.providers);
  for (const p of draft.providers) b.taken.add(p.id);
  const id = b.add({
    preferredId: "env",
    name: hostOf(normalizeProviderBaseUrl(baseUrl) ?? ""),
    baseUrl,
    apiKey: key,
    models: [ENGINE_DEFAULTS.strongModel, ENGINE_DEFAULTS.fastModel],
  });
  if (!id) return result;
  draft.providers = b.providers;
  draft.main = { provider: id, strong: ENGINE_DEFAULTS.strongModel, fast: ENGINE_DEFAULTS.fastModel };
  return { ...result, source: "env" };
}

/**
 * 迁移入口。`raw` 是 engine.json 解析后的对象（没有文件就传 `{}`）。
 * 无 `version` 字段即 v1；`version: 2` 直接读。两条路都走 env 回退。
 */
export function migrateEngineConfig(raw: unknown, env: EngineEnv = {}): MigrationResult {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const warnings: string[] = [];
  if (obj.version === 2) return synthesizeEnv(readV2(obj, env, warnings), env);
  const b = tableBuilder(warnings);
  const { main, key, source } = migrateMain(obj, env, b);
  const assignments = migrateRoutes(obj, key, b);
  const fallback = migrateFallback(obj, b);
  // v1 的 providers 数组原样并入（同 (baseUrl, apiKey) 已存在则复用，聊天切换器行为不变）
  for (const p of parseProviderTable(obj.providers, warnings)) {
    const id = b.add({ preferredId: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol, models: p.models });
    if (id && id !== p.id) {
      b.warnings.push(`端点「${p.name}」与「${id}」的地址和 Key 相同，已合并成一个端点`);
    }
  }
  const draft: EngineGraphDraft = {
    version: 2,
    providers: b.providers,
    ...(main ? { main } : {}),
    ...(fallback ? { fallback } : {}),
    assignments,
  };
  return synthesizeEnv({ draft, warnings, source }, env);
}
