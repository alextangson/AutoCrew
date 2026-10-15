/**
 * 体裁手册改动在对话里批（spec 2026-10-13 §3、§9.6）：批 / 不批。
 * 照 writing_rule 的做法：eventId = chat-<request_id> 记进手册 manifest 的决定日志；
 * 崩在「manifest 已提交、请求结果没落盘」之间时，先按事件日志找回（在 locate 之前），回放原来的成功结果。
 */
import { decideProposal, recoverPlaybookEvent } from "../../playbook/changes.js";
import { loadManifest } from "../../playbook/store.js";
import { diffText, type DiffHunk } from "../../playbook/diff.js";
import { PlaybookError, type PlaybookId } from "../../playbook/types.js";
import type { InboxItem } from "../inbox.js";
import { lessonQuestion } from "../lesson-view.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });

export const PLAYBOOK_DECISIONS: ReadonlySet<string> = new Set(["approve_playbook", "reject_playbook"]);

const DONE = (r: Result) => (r.decision === "reject" ? "这份手册改动不要了，同一段文字以后不再提" : `手册更新到第 ${String(r.version)} 版，之后新出的立意用这一版；已经在写的稿不换`);

/** 已经按这个请求号记过：回放（不再去收件箱找已消失的条目） */
export async function recoverPlaybookDecision(requestId: string, dataDir: string): Promise<Result | null> {
  const r = await recoverPlaybookEvent(`chat-${requestId}`, dataDir);
  if (!r) return null;
  return { ...r, decision: r.decision === "reject" ? "reject_playbook" : "approve_playbook", recorded_as: "chat", next_action: "告诉创始人：这个决定之前已经记下了。" };
}

/** 条目已不在收件箱：如果是因为手册升级过期了，说 stale（不是「已在别处处理」） */
export async function staleProposal(itemId: string, dataDir: string): Promise<Result | null> {
  if (!itemId.startsWith("playbook:")) return null;
  const id = itemId.slice("playbook:".length);
  const m = await loadManifest(dataDir);
  const p = m.playbooks.flatMap((e) => e.proposals).find((x) => x.id === id);
  return p?.status === "stale" ? fail("stale", "这份提案已过期（手册之后改过版本），手册没变：告诉创始人，需要的话按最新版重新提案") : null;
}

/** 给创始人的「要你判断」：哪本手册、改前改后（只列有改动的段落）、他的原话 */
export function playbookBrief(item: InboxItem): string {
  const d = item.detail;
  return [
    `体裁手册改动提案：《${String(d.playbook_name)}》第 ${String(d.based_on)} 版 → 新版本`,
    ...(d.reason ? [`为什么改：${String(d.reason)}`] : []),
    ...(d.words_text ? [`你当时的原话：${String(d.words_text)}`] : []),
    diffText((d.diff as DiffHunk[] | undefined) ?? []),
    `要你判断：${String(d.question ?? lessonQuestion("playbook_change", String(d.playbook_name ?? "")))}`,
    "回我「批」/「不要」",
  ].join("\n");
}

export interface PlaybookCommitInput { decision: string; founder_words: string; request_id: string; requester: string }

export async function playbookCommit(item: InboxItem, input: PlaybookCommitInput, dataDir: string): Promise<Result> {
  try {
    const r = await decideProposal({
      id: item.detail.playbook as PlaybookId, proposal_id: String(item.detail.proposal_id), gen: item.gen,
      decision: input.decision === "reject_playbook" ? "reject" : "approve", eventId: `chat-${input.request_id}`,
      source: "chat", founder_words: input.founder_words, requested_by: input.requester,
    }, dataDir);
    return { ...r, decision: input.decision, recorded_as: "chat", next_action: `告诉创始人：${DONE(r)}。` };
  } catch (e) {
    if (!(e instanceof PlaybookError)) throw e;
    if (e.code === "stale") return fail("stale", `${e.message}。告诉创始人这份过期了，需要的话按最新版重新提案`);
    return fail(e.code, e.message, e.extra);
  }
}
