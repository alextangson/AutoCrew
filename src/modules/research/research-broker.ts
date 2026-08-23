/**
 * 深调研检索代理 broker（深调研 spec §3）——四路视角共用的**唯一**出网口。
 *
 * 存在理由是三条硬约束，任何一条都不能交给模型自觉：
 * 1. **配额是硬闸**：双层（每视角 / 全 job）计数在代码里，超额抛 `BrokerQuotaError`，
 *    子运行把它转成 gaps 记录而不是崩溃——所以错误消息是给人看的人话。
 * 2. **证据不可伪造**：出网拿回来的东西一律登记进 source registry，模型只能引用
 *    登记过的 sourceId；quote 由 `validateQuote` 拿全文做子串判定（空白归一后）。
 * 3. **素材 URL 不经模型转述**：读页时由 fetch 层确定性采集图片候选，broker 登记成
 *    assetId，模型只能按 id 挑。
 *
 * 缓存与配额的关系：**只有真实出网才计配额**。四路撞同一页/同一搜索词只花一次额度，
 * 后来者拿缓存（含并发时共享同一个 in-flight 请求）。这是「共用 broker」的全部意义。
 * 生命周期：per-job 内存实例（全文缓存住在内存里，job 结束即释放）。不落盘。
 */
import { canonicalizeUrl } from "../inbox/url-canonical.js";
import { sanitizeExternal } from "./research-prompt-kit.js";
import { fetchExternalPage } from "../inbox/fetch-external.js";
import type { ExternalPage, FetchExternalOptions } from "../inbox/fetch-external.js";
import { searchWeb } from "./search-provider.js";
import type { WebSearchResult } from "./search-provider.js";

// ─── 配额 ────────────────────────────────────────────────────────────────────

export interface BrokerQuotas {
  searchPerPerspective: number;
  readPagePerPerspective: number;
  searchPerJob: number;
  readPagePerJob: number;
  /** 累计正文字节（UTF-8）上限 */
  textBytesPerJob: number;
  /** 素材候选登记上限——满了不抛错，只是不再登记（素材是尽力而为） */
  assetsPerJob: number;
}

export const DEFAULT_BROKER_QUOTAS: BrokerQuotas = {
  searchPerPerspective: 4,
  readPagePerPerspective: 6,
  searchPerJob: 14,
  readPagePerJob: 20,
  textBytesPerJob: 300 * 1024,
  assetsPerJob: 40,
};

/** 单次搜索取几条结果——多了只是喂噪音给模型 */
const SEARCH_RESULT_COUNT = 6;

export type BrokerQuotaScope = "perspective" | "job";
export type BrokerQuotaKind = "search" | "read_page" | "text_bytes";

/** 配额耗尽。调用方（视角子运行）应捕获并记进 gaps，不是让整条 job 崩掉。 */
export class BrokerQuotaError extends Error {
  constructor(
    readonly scope: BrokerQuotaScope,
    readonly kind: BrokerQuotaKind,
    readonly limit: number,
    readonly used: number,
    message: string,
  ) {
    super(message);
    this.name = "BrokerQuotaError";
  }
}

function quotaError(
  scope: BrokerQuotaScope,
  kind: BrokerQuotaKind,
  limit: number,
  used: number,
  who: string,
): BrokerQuotaError {
  const detail =
    kind === "search"
      ? `搜索次数已用满（上限 ${limit} 次）`
      : kind === "read_page"
        ? `读页次数已用满（上限 ${limit} 页）`
        : `累计正文已达上限（${Math.round(limit / 1024)}KB，已用 ${Math.round(used / 1024)}KB）`;
  return new BrokerQuotaError(scope, kind, limit, used, `${who}${detail}——接下来只能用已经拿到的材料`);
}

// ─── 来源登记 / 素材候选 ─────────────────────────────────────────────────────

export type SourceKind = "search_result" | "page";

