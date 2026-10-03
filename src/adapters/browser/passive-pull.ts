/**
 * 旁听抓取的平台无关骨架（规格 docs/2026-10-03-metrics-pull-human-like-spec.md）。
 *
 * 每个平台只声明：官方数据页 URL、要旁听的响应路径、登录/风控页特征、怎么翻页（滚动或点「下一页」）、
 * 怎么从响应判断「还翻不翻」（inspectSrc，在 ego 子进程里跑）、怎么把一条响应解析成行（parseResponse）。
 * 这里负责：开会话旁听 → 每页独立校验 → 已拿到的完整页照常交回 → 状态可见。
 *
 * 红线：代码不向平台后台发任何请求，只读页面自己收到的响应。
 */
import { EgoSession, type BrowseOutcome, type CapturedPage, type CapturedResponse, type EgoRunner } from "./ego-session.js";
import type { BrowseParams } from "./ego-scripts.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import { PAGE_ROW_LIMIT, classifyThrown, failure, keepValidRows, sanitizeErrorCode } from "./pull-shared.js";

/** 创始人裁定：只取最近 30 天发布的作品，最多 3 页 */
export const LOOKBACK_DAYS = 30;
export const MAX_BROWSE_PAGES = 3;
/** 翻页动作之间随机停 2–6 秒 */
export const PAUSE_RANGE_MS: [number, number] = [2_000, 6_000];

export type PageParse = { kind: "ok"; rows: TypedRow[] } | { kind: "stop"; result: PullResult };

export interface PassivePlatform {
  /** TaskSpace 名字里的平台标识 */
  label: string;
  url: string;
  follow?: BrowseParams["follow"];
  patterns: string[];
  gates: BrowseParams["gates"];
  next: BrowseParams["next"];
  inspectSrc: string;
  parseResponse(resp: CapturedResponse): PageParse;
}

export interface PassivePullOptions {
  now?: () => Date;
  /** 测试注入点：默认真 ego lite 会话 */
  session?: { browse(p: Omit<BrowseParams, "space">): Promise<BrowseOutcome> };
  runner?: EgoRunner;
  totalTimeoutMs?: number;
  pauseMs?: [number, number];
  waitMs?: number;
  limit?: number;
}

/** 一页可能收到多条匹配响应（抖音会发好几条）：任一条解析成功就算这页拿到了；全失败时登录优先 */
export function parsePage(platform: PassivePlatform, page: CapturedPage): PageParse {
  const parses = page.responses.map((r) => platform.parseResponse(r));
  const oks = parses.filter((p): p is Extract<PageParse, { kind: "ok" }> => p.kind === "ok");
  if (oks.length > 0) return { kind: "ok", rows: oks.flatMap((p) => p.rows) };
  const stops = parses.filter((p): p is Extract<PageParse, { kind: "stop" }> => p.kind === "stop");
  const pick = stops.find((s) => s.result.status === "risk_control") ?? stops.find((s) => s.result.status === "needs_login") ?? stops[0];
  return pick ?? { kind: "stop", result: failure("error", "no_data_response") };
}

/** 是什么让这次旁听停下的（不是失败就 null） */
function endingFailure(o: BrowseOutcome): PullResult | null {
  if (o.end === "error") return classifyThrown(o.error);
  if (o.gate === "risk") return failure("risk_control", "risk_page");
  if (o.gate === "login") return failure("needs_login", "login_page");
  if (o.end === "no_response") return failure("error", "no_data_response");
  return null;
}

/** 行收口：行级校验 → 去重 → 丢掉 30 天前发布的 → 上限 */
function finalizeRows(rows: TypedRow[], cutoffMs: number, limit: number): { rows: TypedRow[]; over: boolean } {
  const seen = new Set<string>();
  const kept: TypedRow[] = [];
  for (const row of keepValidRows(rows).rows) {
    if (row.publishedAt && Date.parse(row.publishedAt) < cutoffMs) continue;
    const key = row.platformItemId ?? `${row.title}@${row.publishedAt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return { rows: kept.slice(0, limit), over: kept.length > limit };
}

/**
 * 旁听结果 → 最终状态（纯函数）。每页独立校验：第 k 页坏了，前 k-1 页照常交回，状态 ok + 可见的 partial 错误码；
 * 第 1 页就坏 / 没拿到任何页 → 对应失败状态，零行。
 */
export function judgeBrowse(platform: PassivePlatform, o: BrowseOutcome, cutoffMs: number, limit = PAGE_ROW_LIMIT): PullResult {
  const rows: TypedRow[] = [];
  let good = 0;
  let pageFailure: PullResult | null = null;
  for (const page of o.pages) {
    const parsed = parsePage(platform, page);
    if (parsed.kind === "stop") {
      pageFailure = parsed.result;
      break;
    }
    rows.push(...parsed.rows);
    good += 1;
  }
  const tail = pageFailure ?? endingFailure(o);
  if (good === 0) return tail ?? failure("error", "no_data_response");
  const done = finalizeRows(rows, cutoffMs, limit);
  const note = tail
    ? sanitizeErrorCode(`partial:${tail.status}:${tail.errorCode ?? ""}`)
    : o.end === "pagination_missing" && good === 1
      ? "only_first_page"
      : undefined;
  return {
    status: "ok",
    rows: done.rows,
    hasMore: o.end === "max_pages" || done.over,
    pages: good,
    ...(note ? { errorCode: note } : {}),
  };
}

export async function runPassivePull(platform: PassivePlatform, opts: PassivePullOptions = {}): Promise<PullResult> {
  const now = (opts.now ?? (() => new Date()))();
  const cutoffMs = now.getTime() - LOOKBACK_DAYS * 86_400_000;
  const [pauseMinMs, pauseMaxMs] = opts.pauseMs ?? PAUSE_RANGE_MS;
  let outcome: BrowseOutcome;
  try {
    const session = opts.session ?? new EgoSession({ label: platform.label, runner: opts.runner, totalTimeoutMs: opts.totalTimeoutMs });
    outcome = await session.browse({
      url: platform.url,
      ...(platform.follow ? { follow: platform.follow } : {}),
      patterns: platform.patterns,
      gates: platform.gates,
      next: platform.next,
      inspectSrc: platform.inspectSrc,
      cutoffMs,
      maxPages: MAX_BROWSE_PAGES,
      waitMs: opts.waitMs ?? 25_000,
      nextWaitMs: 12_000,
      settleMs: 1_500,
      navTimeoutMs: 30_000,
      pauseMinMs,
      pauseMaxMs,
    });
  } catch (err) {
    return classifyThrown(err);
  }
  return judgeBrowse(platform, outcome, cutoffMs, opts.limit ?? PAGE_ROW_LIMIT);
}
