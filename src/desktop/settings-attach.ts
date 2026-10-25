/**
 * `settings:engine_attach_preset`（spec 2026-10-25-tokencamel-touchpoint §4.3）：把预设端点**追加**进端点表。
 *
 * 为什么不复用 settings:set：`mergeProviders` 的语义是「提交数组里缺席的 id = 删除」，
 * 而 settings:get 只回掩码 Key，前端没法把旧端点原样回传——照搬首次开机的提交体，
 * 主指针坏了但表里还有别的端点时会把它们删掉。所以「读 → 追加 → 校验 → 原子写」全在服务端：
 *   - `as: "main"`：追加一条并让主指针指向它；其他端点、岗位、备用一个字段都不动；
 *   - `as: "fallback"`：追加一条并让备用指针指向它；主指针与岗位不动。
 *
 * 防重复（spec E13）：写前比对前端读到的 `revision`，不一致就拒绝；同一预设地址已在表里就不新建；
 * 同一进程内的两次提交排队执行，后到的那次一定看见先到的那条。
 */
import path from "node:path";
import {
  engineEnv,
  migrateEngineConfig,
  readEngineFile,
  resolveEngineConfigPath,
  validateEngineGraph,
  type EngineGraphDraft,
  type EngineProviderConfig,
} from "../engine/config.js";
import { uniqueProviderId } from "../engine/config-schema.js";
import { getConfigDir } from "../storage/storage-roots.js";
import { loadOfferPreset, type OfferPreset } from "./settings-offer.js";
import { engineRevision, getEngineSettings, persistEngineConfig } from "./settings-engine.js";

let queue: Promise<unknown> = Promise.resolve();

/** 同一进程内串行：await 之间别的请求插不进来「读后写前」那一段 */
function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

interface AttachInput {
  as: "main" | "fallback";
  apiKey: string;
  strong: string;
  fast: string;
  revision: string;
}

function readInput(payload: Record<string, unknown>): AttachInput | { error: string } {
  if (payload.as !== "main" && payload.as !== "fallback") return { error: "as 只能是 main 或 fallback" };
  const apiKey = str(payload.api_key);
  const strong = str(payload.strong);
  const fast = str(payload.fast);
  if (!apiKey) return { error: "先粘贴 API Key" };
  if (!strong || !fast) return { error: "两档模型都要从列表里选一个" };
  if (typeof payload.revision !== "string") return { error: "缺 revision：先刷新设置再保存" };
  return { as: payload.as, apiKey, strong, fast, revision: payload.revision };
}

/** 往草稿里追加预设端点并改一个指针；表里已有同地址的端点就返回提示，不动草稿 */
function appendPreset(draft: EngineGraphDraft, preset: OfferPreset, input: AttachInput): { error: string } | null {
  const existing = draft.providers.find((p) => p.baseUrl === preset.baseUrl);
  if (existing) {
    return { error: `你已经接过 ${preset.name}（端点名 ${existing.name}），要换 Key 去设置 · 模型改` };
  }
  const created: EngineProviderConfig = {
    id: uniqueProviderId(preset.id, new Set(draft.providers.map((p) => p.id))),
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiKey: input.apiKey,
    protocol: preset.protocol,
    models: input.strong === input.fast ? [input.strong] : [input.strong, input.fast],
  };
  draft.providers.push(created);
  const pointer = { provider: created.id, strong: input.strong, fast: input.fast };
  if (input.as === "main") draft.main = pointer;
  else draft.fallback = pointer;
  return null;
}

async function attach(input: AttachInput, preset: OfferPreset, dataDir?: string): Promise<Record<string, unknown>> {
  const filePath = path.join(getConfigDir(dataDir), "engine.json");
  const raw = await readEngineFile(await resolveEngineConfigPath(dataDir));
  if (engineRevision(raw) !== input.revision) {
    return { ok: false, code: "stale", error: "模型配置刚被别处改过，刷新设置页后再保存" };
  }
  const { draft } = migrateEngineConfig(raw, engineEnv());
  const previous = draft.providers.map((p) => ({ ...p }));
  const dup = appendPreset(draft, preset, input);
  if (dup) return { ok: false, code: "already", error: dup.error };
  const outcome = validateEngineGraph(draft, { strict: true });
  if (!outcome.config) return { ok: false, error: outcome.errors.join("；") };
  await persistEngineConfig(filePath, raw, previous, outcome.config);
  const view = await getEngineSettings({ _dataDir: dataDir });
  const providerId = input.as === "main" ? outcome.config.main.provider : outcome.config.fallback?.provider;
  return { ok: true, data: { providerId, settings: (view as { data?: unknown }).data ?? null } };
}

/** `settings:engine_attach_preset { as, api_key, strong, fast, revision }` */
export async function attachPresetEndpoint(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const preset = loadOfferPreset();
  if (!preset) return { ok: false, error: "没有可用的预设端点" };
  const input = readInput(payload);
  if ("error" in input) return { ok: false, error: input.error };
  const dataDir = (payload._dataDir as string) || undefined;
  return serialized(() => attach(input, preset, dataDir)).catch((err: unknown) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));
}
