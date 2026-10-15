/**
 * 同一本手册、同一个底版本的几条意见补充合并批（spec 2026-10-15 §A4）：
 * 一次定完——要的那几条一起追加进一个新版本，不要的记否决；不会出现「批一条、其余作废」。
 * 底版本已经不是当前版本（别处改过 / 回滚过）→ 整组 stale，手册内容不变，提案标过期，调用方整组提示重提。
 * 和单条决定共用 serialize 队列、事件日志（eventId 幂等）。
 */
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { appendSupplement, checkSize, logEvent, markStale, nextVersion, pendingProposal, replay, saidOf, type DecisionMeta } from "./changes.js";
import { entryOf, manifestInQueue, readVersionText, serialize, shortHash, writeManifest, writeNextVersion } from "./store.js";
import { PlaybookError, type PlaybookId, type PlaybookProposal } from "./types.js";

type R = Record<string, unknown>;

export interface BatchItem { proposal_id: string; gen: string; decision: "approve" | "reject" }
export interface LessonBatch extends DecisionMeta { id: PlaybookId; based_on: number; items: BatchItem[] }

function checkItems(input: LessonBatch, found: PlaybookProposal[]): void {
  if (!input.items.length) throw new PlaybookError("bad_param", "合并批至少要一条");
  if (new Set(input.items.map((i) => i.proposal_id)).size !== input.items.length) throw new PlaybookError("bad_param", "同一条提案在这一批里出现了两次");
  const odd = found.find((p) => p.kind !== "lesson" || p.based_on !== input.based_on);
  if (odd) throw new PlaybookError("bad_param", `提案 ${odd.id} 不是第 ${input.based_on} 版上的意见补充，不能合并批`);
}

/** 按时间先后把要的几条追加进底版本全文 */
async function mergedText(input: LessonBatch, approved: PlaybookProposal[], dataDir?: string): Promise<string> {
  let text = await readVersionText(input.id, input.based_on, dataDir);
  for (const p of [...approved].sort((a, b) => a.at.localeCompare(b.at))) text = appendSupplement(text, p.lesson ?? p.reason, saidOf(p));
  checkSize(text);
  return text;
}

export function decideLessonBatch(input: LessonBatch, dataDir?: string): Promise<R> {
  return serialize(dataDir, async () => {
    const m = await manifestInQueue(dataDir);
    const fp = shortHash(["batch", input.id, input.based_on, [...input.items].sort((a, b) => a.proposal_id.localeCompare(b.proposal_id))]);
    const prior = replay(m, input.eventId, fp);
    if (prior) return prior;
    const e = entryOf(m, input.id);
    const found = input.items.map((i) => pendingProposal(e, { id: input.id, proposal_id: i.proposal_id, gen: i.gen }));
    checkItems(input, found);
    const approved = found.filter((_, k) => input.items[k].decision === "approve");
    const rejected = found.filter((_, k) => input.items[k].decision === "reject");
    const at = new Date().toISOString();
    if (approved.length && e.current !== input.based_on) {
      markStale(e, at);
      await writeManifest(m, dataDir);
      throw new PlaybookError("stale", `手册已经改过（现在是第 ${e.current} 版），这几条要按新版重提`, { current: e.current });
    }
    const meta = { eventId: input.eventId, fp, playbook: input.id, proposal_ids: found.map((p) => p.id), source: input.source, ...(input.founder_words ? { founder_words: input.founder_words } : {}), ...(input.requested_by ? { requested_by: input.requested_by } : {}) };
    for (const p of rejected) Object.assign(p, { status: "rejected", decided_at: at });
    if (!approved.length) {
      logEvent(m, { ...meta, type: "reject" }, at);
      await writeManifest(m, dataDir);
      return { ok: true, playbook: input.id, decision: "batch", approved: [], rejected: rejected.map((p) => p.id) };
    }
    const text = await mergedText(input, approved, dataDir);
    assertDataDirWritable(dataDir);
    const version = await writeNextVersion(input.id, nextVersion(e), text, dataDir);
    e.versions.push({ version, at, author: "founder", kind: "edit", founder_words: approved.map(saidOf).join(" / "), reason: "写稿时创始人的意见（合并批）", based_on: input.based_on, proposal_id: approved[0].id });
    e.current = version;
    for (const p of approved) Object.assign(p, { status: "approved", decided_at: at });
    markStale(e, at);
    logEvent(m, { ...meta, type: "approve", version }, at);
    await writeManifest(m, dataDir);
    return { ok: true, playbook: input.id, decision: "batch", version, approved: approved.map((p) => p.id), rejected: rejected.map((p) => p.id) };
  });
}
