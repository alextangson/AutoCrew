/**
 * 引擎线路健康（P2 spec §4.1）——「哪条线现在是好的」的**唯一**事实源。
 *
 * 两种证据，各留最后一条：
 *   - `probe`：显式的测试（启动后探一遍、保存后探被改的、设置页点「测试」）。
 *   - `live` ：真实调用的回执（runLoop 每次成功/失败经 health-sink 喊回来）。
 * 它是「最后已知状态」而不是日志——四视角并发跑时后到的会覆盖先到的，那正是横幅要的语义；
 * 逐次记录看 run-log。
 *
 * 三条纪律：
 * 1. **不轮询**。只有四个更新时机（启动 / 保存 / 点测试 / 真实调用），别的地方一律不许探。
 * 2. **不出密钥**。视图只给 id / 显示名 / 主机名与状态，apiKey 一个字节都不出这个文件。
 * 3. **状态文件坏了当没探过**。健康记录是观测层，它自己不该让产品起不来。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { hostOf, loadEngineConfig, type EngineConfig } from "../engine/config.js";
import { setEngineHealthSink, type EngineLiveRecord } from "../engine/health-sink.js";
import { probeEngineRoute } from "../engine/probe.js";
import { describeProbeFailure } from "../engine/failure-text.js";
import { getDataDir } from "../storage/local-store.js";
import { cleanErrorMessage } from "./error-clean.js";
import { emitEngineEvent } from "./event-hub.js";
import { onEngineSettingsChanged } from "./settings-engine.js";

const HEALTH_FILE = "engine-health.json";

export interface ProbeHealth {
  at: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface LiveHealth {
  at: string;
  ok: boolean;
  role: string;
  jobId?: string;
  error?: string;
}

export interface EngineHealthState {
  providers: Record<string, { probe?: ProbeHealth | null; live?: LiveHealth | null }>;
}

export const EMPTY_HEALTH: EngineHealthState = { providers: {} };

// ── 落盘（缺失/损坏 = 没探过）─────────────────────────────────────────────────

export async function loadHealthState(dataDir?: string): Promise<EngineHealthState> {
  try {
    const raw = await fs.readFile(path.join(getDataDir(dataDir), HEALTH_FILE), "utf-8");
    const parsed = JSON.parse(raw) as EngineHealthState;
    if (!parsed || typeof parsed !== "object" || typeof parsed.providers !== "object" || !parsed.providers) {
      return { providers: {} };
    }
    return { providers: parsed.providers };
  } catch {
    return { providers: {} };
  }
}

export async function saveHealthState(state: EngineHealthState, dataDir?: string): Promise<void> {
  try {
    const dir = getDataDir(dataDir);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, HEALTH_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    await fs.rename(tmp, file);
  } catch {
    /* 观测层不得破坏执行层 */
  }
}

// ── 内存态（按工作区一份）───────────────────────────────────────────────────

const memory = new Map<string, EngineHealthState>();

async function stateFor(dataDir?: string): Promise<EngineHealthState> {
  const key = getDataDir(dataDir);
  const hit = memory.get(key);
  if (hit) return hit;
  const loaded = await loadHealthState(dataDir);
  memory.set(key, loaded);
  return loaded;
}

/** 测试收尾：清掉进程内缓存，免得上一个临时目录的状态漏进下一个用例 */
export function resetEngineHealth(): void {
  memory.clear();
}

/** 变更即广播（既有 SSE `engine` 事件，只报「变了」）；不落 events.jsonl——它不是工作日志 */
async function commit(state: EngineHealthState, dataDir?: string): Promise<void> {
  await saveHealthState(state, dataDir);
  await emitEngineEvent(
    { role: "system", kind: "engine_health", label: "引擎线路状态有更新" },
    dataDir,
    { persist: false },
  ).catch(() => {});
}

export async function recordProbeResult(
  providerId: string,
  result: { ok: boolean; ms: number; error?: string },
  dataDir?: string,
  host?: string,
): Promise<void> {
  const state = await stateFor(dataDir);
  const entry = (state.providers[providerId] ??= {});
  entry.probe = {
    at: new Date().toISOString(),
    ok: result.ok,
    ms: result.ms,
    ...(result.error ? { error: describeProbeFailure(cleanErrorMessage(result.error), { id: providerId, host }) } : {}),
  };
  await commit(state, dataDir);
}

export async function recordLiveResult(record: EngineLiveRecord, dataDir?: string): Promise<void> {
  const state = await stateFor(dataDir);
  const entry = (state.providers[record.providerId] ??= {});
  entry.live = {
    at: new Date().toISOString(),
    ok: record.ok,
    role: record.role,
    ...(record.jobId ? { jobId: record.jobId } : {}),
    ...(record.error ? { error: cleanErrorMessage(record.error) } : {}),
  };
  await commit(state, dataDir);
}

