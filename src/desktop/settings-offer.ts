/**
 * 缺线路时的第三方中转推荐（spec 2026-10-25-tokencamel-touchpoint §3.1、§4.1、§4.2）——后端只管三件事：
 *   1. 读随仓库发版的预设文件（地址、链接、上线闸）；文件缺失/坏了 = 当作全关，不报错；
 *   2. 本机 `offers.json`：总开关 + 每个触点的「不用了」时间戳（不进资料库、不进 engine.json）；
 *   3. `settings:list_models`：拿用户粘的 Key 调**预设地址**的 `/models`，只读、永不写盘。
 *
 * 推荐文案不在这里——文案只在前端 `tokencamel-offer.ts`（spec §2.3，grep 测试守）。
 */
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostOf, normalizeProviderBaseUrl } from "../engine/config.js";
import { getMachineDir } from "../storage/storage-roots.js";

export type OfferTouchpoint = "onboarding" | "fallback";
const TOUCHPOINTS: OfferTouchpoint[] = ["onboarding", "fallback"];

export interface OfferPreset {
  id: string;
  name: string;
  baseUrl: string;
  host: string;
  protocol: "openai";
  links: { keys: string; pricing: string; privacy: string };
  suggest: { strong: string[]; fast: string[] };
  touchpoints: Record<OfferTouchpoint, boolean>;
}

const DEFAULT_PRESET_PATH = fileURLToPath(new URL("../engine/presets/tokencamel.json", import.meta.url));
let presetPath = DEFAULT_PRESET_PATH;

/** 测试注入口：指向临时预设文件；不传 = 恢复随仓库的那份 */
export function setOfferPresetPathForTest(p?: string): void {
  presetPath = p ?? DEFAULT_PRESET_PATH;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map((x) => x.trim()) : [];
}

function httpsLink(v: unknown): string {
  return typeof v === "string" && /^https:\/\//.test(v.trim()) ? v.trim() : "";
}

/** 预设文件 → 结构化预设；任何一处不合格返回 null（= 全关）。fork 的人删掉文件即可 */
export function parseOfferPreset(raw: unknown): OfferPreset | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = normalizeProviderBaseUrl(r.baseUrl);
  const links = (r.links ?? {}) as Record<string, unknown>;
  const keys = httpsLink(links.keys), pricing = httpsLink(links.pricing), privacy = httpsLink(links.privacy);
  if (typeof r.id !== "string" || typeof r.name !== "string" || !baseUrl || r.protocol !== "openai") return null;
  if (!keys || !pricing || !privacy) return null;
  const suggest = (r.suggest ?? {}) as Record<string, unknown>;
  const tp = (r.touchpoints ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    name: r.name,
    baseUrl,
    host: hostOf(baseUrl),
    protocol: "openai",
    links: { keys, pricing, privacy },
    suggest: { strong: strList(suggest.strong), fast: strList(suggest.fast) },
    // 只有字面量 true 才算开：上线闸宁关勿开
    touchpoints: { onboarding: tp.onboarding === true, fallback: tp.fallback === true },
  };
}

export function loadOfferPreset(): OfferPreset | null {
  try {
    return parseOfferPreset(JSON.parse(readFileSync(presetPath, "utf-8")));
  } catch {
    return null;
  }
}

// ── 本机 offers.json ────────────────────────────────────────────────────────

export interface OfferMemory {
  enabled: boolean;
  dismissed: Partial<Record<OfferTouchpoint, string>>;
}

const OFFERS_FILE = "offers.json";

function offersPath(): string {
  return path.join(getMachineDir(), OFFERS_FILE);
}

/** 文件缺失/损坏 = 默认（开、没点过「不用了」）——它是偏好，不该让设置页起不来 */
export async function readOfferMemory(): Promise<OfferMemory> {
  try {
    const raw = JSON.parse(await fs.readFile(offersPath(), "utf-8")) as Record<string, unknown>;
    const dismissed: OfferMemory["dismissed"] = {};
    const d = (raw.dismissed ?? {}) as Record<string, unknown>;
    for (const t of TOUCHPOINTS) if (typeof d[t] === "string") dismissed[t] = d[t] as string;
    return { enabled: raw.enabled !== false, dismissed };
  } catch {
    return { enabled: true, dismissed: {} };
  }
}

