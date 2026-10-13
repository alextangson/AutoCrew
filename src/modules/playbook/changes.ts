/**
 * 手册改动（spec §3、§9.5–9.7）：提案 → 等你拍板 → 新版本；回滚由创始人直接发起。
 * 全部在 serialize 队列里：先查 → 写版本文件 → 最后写 manifest（提交点）。
 * 决定按 eventId 幂等：同号同内容重放上次结果，同号换内容 request_conflict。
 */
import { randomUUID } from "node:crypto";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { charCount, entryOf, manifestInQueue, readVersionText, serialize, shortHash, writeManifest, writeVersionOnce } from "./store.js";
import { PLAYBOOK_MAX_CHARS, PlaybookError, type PlaybookEntry, type PlaybookEvent, type PlaybookId, type PlaybookManifest, type PlaybookProposal } from "./types.js";

type R = Record<string, unknown>;
const EVENTS_KEPT = 1000;
const SUPPLEMENT = "## 创始人补充";

const genOf = (p: Pick<PlaybookProposal, "id" | "based_on" | "text">) => shortHash([p.id, p.based_on, p.text]);
const nextVersion = (e: PlaybookEntry) => Math.max(...e.versions.map((v) => v.version)) + 1;

function checkSize(text: string): void {
  const n = charCount(text);
  if (n > PLAYBOOK_MAX_CHARS) throw new PlaybookError("too_long", `手册全文 ${n} 字，超过上限 ${PLAYBOOK_MAX_CHARS} 字：压缩后再提案`, { chars: n, max: PLAYBOOK_MAX_CHARS });
}

/** 当前版本变了：挂在旧版本上的待批提案全部过期 */
function markStale(e: PlaybookEntry, at: string): void {
  for (const p of e.proposals) if (p.status === "pending" && p.based_on !== e.current) { p.status = "stale"; p.decided_at = at; }
}

