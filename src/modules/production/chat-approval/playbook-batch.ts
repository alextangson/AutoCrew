/**
 * 对话里合并批同一本手册的几条意见（spec 2026-10-15 §A4）：decision "playbook_batch" + items[{item_id, gen, decision}]。
 * 同一篇稿、同一 merge_key（手册 + 底版本）的每一条都得列上，一次生成一个新版本；
 * 单条 approve_playbook 碰上还有同组兄弟时拒（use_batch），免得「批一条、其余作废」。
 */
import { maybeJson, UNPARSABLE } from "../../publish/review-gate/plan.js";
import { decideLessonBatch, type BatchItem } from "../../playbook/batch.js";
import { recoverPlaybookEvent } from "../../playbook/changes.js";
import { PlaybookError, type PlaybookId } from "../../playbook/types.js";
import { readInbox } from "../inbox-read.js";
import type { InboxItem } from "../inbox.js";
import { mergeKeyOf } from "../lesson-view.js";
import { staleProposal } from "./playbook-decide.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });

export interface BatchEntry { item_id: string; gen: string; decision: "approve_playbook" | "reject_playbook" }

/** items 归一（中转会把数组变字符串）：数组直接用，字符串解析（修引号重试），真解析不了才拒 */
export function parseBatchItems(raw: unknown): BatchEntry[] | string {
  const v = maybeJson(raw);
  if (v === UNPARSABLE) return "items 看着是 JSON，但修过引号也解析不了：检查括号与逗号";
  if (!Array.isArray(v) || !v.length) return "playbook_batch 要带 items：[{item_id, gen, decision:approve_playbook|reject_playbook}]，同组每一条都列上";
  const out: BatchEntry[] = [];
  for (const [k, raw1] of v.entries()) {
    const x = maybeJson(raw1) as Record<string, unknown> | null;
    const ok = x && typeof x.item_id === "string" && typeof x.gen === "string" && (x.decision === "approve_playbook" || x.decision === "reject_playbook");
    if (!ok) return `items[${k}] 要是 {item_id, gen, decision:approve_playbook|reject_playbook}`;
    out.push({ item_id: x.item_id as string, gen: x.gen as string, decision: x.decision as BatchEntry["decision"] });
  }
  return out;
}

/** 同组兄弟：同一篇稿、同一份合并改动里还在等的几条 */
export function siblingsOf(item: InboxItem, all: InboxItem[]): InboxItem[] {
  const key = mergeKeyOf(item.detail);
  if (!key || !item.content_id) return [item];
  return all.filter((x) => x.type === "playbook_change" && x.content_id === item.content_id && mergeKeyOf(x.detail) === key);
}

/** 单条批准前的检查：还有同组兄弟 → 让 agent 改用合并批 */
export function batchRequired(item: InboxItem, all: InboxItem[], decision: string): Result | null {
  if (decision !== "approve_playbook") return null;
  const sib = siblingsOf(item, all);
  if (sib.length < 2) return null;
  return fail("use_batch", `这条和同一篇稿的另外 ${sib.length - 1} 条是同一本手册的同一份改动：用 decision:"playbook_batch" 带 items 一次定完（每条都列上，要的 approve_playbook、不要的 reject_playbook）`,
    { item_ids: sib.map((x) => x.item_id) });
}

async function pick(entries: BatchEntry[], dataDir: string): Promise<{ ok: true; items: InboxItem[] } | { ok: false; result: Result }> {
  const all = (await readInbox(dataDir, { withDrafts: true })).items;
  const items: InboxItem[] = [];
  for (const e of entries) {
    const it = all.find((x) => x.item_id === e.item_id);
    // 不在收件箱了：先看是不是手册在别处改过、这条过期了（整组说 stale），再说已在别处处理
    const stale = it ? null : await staleProposal(e.item_id, dataDir);
    if (stale) return { ok: false, result: fail("stale", "手册已经改过，这几条要按新版重提：整组告诉创始人", { item_id: e.item_id }) };
    if (!it || it.type !== "playbook_change") return { ok: false, result: fail("already_handled", `${e.item_id} 已在别处处理（或不是手册改动）：重新 list 看现在的样子`) };
    if (it.gen !== e.gen) return { ok: false, result: fail("stale", `${e.item_id} 刚变过：重新 list 给创始人看一遍再定`) };
    items.push(it);
  }
  const sib = siblingsOf(items[0], all);
  const keys = new Set(items.map((x) => `${x.content_id}|${mergeKeyOf(x.detail)}`));
  if (keys.size !== 1 || !mergeKeyOf(items[0].detail)) return { ok: false, result: fail("bad_batch", "这几条不是同一篇稿、同一本手册、同一个底版本的意见补充，不能合并批") };
  const missing = sib.filter((x) => !entries.some((e) => e.item_id === x.item_id));
  if (missing.length) return { ok: false, result: fail("incomplete_batch", "同一份改动还有几条没列上：每条都要定（要 / 不要），问清创始人再一起交", { missing: missing.map((x) => x.item_id) }) };
  return { ok: true, items };
}

export interface BatchCommitInput { entries: BatchEntry[]; founder_words: string; request_id: string; requester: string }

export async function playbookBatchCommit(input: BatchCommitInput, dataDir: string): Promise<Result> {
  const replayed = await recoverPlaybookEvent(`chat-${input.request_id}`, dataDir);
  if (replayed) return { ...replayed, recorded_as: "chat", next_action: "告诉创始人：这个决定之前已经记下了。" };
  const found = await pick(input.entries, dataDir);
  if (!found.ok) return found.result;
  const d = found.items[0].detail;
  const items: BatchItem[] = found.items.map((it, k) => ({ proposal_id: String(it.detail.proposal_id), gen: it.gen, decision: input.entries[k].decision === "approve_playbook" ? "approve" : "reject" }));
  try {
    const r = await decideLessonBatch({ id: d.playbook as PlaybookId, based_on: Number(d.based_on), items, eventId: `chat-${input.request_id}`, source: "chat", founder_words: input.founder_words, requested_by: input.requester }, dataDir);
    const done = r.version ? `手册《${String(d.playbook_name)}》更新到第 ${String(r.version)} 版（要的几条一起进了这一版）` : "这几条都不要了";
    return { ...r, recorded_as: "chat", next_action: `告诉创始人：${done}。` };
  } catch (e) {
    if (!(e instanceof PlaybookError)) throw e;
    if (e.code === "stale") return fail("stale", `${e.message}。整组告诉创始人：手册已经改过，这几条要按新版重提`);
    return fail(e.code, e.message, e.extra);
  }
}
