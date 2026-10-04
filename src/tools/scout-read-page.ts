/**
 * 宿主读页（P6 §3.7）：选题租约只罩住记账，不罩住出网。
 *
 *   锁内：核任务代次 → 占一个在途名额 → 预扣读页额度，随任务快照落盘 → 放锁
 *   锁外：抓页（最长 15 秒）
 *   锁内：代次没变才把页并进**当时最新**的快照 → 落盘
 *
 * 以前整段都在锁里、快照整份恢复整份覆盖：并发读页要么被拒，要么后写的把先写的扣额盖掉。
 * 同选题至多 4 个在途；抓取失败那一格额度照扣（出网前就扣了），错误里明说。
 */
import crypto from "node:crypto";
import { canonicalizeUrl } from "../modules/inbox/url-canonical.js";
import type { ExternalPage } from "../modules/inbox/fetch-external.js";
import {
  HostResearchError,
  processAlive,
  withHostResearchLock,
  type HostPageRead,
  type HostResearchTask,
} from "../modules/research/host-research-store.js";
import { createResearchBroker, type BrokerPageResponse, type ResearchBroker, type ResearchBrokerDeps } from "../modules/research/research-broker.js";
import { externalBlock, sanitizeExternal } from "../modules/research/research-prompt-kit.js";
import { checkPerspectiveAccess } from "./scout-parallel.js";
import type { PerspectiveName } from "../modules/research/research-job-store.js";

export const MAX_PAGE_READS_IN_FLIGHT = 4;
/** 抓取墙钟 15 秒；两分钟还没入账的在途记录只能是崩掉的进程留下的，不许它永远占着名额 */
const STALE_READ_MS = 2 * 60_000;
const PAGE_WINDOW = 12000;

/** 锁内第一段的产物：锁外要出网的那一次读页（带着发起时的任务代次） */
export class DeferredPageRead {
  constructor(readonly taskId: string, readonly entry: HostPageRead, readonly offset: number) {}
}

export interface PageReadContext {
  topicId: string;
  dir: string;
  host: string;
  /** 凭视角令牌读页的子代理：任务持有者是谁不影响并入（令牌本身就是授权） */
  viaToken?: boolean;
  /** 发起读页时用的视角令牌：并入前在锁内再核一次，令牌已被收回/重领就不并入 */
  perspectiveToken?: string;
  brokerDeps?: Omit<ResearchBrokerDeps, "snapshot" | "dataDir" | "beforeNetwork">;
  view: (task: HostResearchTask) => Record<string, unknown>;
  assertTopic: (task: HostResearchTask) => Promise<void>;
}

function busy(message: string): HostResearchError {
  return new HostResearchError("task_busy", message, { retry_after_seconds: 5 });
}

function cachedPage(broker: ResearchBroker, key: string): boolean {
  return broker.listSources().some((s) => s.kind === "page" && [s.url, s.finalUrl].some((u) => u && canonicalizeUrl(u) === key));
}

/**
 * 第一段（调用方持有选题租约）：命中缓存当场给页；否则占名额、预扣额度并返回待出网的凭据。
 * 名额与同页判定都在扣额**之前**——被拒的调用不许留下扣额（调用方的收尾会把快照整份存下）。
 */
export function reservePageRead(task: HostResearchTask, broker: ResearchBroker, perspective: string, url: string, offset: number): BrokerPageResponse | DeferredPageRead {
  const now = Date.now();
  const reads = (task.pageReads ?? []).filter((r) => now - Date.parse(r.at) < STALE_READ_MS && processAlive(r.pid));
  task.pageReads = reads;
  const key = canonicalizeUrl(url.trim());
  if (!cachedPage(broker, key)) {
    if (reads.some((r) => r.key === key)) throw busy("同一页面正在读取；稍后重试会直接命中缓存，不再扣额");
    if (reads.length >= MAX_PAGE_READS_IN_FLIGHT) throw busy(`同选题已有 ${MAX_PAGE_READS_IN_FLIGHT} 个页面在读取，稍后重试；本次未扣额度`);
  }
  const reserved = broker.reservePage(perspective, url);
  if ("page" in reserved) return reserved.page;
  const entry: HostPageRead = { ...reserved.ticket, id: crypto.randomUUID(), pid: process.pid, at: new Date(now).toISOString() };
  task.pageReads = [...reads, entry];
  return new DeferredPageRead(task.taskId, entry, offset);
}

/** 页面回执：缓存命中与新抓入账走同一份形状 */
export function renderPage(task: HostResearchTask, broker: ResearchBroker, page: BrokerPageResponse, offset: number, view: PageReadContext["view"]): Record<string, unknown> {
  const clean = Array.from(sanitizeExternal(page.text, page.text.length));
  return {
    ...view(task),
    source_id: page.sourceId,
    final_url: page.finalUrl,
    fetched_at: broker.getSource(page.sourceId)?.fetchedAt,
    source: "verified_quote",
    page: externalBlock([clean.slice(offset, offset + PAGE_WINDOW).join("")]),
    ...(offset + PAGE_WINDOW < clean.length ? { next_offset: offset + PAGE_WINDOW } : {}),
    asset_candidates: page.assetCandidates,
    cached: page.cached,
    usage: broker.usage(),
    note: "已抓取页面快照；cite只核验引文逐字存在，不证明宿主对该引文的解释为真。",
  };
}

/** 第二、三段：锁外抓取，再取租约并入最新快照。任务换代就丢弃结果；抓取失败照实报、额度不退 */
export async function finishPageRead(read: DeferredPageRead, ctx: PageReadContext): Promise<Record<string, unknown>> {
  let page: ExternalPage | undefined;
  let failure: unknown;
  try {
    page = await createResearchBroker({ ...ctx.brokerDeps, dataDir: ctx.dir }).fetchReserved(read.entry);
  } catch (err) {
    failure = err;
  }
  return withHostResearchLock(ctx.topicId, ctx.dir, async (current, save) => {
    if (!current || current.taskId !== read.taskId)
      throw new HostResearchError("stale_task", "读页期间研究任务已换代，抓回的页面没有并入新任务；预扣的额度随旧任务作废");
    current.pageReads = (current.pageReads ?? []).filter((r) => r.id !== read.entry.id);
    const broker = createResearchBroker({ ...ctx.brokerDeps, dataDir: ctx.dir, snapshot: current.broker });
    // 并入前在锁内重核视角归属：带令牌的核令牌还有效；不带令牌的核这一路没被别人认领走（读页途中可能刚被领走）
    if (page) {
      try { checkPerspectiveAccess(current, read.entry.perspective as PerspectiveName, ctx.perspectiveToken ?? ""); } catch (err) {
        await save(current);
        throw err;
      }
    }
    if (!page || (current.host !== ctx.host && !ctx.viaToken)) {
      await save(current);
      if (page) throw new HostResearchError("lease_lost", `读页期间任务已由 ${current.host} 接管，页面未并入`, { holder: current.host });
      const reason = failure instanceof Error ? failure.message : String(failure);
      throw new HostResearchError("page_fetch_failed", `${reason}（这次读页的额度在出网前已扣除，失败不退回；换个来源或用已读材料继续）`, { quota_consumed: true, usage: broker.usage() });
    }
    const admitted = broker.admitPage(read.entry, page);
    current.broker = broker.snapshot();
    await save(current);
    await ctx.assertTopic(current);
    return renderPage(current, broker, admitted, read.offset, ctx.view);
  });
}
