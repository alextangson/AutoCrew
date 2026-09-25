/**
 * 检索代理 broker 的对外契约（深调研 spec §3 / P6 §3.7）：配额形状、来源登记、视角句柄、快照与依赖注入。
 * 实现与这些类型拆开住，`research-broker.ts` 原样再导出，调用方照旧从那边 import。
 */
import type { ExternalPage, FetchExternalOptions } from "../inbox/fetch-external.js";
import type { WebSearchResult } from "./search-provider.js";

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

export type BrokerQuotaScope = "perspective" | "job";
export type BrokerQuotaKind = "search" | "read_page" | "text_bytes";

// ─── 来源登记 / 素材候选 ─────────────────────────────────────────────────────

export type SourceKind = "search_result" | "page" | "user_claim";

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

/**
 * 宿主并发读页的预扣凭据（P6 §3.7）：锁内 `reservePage` 已扣一格读页额度并落盘，
 * 锁外 `fetchReserved` 出网，回锁内 `admitPage` 入账。可序列化——它要跨进程存在任务快照里。
 */
export interface PageTicket {
  perspective: string;
  url: string;
  key: string;
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
  /**
   * 全库定位一段引文：返回正文里逐字含有它的**已读页面** sourceId（无命中 = null）。
   * 存在的意义（2026-08-23 生产复盘）：视角失败的主因不是模型编证据，而是把真引文
   * 记到错的页上——引文是真的就不该杀，校验方用它纠正归属而不是打回。
   */
  locateQuote(quote: string): string | null;
  getAssetCandidate(assetId: string): AssetCandidate | null;
  listAssetCandidates(): AssetCandidate[];
  usage(): BrokerUsage;
  snapshot(): ResearchBrokerSnapshot;
  /** 读页拆三段的第一段：命中缓存直接给页；没命中就预扣额度（超额照样抛 `BrokerQuotaError`）并发凭据 */
  reservePage(perspective: string, url: string): { page: BrokerPageResponse } | { ticket: PageTicket };
  /** 第二段：只出网，不碰任何计数与登记——所以可以在锁外跑 */
  fetchReserved(ticket: PageTicket): Promise<ExternalPage>;
  /** 第三段：把抓回的页登记进来源/素材/正文字节/缓存；同页已入账就复用那一份 */
  admitPage(ticket: PageTicket, page: ExternalPage): BrokerPageResponse;
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

/** Server-written snapshot; never accept this structure from a model/tool argument. */
export interface ResearchBrokerSnapshot {
  version: 1;
  sources: Array<[string, { source: ResearchSource; normalized: string }]>;
  searchCache: Array<[string, BrokerSearchHit[]]>;
  pageCache: Array<[string, Omit<BrokerPageResponse, "cached">]>;
  assets: Array<[string, AssetCandidate]>;
  perspectives: Array<[string, { search: number; readPage: number }]>;
  jobSearch: number; jobReadPage: number; jobTextBytes: number;
  searchSeq: number; pageSeq: number; assetSeq: number;
  cacheHits: { search: number; page: number };
}

export interface ResearchBrokerDeps {
  /** Only restore snapshots previously written by AutoCrew. */
  snapshot?: ResearchBrokerSnapshot;
  /** Host research persists charged quota before network access; failures abort the request. */
  beforeNetwork?: (snapshot: ResearchBrokerSnapshot) => Promise<void>;
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
