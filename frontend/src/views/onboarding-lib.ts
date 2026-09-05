/**
 * 首次开机的**纯逻辑**（P2 spec §5.1）：三种端点的预填、提交体的形状、写盘顺序与失败语义。
 *
 * 写盘顺序是有讲究的（spec §10 第 10 条）：
 *   1. `settings:set`（端点表 + 主端点指针）——失败就停在卡上，一个字节都没写歪；
 *   2. `settings:test_route`——**不通也不锁门**，卡上摆出那句人话 + 「先进去再说」；
 *   3. `settings:search_set`（只在填了搜索 Key 时）——**失败不回滚引擎**，卡上留一行，照样进。
 * 搜索保存排在探针之后但**与探针结果无关**：探针不通时用户点「先进去再说」，
 * 那把已经敲进去的搜索 Key 不该跟着被丢掉。
 */

export type EndpointKind = "deepseek" | "claude-relay" | "openai-compat";

export interface EndpointPreset {
  kind: EndpointKind;
  label: string;
  /** 端点表里的 id 与显示名（第一次开机只建这一条） */
  providerId: string;
  providerName: string;
  baseUrl: string;
  strong: string;
  fast: string;
  /** 地址要用户自己填 */
  needsAddress: boolean;
  /** 强/快模型要用户自己填 */
  needsModels: boolean;
  hint: string;
}

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  {
    kind: "deepseek",
    label: "DeepSeek 官方",
    providerId: "deepseek",
    providerName: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com",
    strong: "deepseek-v4-pro",
    fast: "deepseek-v4-flash",
    needsAddress: false,
    needsModels: false,
    hint: "地址与模型都已预填，只要一把 Key。",
  },
  {
    kind: "claude-relay",
    label: "Claude 中转",
    providerId: "relay",
    providerName: "Claude 中转",
    baseUrl: "",
    strong: "claude-opus-4-8",
    fast: "claude-sonnet-5",
    needsAddress: true,
    needsModels: false,
    hint: "填中转给你的地址；模型名按 Claude 预填，中转不一样就自己改。",
  },
  {
    kind: "openai-compat",
    label: "其他 OpenAI 兼容",
    providerId: "custom",
    providerName: "自定义端点",
    baseUrl: "",
    strong: "",
    fast: "",
    needsAddress: true,
    needsModels: true,
    hint: "本地 Ollama、另一家中转都走这条：地址与强/快两个模型名都要填。",
  },
];

export function presetOf(kind: EndpointKind): EndpointPreset {
  return ENDPOINT_PRESETS.find((p) => p.kind === kind) ?? ENDPOINT_PRESETS[0];
}

export interface OnboardingForm {
  kind: EndpointKind;
  baseUrl: string;
  apiKey: string;
  strong: string;
  fast: string;
  searchProvider: "bocha" | "tavily";
  searchKey: string;
}

export function initialForm(): OnboardingForm {
  const p = presetOf("deepseek");
  return { kind: "deepseek", baseUrl: p.baseUrl, apiKey: "", strong: p.strong, fast: p.fast, searchProvider: "bocha", searchKey: "" };
}

/** 换端点类型 = 换一整套预填（用户没改过的字段跟着走，改过的以他填的为准由调用方决定） */
export function applyPreset(form: OnboardingForm, kind: EndpointKind): OnboardingForm {
  const p = presetOf(kind);
  return { ...form, kind, baseUrl: p.baseUrl, strong: p.strong, fast: p.fast };
}

export interface EnginePayload {
  providers: Array<{ id: string; name: string; baseUrl: string; apiKey: string; models: string[] }>;
  main: { provider: string; strong: string; fast: string };
}

export type BuildResult = { ok: true; payload: EnginePayload } | { ok: false; error: string };

/** 表单 → `settings:set` 的提交体。缺什么就当场说缺什么，不让后端替我们数落用户 */
export function buildEnginePayload(form: OnboardingForm): BuildResult {
  const preset = presetOf(form.kind);
  const apiKey = form.apiKey.trim();
  if (!apiKey) return { ok: false, error: "先填 API Key——没有它连不上任何端点" };
  const baseUrl = (form.baseUrl || preset.baseUrl).trim();
  if (!baseUrl) return { ok: false, error: "填一下端点地址（中转给你的那个 https 地址）" };
  const strong = (form.strong || preset.strong).trim();
  const fast = (form.fast || preset.fast).trim();
  if (!strong || !fast) return { ok: false, error: "强模型与快模型都要填一个模型名" };
  const models = strong === fast ? [strong] : [strong, fast];
  return {
    ok: true,
    payload: {
      providers: [{ id: preset.providerId, name: preset.providerName, baseUrl, apiKey, models }],
      main: { provider: preset.providerId, strong, fast },
    },
  };
}

export interface InvokeLike {
  (channel: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
}

export interface OnboardingSaveResult {
  /** 引擎存下来了吗——false 时停在卡上，别放人进去 */
  engineSaved: boolean;
  /** 引擎保存失败的原因 */
  engineError?: string;
  /** 探针失败的那句人话（引擎已存，不锁门） */
  probeError?: string;
  /** 探针成功的耗时 */
  probeMs?: number;
  /** 搜索 Key 没存上（不回滚引擎，卡上留一行） */
  searchError?: string;
}

/**
 * 「测试并进入」的全过程。返回给 UI 判断：`engineSaved && !probeError` 才是直接进去，
 * 探针失败时把 `probeError` 摆出来配一个「先进去再说」。
 */
export async function runOnboardingSave(invoke: InvokeLike, form: OnboardingForm): Promise<OnboardingSaveResult> {
  const built = buildEnginePayload(form);
  if (!built.ok) return { engineSaved: false, engineError: built.error };

  const saved = await invoke("settings:set", built.payload as unknown as Record<string, unknown>);
  if (!saved.ok) return { engineSaved: false, engineError: saved.error ?? "引擎配置没保存上" };

  const out: OnboardingSaveResult = { engineSaved: true };
  const probe = await invoke("settings:test_route", { provider_id: built.payload.main.provider, model: built.payload.main.strong });
  if (!probe.ok) out.probeError = probe.error ?? "端点测试失败，原因未记录";
  else out.probeMs = (probe.data as { ms?: number } | undefined)?.ms ?? 0;

  // 搜索是可选第二把钥匙：存不上不回滚引擎，也不拦人进门
  const searchKey = form.searchKey.trim();
  if (searchKey) {
    const search = await invoke("settings:search_set", { provider: form.searchProvider, api_key: searchKey });
    if (!search.ok) out.searchError = search.error ?? "搜索 Key 没保存成功";
  }
  return out;
}
