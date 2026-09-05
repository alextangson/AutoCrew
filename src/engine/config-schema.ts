/**
 * 引擎配置 v2 的形状与基本尺子（P2 spec §3.1）。
 *
 * 一句话：**`providers` 是唯一的端点表**，主端点 / 备用 / 岗位 / 聊天切换器全部按 id 指过去，
 * 密钥只存一份。这个文件只放「是什么」与「怎么量」——迁移在 config-migrate.ts，
 * 校验与投影在 config-validate.ts，读取入口仍是 config.ts。
 */

export type EngineProtocol = "openai" | "anthropic";

/**
 * 端点表里的一条。v1 里它只是「聊天切换器的额外端点」，v2 起它是唯一的端点定义：
 * id 由创建方生成一次并落盘（改名不重算）——切换器的选项 id 与各岗位指针都靠它稳定。
 */
export interface EngineProviderConfig {
  id: string;
  /** 显示名（切换器的 optgroup 标题、状态点的标签）；缺省回落主机名 */
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: EngineProtocol;
  /** 至少一个；切换器按 端点 × 模型 展开 */
  models: string[];
}

/** 岗位名。v1 的 `codex` 专线零消费者，P2 删除（生图链的 kind:"codex" 是另一回事，不动） */
export type EngineRouteName = "writer" | "analytics" | "scout" | "reviewer";

/** 迁移与展示的固定次序（决定 provider id 的生成顺序，必须稳定） */
export const ENGINE_ROLE_NAMES: readonly EngineRouteName[] = ["writer", "reviewer", "scout", "analytics"];

/** 报病文案里的角色名（spec §4.2 固定用词），本片先给同家检测用 */
export const ENGINE_ROLE_LABELS: Record<EngineRouteName, string> = {
  writer: "写稿专线",
  reviewer: "审稿专线",
  scout: "调研专线",
  analytics: "复盘专线",
};

/** 主端点 / 备用端点指针：指一个端点 + 两档模型 */
export interface EnginePointer {
  provider: string;
  strong: string;
  fast: string;
}

/** 岗位指针：指一个端点 + 一个模型（缺省 = 跟随 main.strong） */
export interface EngineAssignment {
  provider: string;
  model: string;
}

export type EngineAssignments = Partial<Record<EngineRouteName, EngineAssignment>>;

/** 落盘形状（v2）。`main` 必填；`fallback` 可缺省；`assignments` 四个岗位全可缺省。 */
export interface EngineConfigV2 {
  version: 2;
  providers: EngineProviderConfig[];
  main: EnginePointer;
  fallback?: EnginePointer | null;
  assignments?: EngineAssignments;
}

/**
 * 迁移产物：形状是 v2，但引用**还没校验**——main 可能缺席、fallback/assignments 可能指空。
 * 读取路径把悬空引用丢掉并记 warning，写入路径整次拒绝（config-validate.ts）。
 */
export interface EngineGraphDraft {
  version: 2;
  providers: EngineProviderConfig[];
  main?: EnginePointer;
  fallback?: EnginePointer | null;
  assignments: EngineAssignments;
}

/**
 * 备用端点的**运行时**投影（runLoop 只认这个扁平形状）。
 * 共用一套档位（强/快），不做 per-route 备用——岗位专属模型统一落到备用强档。
 */
export interface EngineFallbackConfig {
  baseUrl: string;
  apiKey: string;
  strongModel: string;
  fastModel: string;
  protocol: EngineProtocol;
}

/**
 * 运行时配置：v2 图**投影**成的扁平形状。runLoop / pi-wire 只吃这一份，
 * 25 处 `resolveEngineRoute(...).config` 的调用点因此零改动（spec §3.3）。
 */
export interface EngineConfig {
  apiKey: string;
  baseUrl: string;
  /** 核心生成（口播脚本）= main.strong */
  strongModel: string;
  /** 过滤/排版/打标 = main.fast */
  fastModel: string;
  /** 备用端点；未配置 = 主端点失败即报错 */
  fallback?: EngineFallbackConfig;
  /** 端点表全量（v2 起含主端点与备用端点本身）；聊天切换器按 端点 × 模型 展开 */
  providers?: EngineProviderConfig[];
  /** 岗位 → 端点+模型；缺省的岗位跟随 main.strong */
  assignments?: EngineAssignments;
  /**
   * 上游协议:openai = /chat/completions(缺省);anthropic = /v1/messages。
   * 自动识别:sk-ant 前缀 key 或 baseUrl 含 claude/anthropic → anthropic。
   */
  protocol?: EngineProtocol;
  /** 本次调用落在哪个端点上（spec §3.3）：P2a-2 的健康归因从这里取，本片只负责填对 */
  activeProvider?: { id: string; role: string };
  /** 读取时收集的校验/迁移/同家提醒；P2a-2 的健康视图直接消费（不再只 console.warn） */
  warnings?: string[];
  /** 读到的文件版本（2 = 已是 v2 或已迁移） */
  version?: 2;
  /** 运行日志落点；手工构造的 config 缺省 = 不落日志 */
  dataDir?: string;
}

