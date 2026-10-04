/**
 * read / cite（实现规格；会审 #7）：抓页复用 research-broker，快照按稿件持久化（draft-research.json），
 * page_id 的序号跨重启延续；引文逐字核对复用 validateQuote，过了才记进这篇的证据台账（Content.evidenceLedger）。
 */
import fs from "node:fs/promises";
import { contentFile, isMissing } from "../../storage/content-project.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { getContent, updateContent } from "../../storage/local-store.js";
import { createResearchBroker, type BrokerFetchImpl, type ResearchBrokerSnapshot } from "../research/research-broker.js";
import { restoreEvidenceLedger, type EvidenceLedgerSnapshot, type LedgerEntry } from "../research/evidence-ledger.js";

const SNAPSHOT_FILE = "draft-research.json";
const PERSPECTIVE = "draft";
/** 一篇稿最多读 30 页：够查一个方向，又不至于把正文字节灌满资料库 */
const QUOTAS = { readPagePerPerspective: 30, readPagePerJob: 30, searchPerPerspective: 0, searchPerJob: 0, textBytesPerJob: 3 * 1024 * 1024 };
export const READ_TEXT_MAX = 12_000;

let fetchOverride: BrokerFetchImpl | undefined;
/** 只给测试：替换真实抓页 */
export function setDraftFetch(fn: BrokerFetchImpl | undefined): void { fetchOverride = fn; }

const queues = new Map<string, Promise<unknown>>();
export function serializeDraft<T>(contentId: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(contentId) ?? Promise.resolve()).then(task, task);
  queues.set(contentId, next);
  const done = () => { if (queues.get(contentId) === next) queues.delete(contentId); };
  next.then(done, done);
  return next;
}

async function loadSnapshot(contentId: string, dataDir?: string): Promise<ResearchBrokerSnapshot | undefined> {
  try { return JSON.parse(await fs.readFile(contentFile(contentId, dataDir, SNAPSHOT_FILE), "utf8")) as ResearchBrokerSnapshot; }
  catch (e) { if (isMissing(e)) return undefined; throw e; }
}

function brokerFor(contentId: string, snapshot: ResearchBrokerSnapshot | undefined, dataDir?: string) {
  const persist = (s: ResearchBrokerSnapshot) => writeJsonAtomicMkdir(contentFile(contentId, dataDir, SNAPSHOT_FILE), s);
  return { broker: createResearchBroker({ snapshot, dataDir, quotas: QUOTAS, beforeNetwork: persist, ...(fetchOverride ? { fetchImpl: fetchOverride } : {}) }), persist };
}

export async function readPageForDraft(contentId: string, url: string, dataDir?: string): Promise<Record<string, unknown>> {
  return serializeDraft(contentId, async () => {
    const { broker, persist } = brokerFor(contentId, await loadSnapshot(contentId, dataDir), dataDir);
    const page = await broker.forPerspective(PERSPECTIVE).readPage(url);
    await persist(broker.snapshot());
    return {
      ok: true, page_id: page.sourceId, url: page.url, final_url: page.finalUrl, title: page.title ?? null,
      text: page.text.slice(0, READ_TEXT_MAX), truncated: page.text.length > READ_TEXT_MAX, total_chars: page.text.length, cached: page.cached,
    };
  });
}

const EMPTY: EvidenceLedgerSnapshot = { entries: [], lookups: [], budget: { max: 0, used: 0 } };

function nextEvidenceId(entries: readonly LedgerEntry[]): string {
  const max = entries.reduce((m, e) => Math.max(m, Number(/^ev-d(\d+)$/.exec(e.id)?.[1] ?? 0)), 0);
  return `ev-d${max + 1}`;
}

export type CiteResult = { ok: true; evidence_id: string; duplicate: boolean } | { ok: false; code: string; error: string };

/** 逐字核对过才入台账；同页同引文重复登记返回原编号 */
export async function citeForDraft(contentId: string, pageId: string, quote: string, claim: string | undefined, dataDir?: string): Promise<CiteResult> {
  return serializeDraft(contentId, async () => {
    const { broker } = brokerFor(contentId, await loadSnapshot(contentId, dataDir), dataDir);
    const check = broker.validateQuote(pageId, quote);
    if (!check.ok) return { ok: false, code: "quote_not_found", error: check.reason };
    const content = await getContent(contentId, dataDir);
    if (!content) return { ok: false, code: "not_found", error: `稿件不存在：${contentId}` };
    const ledger = restoreEvidenceLedger(content.evidenceLedger ?? EMPTY);
    const same = ledger.entries().find((e) => e.sourceId === pageId && e.quote === quote.trim());
    if (same) return { ok: true, evidence_id: same.id, duplicate: true };
    const source = broker.getSource(pageId)!;
    const entry = ledger.add({ id: nextEvidenceId(ledger.entries()), source: "verified_quote", quote: quote.trim(), sourceId: pageId, sourceUrl: source.finalUrl ?? source.url, ...(claim?.trim() ? { claim: claim.trim() } : {}) });
    await updateContent(contentId, { evidenceLedger: ledger.snapshot() }, dataDir);
    return { ok: true, evidence_id: entry.id, duplicate: false };
  });
}
