/**
 * 引擎设置的读写（P2 spec §3.2）。从 settings.ts 拆出来：v2 的写入是固定四步，
 * 塞不进原来那个「读原始 JSON、按 v1 字段增量 merge、writeFile」的十行。
 *
 * 写入四步（任何一步不过就整次拒绝，文件一个字节不动）：
 *   1. 读原文件 → 2. 迁移成 v2（与读取路径同一个函数）→ 3. 套用提交 → 4. 整图校验 → 临时文件 + rename(0600)
 * 第一次把 v1 写成 v2 之前留一份 `engine.json.v1.bak`（存在即不覆盖）。不做 v2 → v1 反向。
 *
 * 密钥口径：读回只给掩码与「配没配」，原文一个字节都不出后端；
 * 提交空 apiKey = 保留该 id 已存的 key（settings-providers.ts 的既有规则）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  ENGINE_DEFAULTS,
  ENGINE_ROLE_NAMES,
  engineEnv,
  hostOf,
  migrateEngineConfig,
  normalizeProviderBaseUrl,
  readEngineFile,
  validateEngineGraph,
  type EngineAssignments,
  type EngineGraphDraft,
  type EnginePointer,
  type EngineProviderConfig,
  type EngineRouteName,
} from "../engine/config.js";
import { inferProtocol, mergeModels, slugFromHost, uniqueProviderId } from "../engine/config-schema.js";
import { getDataDir } from "../storage/local-store.js";
import { mergeProviders } from "./settings-providers.js";

export function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

const V1_BACKUP = "engine.json.v1.bak";

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

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** settings:get 里的一条端点：掩码 + 「配没配」，永不回原文 */
interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  /** 显式协议；null = 与自动推断一致（保存时不落盘，换 key 换域名照样自动跟着走） */
  protocol: string | null;
  models: string[];
  apiKeySet: boolean;
  apiKeyMasked: string | null;
}

function providerTableView(providers: EngineProviderConfig[]): ProviderView[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    protocol: p.protocol === inferProtocol(p.apiKey, p.baseUrl) ? null : p.protocol,
    models: p.models,
    apiKeySet: Boolean(p.apiKey),
    apiKeyMasked: p.apiKey ? maskKey(p.apiKey) : null,
  }));
}

/** 岗位视图带上端点地址——设置页的卡头要显示「此刻真实生效」的那条线 */
function assignmentsView(assignments: EngineAssignments | undefined, byId: Map<string, EngineProviderConfig>) {
  const out: Record<string, { provider: string; model: string; baseUrl: string } | null> = {};
  for (const role of ENGINE_ROLE_NAMES) {
    const a = assignments?.[role];
    out[role] = a ? { provider: a.provider, model: a.model, baseUrl: byId.get(a.provider)?.baseUrl ?? "" } : null;
  }
  return out;
}