/** 把一条意见追加进「## 创始人补充」一节（没有就新建在末尾）；不调模型，结果确定 */
export function appendSupplement(text: string, lesson: string, founderWords: string): string {
  const bullet = `- ${lesson}（创始人原话：「${founderWords}」）`;
  const lines = text.replace(/\s+$/, "").split("\n");
  const at = lines.findIndex((l) => l.trim() === SUPPLEMENT);
  if (at < 0) return `${lines.join("\n")}\n\n${SUPPLEMENT}\n\n${bullet}\n`;
  const after = lines.slice(at + 1).findIndex((l) => /^## /.test(l));
  const end = after < 0 ? lines.length : at + 1 + after;
  let insert = end;
  while (insert > at + 1 && !lines[insert - 1].trim()) insert--;
  lines.splice(insert, 0, bullet);
  return `${lines.join("\n")}\n`;
}

export interface LessonProposalInput { id: PlaybookId; lesson: string; founder_words: string; origin?: { content_id: string; version: number } }
export type LessonProposalOutcome = "playbook_proposed" | "playbook_duplicate" | "blocked_by_rejected";

/** 写稿意见（scope playbook:<id>）挂成一条待批提案；同文待批 = duplicate，否决过 = blocked_by_rejected */
export function proposeLesson(input: LessonProposalInput, dataDir?: string): Promise<{ outcome: LessonProposalOutcome; proposal_id: string }> {
  return serialize(dataDir, async () => {
    const m = await manifestInQueue(dataDir);
    const e = entryOf(m, input.id);
    const same = (p: PlaybookProposal) => p.kind === "lesson" && p.lesson?.trim() === input.lesson.trim();
    const rejected = e.proposals.find((p) => same(p) && p.status === "rejected");
    if (rejected) return { outcome: "blocked_by_rejected" as const, proposal_id: rejected.id };
    const pending = e.proposals.find((p) => same(p) && p.status === "pending");
    if (pending) return { outcome: "playbook_duplicate" as const, proposal_id: pending.id };
    const text = appendSupplement(await readVersionText(input.id, e.current, dataDir), input.lesson.trim(), input.founder_words);
    checkSize(text);
    const id = `pp-${randomUUID()}`;
    const p: PlaybookProposal = { id, kind: "lesson", based_on: e.current, text, lesson: input.lesson.trim(), founder_words: input.founder_words,
      reason: "写稿时创始人的意见", gen: "", status: "pending", at: new Date().toISOString(), ...(input.origin ? { origin: input.origin } : {}) };
    p.gen = genOf(p);
    e.proposals.push(p);
    await writeManifest(m, dataDir);
    return { outcome: "playbook_proposed" as const, proposal_id: id };
  });
}

export interface RevisionInput { id: PlaybookId; based_on: number; text: string; reason: string; founder_words: string }

/** agent 交的整本修订：绑定 based_on；过期、超长、没改动、否决过的同文都拒 */
export function proposeRevision(input: RevisionInput, dataDir?: string): Promise<R> {
  return serialize(dataDir, async () => {
    checkSize(input.text);
    const m = await manifestInQueue(dataDir);
    const e = entryOf(m, input.id);
    if (input.based_on !== e.current) throw new PlaybookError("stale", `手册现在是第 ${e.current} 版，不是你读到的第 ${input.based_on} 版：先 get 最新版再改`, { current: e.current });
    if (input.text === await readVersionText(input.id, e.current, dataDir)) throw new PlaybookError("no_change", "全文和当前版本一样，没有可提的改动");
    const same = e.proposals.find((p) => p.kind === "revision" && p.text === input.text && (p.status === "pending" || p.status === "rejected"));
    if (same?.status === "rejected") throw new PlaybookError("blocked_by_rejected", "同一份全文创始人否决过，不再提", { proposal_id: same.id });
    if (same) return { ok: true, duplicate: true, proposal_id: same.id, gen: same.gen };
    const p: PlaybookProposal = { id: `pp-${randomUUID()}`, kind: "revision", based_on: e.current, text: input.text, founder_words: input.founder_words,
      reason: input.reason, gen: "", status: "pending", at: new Date().toISOString() };
    p.gen = genOf(p);
    e.proposals.push(p);
    await writeManifest(m, dataDir);
    return { ok: true, proposal_id: p.id, gen: p.gen, based_on: p.based_on };
  });
}

export interface DecisionMeta { eventId: string; source: PlaybookEvent["source"]; founder_words?: string; requested_by?: string }

/** 同一 eventId：内容相同 → 回放；不同 → request_conflict。没有 → null */
function replay(m: PlaybookManifest, eventId: string, fp: string): R | null {
  const prior = m.events.find((x) => x.eventId === eventId);
  if (!prior) return null;
  if (prior.fp !== fp) throw new PlaybookError("request_conflict", "这个请求号已经用在另一个手册决定上了：换一个新的");
  return { ok: true, replayed: true, playbook: prior.playbook, decision: prior.type, ...(prior.version ? { version: prior.version } : {}), ...(prior.proposal_id ? { proposal_id: prior.proposal_id } : {}) };
}

function logEvent(m: PlaybookManifest, ev: Omit<PlaybookEvent, "at">, at: string): void {
  m.events = [...m.events, { ...ev, at }].slice(-EVENTS_KEPT);
}

/** 按事件日志找回已提交的决定（崩在 manifest 已写、请求结果没落盘之间时用） */
export async function recoverPlaybookEvent(eventId: string, dataDir?: string): Promise<R | null> {
  const m = await serialize(dataDir, () => manifestInQueue(dataDir));
  const e = m.events.find((x) => x.eventId === eventId);
  return e ? replay(m, eventId, e.fp) : null;
}

export interface ProposalDecision extends DecisionMeta { id: PlaybookId; proposal_id: string; gen: string; decision: "approve" | "reject" }

function pendingProposal(e: PlaybookEntry, input: ProposalDecision): PlaybookProposal {
  const p = e.proposals.find((x) => x.id === input.proposal_id);
  if (!p) throw new PlaybookError("not_found", `手册 ${input.id} 上没有提案 ${input.proposal_id}`);
  if (p.status === "stale") throw new PlaybookError("stale", "这份提案已过期（手册之后改过版本）：要重新提案，不能叠到新版本上");
  if (p.status !== "pending") throw new PlaybookError("already_handled", `这份提案已经${p.status === "approved" ? "批准" : "否决"}过了`);
  if (p.gen !== input.gen) throw new PlaybookError("stale", "提案内容和你给创始人看的那一版对不上：重新 list 再给他看");
  return p;
}

/** 批准 / 否决一份提案。批准时手册已不是 based_on 那一版 → stale，手册内容不变 */
export function decideProposal(input: ProposalDecision, dataDir?: string): Promise<R> {
  return serialize(dataDir, async () => {
    const m = await manifestInQueue(dataDir);
    const fp = shortHash([input.decision, input.id, input.proposal_id, input.gen]);
    const prior = replay(m, input.eventId, fp);
    if (prior) return prior;
    const e = entryOf(m, input.id);
    const p = pendingProposal(e, input);
    const at = new Date().toISOString();
    const meta = { eventId: input.eventId, fp, playbook: input.id, proposal_id: p.id, source: input.source, ...(input.founder_words ? { founder_words: input.founder_words } : {}), ...(input.requested_by ? { requested_by: input.requested_by } : {}) };
    if (input.decision === "reject") {
      Object.assign(p, { status: "rejected", decided_at: at });
      logEvent(m, { ...meta, type: "reject" }, at);
      await writeManifest(m, dataDir);
      return { ok: true, playbook: input.id, decision: "reject", proposal_id: p.id };
    }
    if (e.current !== p.based_on) {
      markStale(e, at);
      await writeManifest(m, dataDir);
      throw new PlaybookError("stale", `手册已经是第 ${e.current} 版，这份提案基于第 ${p.based_on} 版：要重新提案`);
    }
    assertDataDirWritable(dataDir);
    const version = nextVersion(e);
    await writeVersionOnce(input.id, version, p.text, dataDir);
    e.versions.push({ version, at, author: p.kind === "lesson" ? "founder" : "agent", kind: "edit", founder_words: p.founder_words, reason: p.reason, based_on: p.based_on, proposal_id: p.id });
    e.current = version;
    Object.assign(p, { status: "approved", decided_at: at });
    markStale(e, at);
    logEvent(m, { ...meta, type: "approve", version }, at);
    await writeManifest(m, dataDir);
    return { ok: true, playbook: input.id, decision: "approve", proposal_id: p.id, version };
  });
}

export interface RollbackInput extends Omit<DecisionMeta, "eventId"> { id: PlaybookId; to_version: number; expected_current_version: number; request_id: string; founder_words: string }

/** 回滚 = 把旧版内容存成新版本，历史不删；当前版本对不上 → stale；同一请求重放上次结果 */
export function rollbackPlaybook(input: RollbackInput, dataDir?: string): Promise<R> {
  return serialize(dataDir, async () => {
    const m = await manifestInQueue(dataDir);
    const eventId = `rollback-${input.request_id}`;
    const fp = shortHash(["rollback", input.id, input.to_version, input.expected_current_version]);
    const prior = replay(m, eventId, fp);
    if (prior) return prior;
    const e = entryOf(m, input.id);
    if (e.current !== input.expected_current_version) throw new PlaybookError("stale", `手册现在是第 ${e.current} 版，不是第 ${input.expected_current_version} 版：刷新后再决定要不要回滚`, { current: e.current });
    if (input.to_version === e.current) throw new PlaybookError("same_version", `第 ${e.current} 版就是当前版本，不用回滚`);
    if (!e.versions.some((v) => v.version === input.to_version)) throw new PlaybookError("not_found", `手册 ${input.id} 没有第 ${input.to_version} 版`);
    assertDataDirWritable(dataDir);
    const text = await readVersionText(input.id, input.to_version, dataDir);
    const version = nextVersion(e);
    const at = new Date().toISOString();
    await writeVersionOnce(input.id, version, text, dataDir);
    e.versions.push({ version, at, author: "founder", kind: "rollback", founder_words: input.founder_words, based_on: e.current, rolled_back_to: input.to_version });
    e.current = version;
    markStale(e, at);
    logEvent(m, { eventId, fp, type: "rollback", playbook: input.id, to_version: input.to_version, expected_current_version: input.expected_current_version, version, source: input.source, founder_words: input.founder_words, ...(input.requested_by ? { requested_by: input.requested_by } : {}) }, at);
    await writeManifest(m, dataDir);
    return { ok: true, playbook: input.id, decision: "rollback", version, rolled_back_to: input.to_version };
  });
}