async function writeOfferMemory(mem: OfferMemory): Promise<void> {
  const file = offersPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(mem, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, file);
}

/** settings:get 里的 offer 块。`ready` = 预设里该触点的上线闸；永不抛 */
export async function readOfferView(): Promise<Record<string, unknown>> {
  const preset = loadOfferPreset();
  const mem = await readOfferMemory();
  return {
    ready: { onboarding: Boolean(preset?.touchpoints.onboarding), fallback: Boolean(preset?.touchpoints.fallback) },
    enabled: mem.enabled,
    dismissed: mem.dismissed,
    preset: preset ? { name: preset.name, baseUrl: preset.baseUrl, host: preset.host, links: preset.links, suggest: preset.suggest } : null,
  };
}

/**
 * `settings:offer_set { enabled?, dismiss? }`：
 *   - `dismiss: "onboarding" | "fallback"` = 记下该触点的「不用了」，永久不再出；
 *   - `enabled: false` = 总开关关；从关拨回 `true` = 清空所有「不用了」（spec §3.1）。
 */
export async function setOfferPreference(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const { enabled, dismiss } = payload;
  if (enabled !== undefined && typeof enabled !== "boolean") return { ok: false, error: "enabled 必须是 true 或 false" };
  if (dismiss !== undefined && !TOUCHPOINTS.includes(dismiss as OfferTouchpoint)) {
    return { ok: false, error: "dismiss 只能是 onboarding 或 fallback" };
  }
  if (enabled === undefined && dismiss === undefined) return { ok: false, error: "没有可写入的字段（enabled / dismiss）" };
  try {
    const mem = await readOfferMemory();
    if (enabled === true && !mem.enabled) mem.dismissed = {};
    if (typeof enabled === "boolean") mem.enabled = enabled;
    if (dismiss) mem.dismissed[dismiss as OfferTouchpoint] = new Date().toISOString();
    await writeOfferMemory(mem);
    return { ok: true, data: await readOfferView() };
  } catch (err) {
    return { ok: false, error: `偏好没存上：${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── settings:list_models ───────────────────────────────────────────────────

export const LIST_MODELS_TIMEOUT_MS = 20_000;

export interface ListModelsDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function modelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const ids = data.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string" && Boolean(id.trim()));
  return [...new Set(ids.map((id) => id.trim()))];
}

/** 一次 GET {预设 baseUrl}/models；失败一律回人话，不写盘 */
async function fetchModels(preset: OfferPreset, apiKey: string, deps: ListModelsDeps): Promise<Record<string, unknown>> {
  const timeoutMs = deps.timeoutMs ?? LIST_MODELS_TIMEOUT_MS;
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${preset.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const why = e?.name === "TimeoutError" || e?.name === "AbortError" ? `${Math.round(timeoutMs / 1000)} 秒内没有回应` : e?.message || String(err);
    return { ok: false, error: `连不上 ${preset.host}：${why}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: `这把 Key 不对，去 ${preset.name} 控制台重新复制` };
  }
  if (!res.ok) return { ok: false, error: `${preset.host} 回了 HTTP ${res.status}，没读到模型列表` };
  const models = modelIds(await res.json().catch(() => null));
  if (!models.length) {
    return { ok: false, error: "这把 Key 所在分组还没有可用模型（可能还没充值或没开通），去控制台看看" };
  }
  return { ok: true, data: { models } };
}

/**
 * `settings:list_models { api_key, base_url? }`——只认预设地址：传了别的 base_url 直接拒绝、不发请求，
 * 免得这条通道变成「拿用户的 Key 打任意地址」的跳板（spec §4.1 地址只读）。
 */
export async function listPresetModels(payload: Record<string, unknown>, deps: ListModelsDeps = {}): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  const preset = loadOfferPreset();
  if (!preset) return { ok: false, error: "没有可用的预设端点" };
  if (payload.base_url !== undefined && normalizeProviderBaseUrl(payload.base_url) !== preset.baseUrl) {
    return { ok: false, error: "只能读取预设地址的模型列表" };
  }
  const apiKey = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
  if (!apiKey) return { ok: false, error: "先粘贴 API Key" };
  return fetchModels(preset, apiKey, deps);
}