export const ENGINE_DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  strongModel: "deepseek-v4-pro",
  fastModel: "deepseek-v4-flash",
};

/** 端点 id 的字符集：切换器的选项 id 是 `p:<id>:<model>`，冒号定界要求 id 里不能有冒号 */
export const PROVIDER_ID_RE = /^[a-z0-9-]{1,32}$/;

export function inferProtocol(apiKey: string, baseUrl: string, explicit?: unknown): EngineProtocol {
  if (explicit === "anthropic" || explicit === "openai") return explicit;
  return apiKey.startsWith("sk-ant") || /claude|anthropic/i.test(baseUrl) ? "anthropic" : "openai";
}

/**
 * 端点 baseUrl 归一化（读取与写入两路共用同一把尺）：
 * 只认 http/https、禁 userinfo（账密会随日志外泄）/查询串/锚点、去尾斜杠；
 * localhost 显式放行——本地跑的模型服务是常见形态。
 * 返回 null = 不合法（读取路径丢弃该条，写入路径拒绝整次提交）。
 */
export function normalizeProviderBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (!url.hostname) return null;
  return url.href.replace(/\/+$/, "");
}

/** 主机名（同家检测与 id/显示名的原料）；解析不了就空串 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 主机名 → 合法 provider id 的候选（`code.newcli.com` → `code-newcli-com`） */
export function slugFromHost(host: string): string {
  const slug = host.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return PROVIDER_ID_RE.test(slug) ? slug : "provider";
}

/** 同名冲突时加 `-2`/`-3`（截断到 32 位上限内），保证迁移结果确定且合法 */
export function uniqueProviderId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const id = base.slice(0, 32 - suffix.length) + suffix;
    if (!taken.has(id)) return id;
  }
  return `${base.slice(0, 28)}-${Date.now() % 1000}`;
}

/** 模型清单去重并保序（迁移合并同一端点时用） */
export function mergeModels(...lists: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const m of list ?? []) {
      const v = typeof m === "string" ? m.trim() : "";
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/** 单条端点：坏就返回 undefined 并记一条 warning（读取路径逐条 fail-closed 的执行体） */
function parseProviderEntry(item: unknown, at: string, warnings: string[]): EngineProviderConfig | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    warnings.push(`${at}不是对象，已丢弃`);
    return undefined;
  }
  const p = item as Partial<EngineProviderConfig>;
  const id = typeof p.id === "string" ? p.id.trim() : "";
  if (!PROVIDER_ID_RE.test(id)) {
    warnings.push(`${at}的 id 不合法（只允许小写字母/数字/连字符，1–32 位），已丢弃`);
    return undefined;
  }
  const baseUrl = normalizeProviderBaseUrl(p.baseUrl);
  if (!baseUrl) {
    warnings.push(`端点「${id}」的地址不合法（只支持 http/https，且不能带账密/查询串/锚点），已丢弃`);
    return undefined;
  }
  const apiKey = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
  if (!apiKey) {
    warnings.push(`端点「${id}」缺 apiKey，已丢弃`);
    return undefined;
  }
  const models = mergeModels(Array.isArray(p.models) ? (p.models as string[]) : []);
  if (!models.length) {
    warnings.push(`端点「${id}」没有可用模型（models 至少要有一个），已丢弃`);
    return undefined;
  }
  return {
    id,
    name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : id,
    baseUrl,
    apiKey,
    protocol: inferProtocol(apiKey, baseUrl, p.protocol),
    models,
  };
}

/** id 出现次数（重复的整组失效，不进解析） */
function countProviderIds(value: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of value) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id === "string" && PROVIDER_ID_RE.test(id.trim())) {
      counts.set(id.trim(), (counts.get(id.trim()) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 端点表解析（**读取路径**：逐条 fail-closed，坏的丢掉、好的照用）。
 * 三条纪律：
 * 1. id 格式非法 / baseUrl 非法 / 缺 apiKey / models 为空 → 丢弃该条并记一条 warning。
 * 2. **重复 id 全部失效**：首赢还是末赢都是静默换端点，最贵的那种失败——两条都丢。
 * 3. 全程不 throw：一条坏端点不该让整个引擎起不来。
 * 写入路径是另一套规矩（settings:set 整份原子校验，不逐条丢弃——那会丢用户数据）。
 */
export function parseProviderTable(value: unknown, warnings: string[]): EngineProviderConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push("engine.json 的 providers 不是数组，已忽略全部端点");
    return [];
  }
  const counts = countProviderIds(value);
  const warnedDup = new Set<string>();
  const parsed: EngineProviderConfig[] = [];
  for (const [i, item] of value.entries()) {
    const id = typeof (item as { id?: unknown })?.id === "string" ? ((item as { id: string }).id).trim() : "";
    if ((counts.get(id) ?? 0) > 1) {
      if (!warnedDup.has(id)) {
        warnings.push(`端点 id「${id}」重复，同 id 的条目全部失效——请在设置里改成唯一 id`);
        warnedDup.add(id);
      }
      continue;
    }
    const entry = parseProviderEntry(item, `第 ${i + 1} 条端点`, warnings);
    if (entry) parsed.push(entry);
  }
  return parsed;
}