export async function getEngineSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const raw = await readEngineFile(path.join(getDataDir(dataDir), "engine.json"));
    const migrated = migrateEngineConfig(raw, engineEnv());
    const outcome = validateEngineGraph(migrated.draft);
    const cfg = outcome.config;
    const byId = new Map(migrated.draft.providers.map((p) => [p.id, p] as const));
    const main = cfg ? byId.get(cfg.main.provider) : undefined;
    return {
      ok: true,
      data: {
        // 判据是「迁移后的 main 成立」——v2 文件与 v1 文件一视同仁，老用户不会被打回首次开机
        configured: Boolean(cfg && main),
        version: 2,
        source: cfg && main ? migrated.source : "none",
        apiKeyMasked: main ? maskKey(main.apiKey) : null,
        baseUrl: main?.baseUrl ?? ENGINE_DEFAULTS.baseUrl,
        strongModel: cfg?.main.strong ?? ENGINE_DEFAULTS.strongModel,
        fastModel: cfg?.main.fast ?? ENGINE_DEFAULTS.fastModel,
        main: cfg?.main ?? null,
        fallback: cfg?.fallback ?? null,
        assignments: assignmentsView(cfg?.assignments, byId),
        providers: providerTableView(migrated.draft.providers),
        warnings: [...migrated.warnings, ...outcome.warnings],
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── 提交套用（第 3 步）──────────────────────────────────────────────────────

interface Applied {
  touched: boolean;
  error?: string;
}

function takenIds(draft: EngineGraphDraft): Set<string> {
  return new Set(draft.providers.map((p) => p.id));
}

/** 按 `(baseUrl, apiKey)` 找现成端点，没有就建一条（迁移用的同一条纪律：密钥只存一份） */
function upsertProvider(
  draft: EngineGraphDraft,
  spec: { baseUrl: string; apiKey: string; models: string[]; preferredId: string; protocol?: unknown },
): EngineProviderConfig {
  const hit = draft.providers.find((p) => p.baseUrl === spec.baseUrl && p.apiKey === spec.apiKey);
  if (hit) {
    hit.models = mergeModels(hit.models, spec.models);
    return hit;
  }
  const created: EngineProviderConfig = {
    id: uniqueProviderId(spec.preferredId, takenIds(draft)),
    name: hostOf(spec.baseUrl) || spec.preferredId,
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey,
    protocol: inferProtocol(spec.apiKey, spec.baseUrl, spec.protocol),
    models: mergeModels(spec.models),
  };
  draft.providers.push(created);
  return created;
}

/** v1 兼容字段：主通道卡的 api_key / base_url / strong_model / fast_model / protocol */
function applyMainFields(draft: EngineGraphDraft, payload: Record<string, unknown>): Applied {
  const fields = ["api_key", "base_url", "strong_model", "fast_model", "protocol"] as const;
  if (!fields.some((f) => payload[f] !== undefined)) return { touched: false };
  for (const f of fields) {
    if (payload[f] !== undefined && !str(payload[f])) return { touched: true, error: `${f} 必须是非空字符串` };
  }
  const protocol = payload.protocol === undefined ? undefined : payload.protocol;
  if (protocol !== undefined && protocol !== "openai" && protocol !== "anthropic") {
    return { touched: true, error: "protocol 必须是 openai 或 anthropic" };
  }
  const apiKey = str(payload.api_key);
  const baseInput = str(payload.base_url);
  const strong = str(payload.strong_model);
  const fast = str(payload.fast_model);
  const current = draft.main ? draft.providers.find((p) => p.id === draft.main?.provider) : undefined;
  const baseUrl = normalizeProviderBaseUrl(baseInput || current?.baseUrl || ENGINE_DEFAULTS.baseUrl);
  if (!baseUrl) return { touched: true, error: "base_url 不合法：只支持 http/https，且不能带账密、查询串或锚点" };
  const key = apiKey || current?.apiKey || "";
  if (!key) return { touched: true, error: "还没有主端点：请连同 API Key 一起提交" };
  if (current) {
    current.baseUrl = baseUrl;
    current.apiKey = key;
    current.protocol = inferProtocol(key, baseUrl, protocol ?? current.protocol);
    if (!current.name || current.name === hostOf(current.baseUrl)) current.name = hostOf(baseUrl) || current.name;
    current.models = mergeModels(current.models, [strong, fast].filter(Boolean));
    draft.main = { provider: current.id, strong: strong || draft.main?.strong || "", fast: fast || draft.main?.fast || "" };
    return { touched: true };
  }
  const provider = upsertProvider(draft, {
    baseUrl,
    apiKey: key,
    models: [strong || ENGINE_DEFAULTS.strongModel, fast || ENGINE_DEFAULTS.fastModel],
    preferredId: "main",
    ...(protocol !== undefined ? { protocol } : {}),
  });
  draft.main = { provider: provider.id, strong: strong || ENGINE_DEFAULTS.strongModel, fast: fast || ENGINE_DEFAULTS.fastModel };
  return { touched: true };
}

const ROLE_FIELDS: Array<{ role: EngineRouteName; base: string; model: string }> = ENGINE_ROLE_NAMES.map((role) => ({
  role,
  base: `${role}_base_url`,
  model: `${role}_model`,
}));

/** v1 兼容字段：岗位卡的 <role>_base_url / <role>_model → v2 的 assignments 指针 */
function applyRoleFields(draft: EngineGraphDraft, payload: Record<string, unknown>): Applied {
  let touched = false;
  const main = draft.main ? draft.providers.find((p) => p.id === draft.main?.provider) : undefined;
  for (const spec of ROLE_FIELDS) {
    if (payload[spec.base] === undefined && payload[spec.model] === undefined) continue;
    touched = true;
    for (const f of [spec.base, spec.model]) {
      if (payload[f] !== undefined && !str(payload[f])) return { touched, error: `${f} 必须是非空字符串` };
    }
    if (!main) return { touched, error: "还没有主端点：先填 API Key 并保存，再配岗位专线" };
    const current = draft.assignments[spec.role];
    const currentProvider = current ? draft.providers.find((p) => p.id === current.provider) : undefined;
    const baseInput = str(payload[spec.base]);
    const baseUrl = normalizeProviderBaseUrl(baseInput || currentProvider?.baseUrl || main.baseUrl);
    if (!baseUrl) return { touched, error: `${spec.base} 不合法：只支持 http/https，且不能带账密、查询串或锚点` };
    const model = str(payload[spec.model]) || current?.model || draft.main?.strong || "";
    if (!model) return { touched, error: `${spec.model} 必须是非空字符串` };
    const apiKey = (baseInput && !currentProvider ? main.apiKey : currentProvider?.apiKey) || main.apiKey;
    const provider = upsertProvider(draft, { baseUrl, apiKey, models: [model], preferredId: slugFromHost(hostOf(baseUrl)) });
    draft.assignments[spec.role] = { provider: provider.id, model };
  }
  return { touched };
}

function readPointer(value: unknown, label: string): { value: EnginePointer } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${label} 必须是对象 {provider, strong, fast}` };
  const p = value as Record<string, unknown>;
  const provider = str(p.provider);
  if (!provider) return { error: `${label} 缺 provider（要指向端点表里的一个 id）` };
  return { value: { provider, strong: str(p.strong), fast: str(p.fast) } };
}

/** v2 提交协议：main / fallback / assignments 各自**整体替换**；fallback: null = 清空 */
function applyPointers(draft: EngineGraphDraft, payload: Record<string, unknown>): Applied {
  let touched = false;
  if (payload.main !== undefined) {
    const parsed = readPointer(payload.main, "main");
    if ("error" in parsed) return { touched: true, error: parsed.error };
    draft.main = parsed.value;
    touched = true;
  }
  if (payload.fallback !== undefined) {
    touched = true;
    if (payload.fallback === null) delete draft.fallback;
    else {
      const parsed = readPointer(payload.fallback, "fallback");
      if ("error" in parsed) return { touched, error: parsed.error };
      draft.fallback = parsed.value;
    }
  }
  if (payload.assignments !== undefined) {
    touched = true;
    const value = payload.assignments;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { touched, error: "assignments 必须是对象 {writer|reviewer|scout|analytics: {provider, model}}" };
    }
    const next: EngineAssignments = {};
    for (const role of ENGINE_ROLE_NAMES) {
      const a = (value as Record<string, unknown>)[role];
      if (a === undefined || a === null) continue;
      if (typeof a !== "object" || Array.isArray(a)) return { touched, error: `assignments.${role} 必须是对象 {provider, model}` };
      const rec = a as Record<string, unknown>;
      if (!str(rec.provider) || !str(rec.model)) return { touched, error: `assignments.${role} 缺 provider 或 model` };
      next[role] = { provider: str(rec.provider), model: str(rec.model) };
    }
    draft.assignments = next;
  }
  return { touched };
}

function applyProviders(draft: EngineGraphDraft, payload: Record<string, unknown>): Applied {
  if (!Object.prototype.hasOwnProperty.call(payload, "providers")) return { touched: false };
  const merged = mergeProviders(payload.providers, draft.providers);
  if ("error" in merged) return { touched: true, error: merged.error };
  draft.providers = merged.value.map((p) => ({
    ...p,
    protocol: inferProtocol(p.apiKey, p.baseUrl, p.protocol),
    models: mergeModels(p.models),
  }));
  return { touched: true };
}

// ── 落盘（第 4 步）──────────────────────────────────────────────────────────

/** protocol 只在与自动推断**不一致**时才写——写死会让「换 key 换协议」失灵 */
function storedProvider(p: EngineProviderConfig): Record<string, unknown> {
  const inferred = inferProtocol(p.apiKey, p.baseUrl);
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    ...(p.protocol === inferred ? {} : { protocol: p.protocol }),
    models: p.models,
  };
}

/** 临时文件 + rename：写一半的 engine.json 等于把用户锁在门外 */
async function atomicWrite(filePath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, filePath);
}

async function backupV1Once(filePath: string, raw: Record<string, unknown>): Promise<void> {
  if (raw.version === 2 || Object.keys(raw).length === 0) return;
  const backup = path.join(path.dirname(filePath), V1_BACKUP);
  try {
    await fs.access(backup);
    return; // 存在即不覆盖：第一次的原件才是原件
  } catch {
    /* 还没备份过 */
  }
  await fs.copyFile(filePath, backup).catch(() => {});
  await fs.chmod(backup, 0o600).catch(() => {});
}

const NOTHING_TO_WRITE =
  "没有可写入的字段（api_key / base_url / strong_model / fast_model / protocol / " +
  "writer_* / reviewer_* / scout_* / analytics_* / providers / main / fallback / assignments）";

export async function setEngineSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const dataDir = (payload._dataDir as string) || undefined;
    const filePath = path.join(getDataDir(dataDir), "engine.json");
    const raw = await readEngineFile(filePath); // 1. 读原文件
    const { draft } = migrateEngineConfig(raw, engineEnv()); // 2. 迁移成 v2
    let touched = false;
    for (const apply of [applyProviders, applyMainFields, applyRoleFields, applyPointers]) {
      const r = apply(draft, payload); // 3. 套用提交
      touched = touched || r.touched;
      if (r.error) return { ok: false, error: r.error };
    }
    if (!touched) return { ok: false, error: NOTHING_TO_WRITE };
    const outcome = validateEngineGraph(draft, { strict: true }); // 4. 整图校验
    if (!outcome.config) return { ok: false, error: outcome.errors.join("；") };
    const { main, fallback, assignments, providers } = outcome.config;
    const body = JSON.stringify(
      {
        version: 2,
        providers: providers.map(storedProvider),
        main,
        ...(fallback ? { fallback } : {}),
        ...(assignments && Object.keys(assignments).length ? { assignments } : {}),
      },
      null,
      2,
    );
    await backupV1Once(filePath, raw);
    await atomicWrite(filePath, `${body}\n`);
    notifyEngineSettingsChanged();
    return getEngineSettings({ _dataDir: dataDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
