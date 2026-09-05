/**
 * v2 配置图的整图校验与运行时投影（P2 spec §3.1 / §3.3 / §3.4）。
 *
 * 两种口径，同一套规则：
 * - **读取（lenient）**：悬空的 fallback/assignments 引用丢掉并记 warning，主端点无效 = 整份未配置。
 *   一条坏引用不该让引擎起不来。
 * - **写入（strict）**：任何一条不成立就整次拒绝、逐项报错，文件一个字节都不动。
 *
 * 投影：v2 图 → 扁平的运行时 `EngineConfig`（runLoop 只认它），
 * 所以 25 处 `resolveEngineRoute(...).config` 的调用点零改动。
 */
import {
  ENGINE_ROLE_LABELS,
  ENGINE_ROLE_NAMES,
  PROVIDER_ID_RE,
  hostOf,
  normalizeProviderBaseUrl,
  type EngineAssignments,
  type EngineConfig,
  type EngineConfigV2,
  type EngineGraphDraft,
  type EnginePointer,
  type EngineProviderConfig,
  type EngineRouteName,
} from "./config-schema.js";

export interface ValidationOutcome {
  /** 引用全部成立时的规范化结果；主端点无效时缺席 */
  config?: EngineConfigV2;
  warnings: string[];
  errors: string[];
}

function checkTable(providers: EngineProviderConfig[], errors: string[]): void {
  const seen = new Set<string>();
  for (const p of providers) {
    const at = `端点「${p.name || p.id}」`;
    if (!PROVIDER_ID_RE.test(p.id)) errors.push(`${at}的 id 不合法：只允许小写字母、数字、连字符，1–32 位`);
    else if (seen.has(p.id)) errors.push(`端点 id「${p.id}」重复——同一个 id 只能有一条`);
    seen.add(p.id);
    if (!normalizeProviderBaseUrl(p.baseUrl)) errors.push(`${at}的地址不合法：只支持 http/https，且不能带账密、查询串或锚点`);
    if (!p.apiKey.trim()) errors.push(`${at}缺 API Key`);
    if (!p.models.length) errors.push(`${at}至少要填一个模型名`);
  }
}

/** 指针的两档模型：缺了就用端点清单里的第一个顶上（并说一声），模型名不在清单里只提醒不拦 */
function resolvePointer(
  pointer: EnginePointer,
  provider: EngineProviderConfig,
  label: string,
  warnings: string[],
): EnginePointer {
  const first = provider.models[0] ?? "";
  const strong = pointer.strong || first;
  const fast = pointer.fast || strong;
  if (!pointer.strong) warnings.push(`${label}没写强模型，已用端点「${provider.name}」清单里的第一个（${strong}）`);
  if (!pointer.fast) warnings.push(`${label}没写快模型，已沿用强模型（${fast}）`);
  for (const [tier, model] of [["强", strong], ["快", fast]] as const) {
    if (model && !provider.models.includes(model)) {
      warnings.push(`${label}的${tier}模型「${model}」不在端点「${provider.name}」的模型清单里——能用，但设置页选不到`);
    }
  }
  return { provider: provider.id, strong, fast };
}

function validateAssignments(
  assignments: EngineAssignments,
  byId: Map<string, EngineProviderConfig>,
  out: ValidationOutcome,
  strict: boolean,
): EngineAssignments {
  const kept: EngineAssignments = {};
  for (const role of ENGINE_ROLE_NAMES) {
    const a = assignments[role];
    if (!a) continue;
    const provider = byId.get(a.provider);
    const label = ENGINE_ROLE_LABELS[role];
    if (!provider) {
      const text = `${label}指向的端点「${a.provider}」不存在`;
      if (strict) out.errors.push(text);
      else out.warnings.push(`${text}，该岗位已改为跟随主端点`);
      continue;
    }
    if (!provider.models.includes(a.model)) {
      out.warnings.push(`${label}的模型「${a.model}」不在端点「${provider.name}」的模型清单里——能用，但设置页选不到`);
    }
    kept[role as EngineRouteName] = { provider: provider.id, model: a.model };
  }
  return kept;
}

/**
 * 同家检测（spec §3.4）：备用端点的**主机名**与主端点或任一岗位相同就提醒。
 * 故意只比主机名、忽略路径——同一中转的 /claude/ultra 与 /codex/v1 是不同服务，
 * 但整站不通时一起死，那正是这条提醒要抓的情形。
 */