export interface ResearchSource {
  /** 搜索结果 s1、s2…；已读页面 p1、p2…（两套序号各自递增） */
  sourceId: string;
  kind: SourceKind;
  /** 登记时的原始 URL（页面即请求 URL） */
  url: string;
  /** 仅 page：跟随重定向后的最终 URL */
  finalUrl?: string;
  title?: string;
  fetchedAt: string;
}

export interface AssetCandidate {
  assetId: string;
  url: string;
  /** 采到它的那一页的 finalUrl——R1b 下载时带 referer / 溯源用 */
  sourcePageUrl: string;
}

export type QuoteCheck = { ok: true } | { ok: false; reason: string };

// ─── 视角句柄的返回契约（W3 依赖） ───────────────────────────────────────────

export interface BrokerSearchHit {
  sourceId: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface BrokerSearchResponse {
  query: string;
  results: BrokerSearchHit[];
  /** true = 命中缓存（未计本路配额） */
  cached: boolean;
}

export interface BrokerPageResponse {
  sourceId: string;
  /** 请求的 URL */
  url: string;
  finalUrl: string;
  title?: string;
  text: string;
  /** 该页采到的素材候选；渲染进 prompt 时以 assetId 为准，模型只能按 id 挑 */
  assetCandidates: { assetId: string; url: string }[];
  cached: boolean;
}

export interface QuotaUse {
  used: number;
  limit: number;
}

export interface BrokerUsage {
  search: QuotaUse;
  readPage: QuotaUse;
  textBytes: QuotaUse;
  assets: QuotaUse;
  sources: number;
  cacheHits: { search: number; page: number };
  perspectives: Record<string, { search: QuotaUse; readPage: QuotaUse }>;
}

export interface PerspectiveBroker {
  readonly name: string;
  search(query: string): Promise<BrokerSearchResponse>;
  readPage(url: string): Promise<BrokerPageResponse>;
}

export interface ResearchBroker {
  /** 同名重复调用返回共享同一份计数的句柄 */
  forPerspective(name: string): PerspectiveBroker;
  getSource(sourceId: string): ResearchSource | null;
  listSources(): ResearchSource[];
  validateQuote(sourceId: string, quote: string): QuoteCheck;
  getAssetCandidate(assetId: string): AssetCandidate | null;
  listAssetCandidates(): AssetCandidate[];
  usage(): BrokerUsage;
}

export type BrokerSearchImpl = (
  query: string,
  opts: { count: number; dataDir?: string },
) => Promise<WebSearchResult[]>;

export type BrokerFetchImpl = (url: string, opts: FetchExternalOptions) => Promise<ExternalPage>;

/**
 * 一次**真实出网**的观测记录（工作日志用）。视角名就是 `forPerspective` 的入参，
 * detail：search = 搜索词原文；read_page = 目标 host（整条长 URL 灌进日志没法读）。
 */
export interface BrokerActivity {
  perspective: string;
  action: "search" | "read_page";
  detail: string;
}

export interface ResearchBrokerDeps {
  searchImpl?: BrokerSearchImpl;
  fetchImpl?: BrokerFetchImpl;
  quotas?: Partial<BrokerQuotas>;
  now?: () => number;
  dataDir?: string;
  /** 搜索缓存键的命名空间：换 provider 即换缓存空间（spec §3 的 (provider, query) 口径） */
  provider?: string;
  /**
   * 出网活动的可见出口。**只在扣额成功后**发——缓存命中与被配额拒掉的调用都不发，
   * 所以事件量天然被配额封顶（每 job ≤14 搜 + ≤20 读）。回调抛错由 broker 吞掉。
   */
  onActivity?: (activity: BrokerActivity) => void;
}

// ─── 空白归一（quote 校验与搜索缓存键共用） ──────────────────────────────────

/** 全角/不换行等空白折成半角空格，连续空白折一格，首尾去空。不动大小写。 */
const SPACE_CHARS = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

export function normalizeWhitespace(text: string): string {
  return text.replace(SPACE_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** 引文语料 = 模型实际看到的形态（展示端同款消毒再折空白），否则逐字复制也会被误杀（冒烟实证） */
export function quoteCorpus(text: string): string {
  return normalizeWhitespace(sanitizeExternal(text, Number.MAX_SAFE_INTEGER));
}

/** 读页事件只报域名：日志是给人扫一眼的，长 URL 会把那一行淹掉。解析不出来就原样退回 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// ─── 实现 ────────────────────────────────────────────────────────────────────

interface SourceEntry {
  source: ResearchSource;
  /** 仅 page：归一后的全文，供 quote 子串判定 */
  normalized: string;
}

type PageCacheEntry = Omit<BrokerPageResponse, "cached">;

class BrokerCore {
  private readonly quotas: BrokerQuotas;
  private readonly searchImpl: BrokerSearchImpl;
  private readonly fetchImpl: BrokerFetchImpl;
  private readonly now: () => number;
  private readonly dataDir?: string;
  private readonly provider: string;
  private readonly onActivity?: (activity: BrokerActivity) => void;

  private readonly perspectives = new Map<string, { search: number; readPage: number }>();
  private jobSearch = 0;
  private jobReadPage = 0;
  private jobTextBytes = 0;
  private readonly cacheHits = { search: 0, page: 0 };

  private readonly searchCache = new Map<string, BrokerSearchHit[]>();
  private readonly searchInflight = new Map<string, Promise<BrokerSearchHit[]>>();
  private readonly pageCache = new Map<string, PageCacheEntry>();
  private readonly pageInflight = new Map<string, Promise<PageCacheEntry>>();

  private readonly sources = new Map<string, SourceEntry>();
  private readonly searchSourceByUrl = new Map<string, string>();
  private readonly assets = new Map<string, AssetCandidate>();
  private readonly assetByUrl = new Map<string, string>();
  private searchSeq = 0;
  private pageSeq = 0;
  private assetSeq = 0;

  constructor(deps: ResearchBrokerDeps) {
    this.quotas = { ...DEFAULT_BROKER_QUOTAS, ...deps.quotas };
    this.searchImpl = deps.searchImpl ?? searchWeb;
    this.fetchImpl = deps.fetchImpl ?? fetchExternalPage;
    this.now = deps.now ?? Date.now;
    this.dataDir = deps.dataDir;
    this.provider = deps.provider ?? "default";
    this.onActivity = deps.onActivity;
  }

  /** 观测层不得破坏执行层：回调炸了也只是这条日志没发出去，检索照跑 */
  private note(perspective: string, action: BrokerActivity["action"], detail: string): void {
    try {
      this.onActivity?.({ perspective, action, detail });
    } catch {
      /* 观测层不得破坏执行层 */
    }
  }

  use(name: string): { search: number; readPage: number } {
    const existing = this.perspectives.get(name);
    if (existing) return existing;
    const fresh = { search: 0, readPage: 0 };
    this.perspectives.set(name, fresh);
    return fresh;
  }

  /** 出网前**先扣额**（reserve）：四路并发时不许两路同时挤过同一个名额 */
  private chargeSearch(name: string): void {
    const use = this.use(name);
    const q = this.quotas;
    if (use.search >= q.searchPerPerspective) {
      throw quotaError("perspective", "search", q.searchPerPerspective, use.search, `视角「${name}」的`);
    }
    if (this.jobSearch >= q.searchPerJob) {
      throw quotaError("job", "search", q.searchPerJob, this.jobSearch, "本次调研的");
    }
    use.search++;
    this.jobSearch++;
  }

  private chargeReadPage(name: string): void {
    const use = this.use(name);
    const q = this.quotas;
    if (use.readPage >= q.readPagePerPerspective) {
      throw quotaError("perspective", "read_page", q.readPagePerPerspective, use.readPage, `视角「${name}」的`);
    }
    if (this.jobReadPage >= q.readPagePerJob) {
      throw quotaError("job", "read_page", q.readPagePerJob, this.jobReadPage, "本次调研的");
    }
    if (this.jobTextBytes >= q.textBytesPerJob) {
      throw quotaError("job", "text_bytes", q.textBytesPerJob, this.jobTextBytes, "本次调研的");
    }
    use.readPage++;
    this.jobReadPage++;
  }

  async search(name: string, query: string): Promise<BrokerSearchResponse> {
    const q = query.trim();
    if (!q) throw new Error("搜索词不能为空");
    const key = `${this.provider}\0${normalizeWhitespace(q).toLowerCase()}`;
    const cached = this.searchCache.get(key);
    if (cached) {
      this.cacheHits.search++;
      return { query: q, results: cached, cached: true };
    }
    const inflight = this.searchInflight.get(key);
    if (inflight) {
      this.cacheHits.search++;
      return { query: q, results: await inflight, cached: true };
    }
    this.chargeSearch(name);
    this.note(name, "search", q);
    const run = this.runSearch(key, q);
    this.searchInflight.set(key, run);
    try {
      return { query: q, results: await run, cached: false };
    } finally {
      this.searchInflight.delete(key);
    }
  }

  private async runSearch(key: string, query: string): Promise<BrokerSearchHit[]> {
    const raw = await this.searchImpl(query, { count: SEARCH_RESULT_COUNT, dataDir: this.dataDir });
    const hits = raw.filter((r) => r.url?.trim()).map((r) => this.registerSearchResult(r));
    this.searchCache.set(key, hits);
    return hits;
  }

  /** 同一 URL 跨查询复用同一个 sourceId——注册表要紧凑，引用要稳定 */
  private registerSearchResult(result: WebSearchResult): BrokerSearchHit {
    const key = canonicalizeUrl(result.url);
    const existing = this.searchSourceByUrl.get(key);
    const sourceId = existing ?? `s${++this.searchSeq}`;
    if (!existing) {
      this.searchSourceByUrl.set(key, sourceId);
      this.sources.set(sourceId, {
        source: {
          sourceId,
          kind: "search_result",
          url: result.url,
          ...(result.title ? { title: result.title } : {}),
          fetchedAt: this.stamp(),
        },
        normalized: "",
      });
    }
    return {
      sourceId,
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    };
  }

  async readPage(name: string, url: string): Promise<BrokerPageResponse> {
    const requested = url.trim();
    if (!requested) throw new Error("读页链接不能为空");
    const key = canonicalizeUrl(requested);
    const cached = this.pageCache.get(key);
    if (cached) {
      this.cacheHits.page++;
      return { ...cached, cached: true };
    }
    const inflight = this.pageInflight.get(key);
    if (inflight) {
      this.cacheHits.page++;
      return { ...(await inflight), cached: true };
    }
    this.chargeReadPage(name);
    this.note(name, "read_page", hostOf(requested));
    const run = this.runReadPage(key, requested);
    this.pageInflight.set(key, run);
    try {
      return { ...(await run), cached: false };
    } finally {
      this.pageInflight.delete(key);
    }
  }

  private async runReadPage(key: string, url: string): Promise<PageCacheEntry> {
    const page = await this.fetchImpl(url, { collectImages: true });
    this.jobTextBytes += Buffer.byteLength(page.text, "utf-8");
    const entry: PageCacheEntry = {
      sourceId: this.registerPage(url, page),
      url,
      finalUrl: page.finalUrl,
      ...(page.title ? { title: page.title } : {}),
      text: page.text,
      assetCandidates: this.registerAssets(page),
    };
    this.pageCache.set(key, entry);
    // 请求 URL 与最终 URL 各占一个缓存位：另一路拿短链/带参链接来读也能命中
    const finalKey = canonicalizeUrl(page.finalUrl);
    if (finalKey !== key) this.pageCache.set(finalKey, entry);
    return entry;
  }

  private registerPage(url: string, page: ExternalPage): string {
    const sourceId = `p${++this.pageSeq}`;
    this.sources.set(sourceId, {
      source: {
        sourceId,
        kind: "page",
        url,
        finalUrl: page.finalUrl,
        ...(page.title ? { title: page.title } : {}),
        fetchedAt: this.stamp(),
      },
      normalized: quoteCorpus(page.text),
    });
    return sourceId;
  }

  /** 素材候选：按规范化 URL 全 job 去重，撞上限就停止登记（不抛错——读页本身仍算成功） */
  private registerAssets(page: ExternalPage): { assetId: string; url: string }[] {
    const picked: { assetId: string; url: string }[] = [];
    for (const candidate of page.imageCandidates ?? []) {
      const key = canonicalizeUrl(candidate.url);
      const existing = this.assetByUrl.get(key);
      if (existing) {
        picked.push({ assetId: existing, url: this.assets.get(existing)!.url });
        continue;
      }
      if (this.assets.size >= this.quotas.assetsPerJob) break;
      const assetId = `a${++this.assetSeq}`;
      this.assets.set(assetId, { assetId, url: candidate.url, sourcePageUrl: page.finalUrl });
      this.assetByUrl.set(key, assetId);
      picked.push({ assetId, url: candidate.url });
    }
    return picked;
  }

  validateQuote(sourceId: string, quote: string): QuoteCheck {
    const entry = this.sources.get(sourceId);
    if (!entry) {
      return { ok: false, reason: `未登记的来源 id「${sourceId}」——只能引用 search / read_page 返回的 sourceId` };
    }
    if (entry.source.kind !== "page") {
      return {
        ok: false,
        reason: `证据必须来自已读页面：「${sourceId}」只是搜索结果，先 read_page 打开它，再引用页面里的原文`,
      };
    }
    const needle = quoteCorpus(quote);
    if (!needle) return { ok: false, reason: "引文不能为空" };
    if (entry.normalized.includes(needle)) return { ok: true };
    return {
      ok: false,
      reason: `引文在「${sourceId}」正文里找不到——从 read_page 显示的正文里逐字复制一段 15~60 字的短句（链接在显示里已折叠为[链接]），不能转述或改写`,
    };
  }

  getSource(sourceId: string): ResearchSource | null {
    return this.sources.get(sourceId)?.source ?? null;
  }

  listSources(): ResearchSource[] {
    return [...this.sources.values()].map((e) => e.source);
  }

  getAssetCandidate(assetId: string): AssetCandidate | null {
    return this.assets.get(assetId) ?? null;
  }

  listAssetCandidates(): AssetCandidate[] {
    return [...this.assets.values()];
  }

  usage(): BrokerUsage {
    const q = this.quotas;
    const perspectives: BrokerUsage["perspectives"] = {};
    for (const [name, use] of this.perspectives) {
      perspectives[name] = {
        search: { used: use.search, limit: q.searchPerPerspective },
        readPage: { used: use.readPage, limit: q.readPagePerPerspective },
      };
    }
    return {
      search: { used: this.jobSearch, limit: q.searchPerJob },
      readPage: { used: this.jobReadPage, limit: q.readPagePerJob },
      textBytes: { used: this.jobTextBytes, limit: q.textBytesPerJob },
      assets: { used: this.assets.size, limit: q.assetsPerJob },
      sources: this.sources.size,
      cacheHits: { ...this.cacheHits },
      perspectives,
    };
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
}

/**
 * 建一个 per-job broker。四路视角各自 `forPerspective(name)` 拿句柄，
 * 缓存/来源登记/素材候选/全 job 配额都在这一个实例里共享。
 */
export function createResearchBroker(deps: ResearchBrokerDeps = {}): ResearchBroker {
  const core = new BrokerCore(deps);
  return {
    forPerspective(name: string): PerspectiveBroker {
      core.use(name); // 先登记，usage() 里零动作的视角也要看得见
      return {
        name,
        search: (query) => core.search(name, query),
        readPage: (url) => core.readPage(name, url),
      };
    },
    getSource: (sourceId) => core.getSource(sourceId),
    listSources: () => core.listSources(),
    validateQuote: (sourceId, quote) => core.validateQuote(sourceId, quote),
    getAssetCandidate: (assetId) => core.getAssetCandidate(assetId),
    listAssetCandidates: () => core.listAssetCandidates(),
    usage: () => core.usage(),
  };
}