// ── 视图（纯函数：桌面 IPC 与 dsh doctor 共用同一份，不分叉）────────────────

export interface EngineHealthProviderView {
  id: string;
  name: string;
  host: string;
  probe: ProbeHealth | null;
  live: LiveHealth | null;
}

export interface EngineHealthView {
  configured: boolean;
  providers: EngineHealthProviderView[];
  main: { provider: string; strong: string; fast: string } | null;
  fallback: { provider: string; strong: string; fast: string } | null;
  assignments: Record<string, { provider: string; model: string } | null>;
  warnings: string[];
}

const ROLES = ["writer", "reviewer", "scout", "analytics"] as const;

/** 备用端点在端点表里的 id（运行时 config 已经摊平成 baseUrl/apiKey，按这两项认回去） */
function fallbackView(config: EngineConfig): EngineHealthView["fallback"] {
  const fb = config.fallback;
  if (!fb) return null;
  const id = (config.providers ?? []).find((p) => p.baseUrl === fb.baseUrl && p.apiKey === fb.apiKey)?.id ?? "fallback";
  return { provider: id, strong: fb.strongModel, fast: fb.fastModel };
}

export function engineHealthView(config: EngineConfig | null, state: EngineHealthState): EngineHealthView {
  const providers = (config?.providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    host: hostOf(p.baseUrl),
    probe: state.providers[p.id]?.probe ?? null,
    live: state.providers[p.id]?.live ?? null,
  }));
  const assignments: EngineHealthView["assignments"] = {};
  for (const role of ROLES) {
    const a = config?.assignments?.[role];
    assignments[role] = a ? { provider: a.provider, model: a.model } : null;
  }
  return {
    configured: Boolean(config),
    providers,
    main: config ? { provider: config.activeProvider?.id ?? "main", strong: config.strongModel, fast: config.fastModel } : null,
    fallback: config ? fallbackView(config) : null,
    assignments,
    warnings: config?.warnings ?? [],
  };
}

/** 读配置，未配置返回 null（横幅要说「还没配」，不是「配置读取失败」） */
async function readConfig(dataDir?: string): Promise<EngineConfig | null> {
  try {
    return await loadEngineConfig(dataDir);
  } catch {
    return null;
  }
}

export async function buildEngineHealth(dataDir?: string): Promise<EngineHealthView> {
  return engineHealthView(await readConfig(dataDir), await stateFor(dataDir));
}

// ── 探针（四个更新时机里的三个）──────────────────────────────────────────────

export interface ProbeAllDeps {
  probe?: typeof probeEngineRoute;
  /** 只探这些端点（settings:set 之后探被改动的那几条）；不传 = 全表 */
  only?: string[];
}

/**
 * 探一遍端点表（服务启动、保存之后）。**不阻塞调用方**的用法由调用方决定（void 掉即可）；
 * 每条用它自己 `models[0]` 试——测的是端点通不通，不是某个模型好不好。
 */
export async function probeAllProviders(dataDir?: string, deps: ProbeAllDeps = {}): Promise<void> {
  const config = await readConfig(dataDir);
  if (!config?.providers?.length) return;
  const probe = deps.probe ?? probeEngineRoute;
  const targets = deps.only?.length ? config.providers.filter((p) => deps.only!.includes(p.id)) : config.providers;
  for (const provider of targets) {
    const model = provider.models[0];
    if (!model) continue;
    const result = await probe(
      { ...config, baseUrl: provider.baseUrl, apiKey: provider.apiKey, protocol: provider.protocol, activeProvider: { id: provider.id, role: "probe" } },
      model,
    ).catch((err: unknown) => ({ ok: false, ms: 0, error: err instanceof Error ? err.message : String(err) }));
    await recordProbeResult(provider.id, result, dataDir, hostOf(provider.baseUrl));
  }
}

// ── 装配 ────────────────────────────────────────────────────────────────────

/**
 * 装配（server 启动时一次）：
 *   1. runLoop 的健康回执接进来（engine 层不认识 desktop，装配方负责接线）；
 *   2. 订阅设置保存 → 只重探地址/Key/协议真变过的那几条（spec §4.1 更新时机之二）。
 * 返回退订函数（测试收尾用）。
 */
export function initEngineHealth(dataDir?: string): () => void {
  setEngineHealthSink((record) => {
    void recordLiveResult(record, dataDir).catch(() => {});
  });
  const off = onEngineSettingsChanged(({ changedProviderIds }) => {
    if (changedProviderIds.length) void probeAllProviders(dataDir, { only: changedProviderIds }).catch(() => {});
  });
  return () => {
    off();
    setEngineHealthSink(undefined);
  };
}

/** IPC `engine:health`：只读，无副作用（探针有它自己的四个时机） */
export async function getEngineHealth(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const dataDir = (payload._dataDir as string) || undefined;
  return { ok: true, data: await buildEngineHealth(dataDir) };
}