export function sameFamilyWarning(config: EngineConfigV2): string | undefined {
  const fb = config.fallback;
  if (!fb) return undefined;
  const byId = new Map(config.providers.map((p) => [p.id, p] as const));
  const fbProvider = byId.get(fb.provider);
  const fbHost = fbProvider ? hostOf(fbProvider.baseUrl) : "";
  if (!fbHost) return undefined;
  const peers: Array<[string, string]> = [["主端点", config.main.provider]];
  for (const role of ENGINE_ROLE_NAMES) {
    const a = config.assignments?.[role];
    if (a) peers.push([ENGINE_ROLE_LABELS[role], a.provider]);
  }
  for (const [label, providerId] of peers) {
    if (providerId === fb.provider || hostOf(byId.get(providerId)?.baseUrl ?? "") === fbHost) {
      return `备用端点和${label}是同一家（${fbHost}），它挂了备用一起挂`;
    }
  }
  return undefined;
}

/** 整图校验。strict = 写入路径（任何一条不成立整次拒绝）；否则读取路径（丢弃 + warning） */
export function validateEngineGraph(draft: EngineGraphDraft, opts: { strict?: boolean } = {}): ValidationOutcome {
  const strict = opts.strict === true;
  const out: ValidationOutcome = { warnings: [], errors: [] };
  if (strict) checkTable(draft.providers, out.errors);
  const byId = new Map(draft.providers.map((p) => [p.id, p] as const));
  const mainProvider = draft.main ? byId.get(draft.main.provider) : undefined;
  if (!draft.main || !mainProvider) {
    out.errors.push(
      draft.main
        ? `主端点指向的端点「${draft.main.provider}」不存在——引擎没有可用的主端点`
        : "还没有主端点：先在设置里填一个端点的地址与 API Key",
    );
    return out;
  }
  const main = resolvePointer(draft.main, mainProvider, "主端点", out.warnings);
  let fallback: EnginePointer | undefined;
  if (draft.fallback) {
    const fbProvider = byId.get(draft.fallback.provider);
    if (!fbProvider) {
      const text = `备用端点指向的端点「${draft.fallback.provider}」不存在`;
      if (strict) out.errors.push(text);
      else out.warnings.push(`${text}，备用已停用：主端点失败将直接报错`);
    } else {
      fallback = resolvePointer(draft.fallback, fbProvider, "备用端点", out.warnings);
    }
  }
  const assignments = validateAssignments(draft.assignments, byId, out, strict);
  const config: EngineConfigV2 = {
    version: 2,
    providers: draft.providers,
    main,
    ...(fallback ? { fallback } : {}),
    ...(Object.keys(assignments).length ? { assignments } : {}),
  };
  const family = sameFamilyWarning(config);
  if (family) out.warnings.push(family);
  if (!out.errors.length) out.config = config;
  return out;
}

/**
 * v2 图 → 运行时 `EngineConfig`。主端点摊平成 apiKey/baseUrl/strong/fastModel，
 * 备用摊平成 `fallback` 块，端点表整份带过去（聊天切换器按 端点 × 模型 展开）。
 */
export function projectEngineConfig(
  config: EngineConfigV2,
  extra: { dataDir?: string; warnings?: string[] } = {},
): EngineConfig {
  const byId = new Map(config.providers.map((p) => [p.id, p] as const));
  const main = byId.get(config.main.provider);
  if (!main) throw new Error(`引擎配置损坏：主端点「${config.main.provider}」不在端点表里`);
  const fb = config.fallback ? byId.get(config.fallback.provider) : undefined;
  return {
    apiKey: main.apiKey,
    baseUrl: main.baseUrl,
    strongModel: config.main.strong,
    fastModel: config.main.fast,
    protocol: main.protocol,
    version: 2,
    activeProvider: { id: main.id, role: "main" },
    ...(fb && config.fallback
      ? {
          fallback: {
            baseUrl: fb.baseUrl,
            apiKey: fb.apiKey,
            strongModel: config.fallback.strong,
            fastModel: config.fallback.fast,
            protocol: fb.protocol,
          },
        }
      : {}),
    ...(config.providers.length ? { providers: config.providers } : {}),
    ...(config.assignments && Object.keys(config.assignments).length ? { assignments: config.assignments } : {}),
    ...(extra.warnings?.length ? { warnings: extra.warnings } : {}),
    ...(extra.dataDir ? { dataDir: extra.dataDir } : {}),
  };
}
