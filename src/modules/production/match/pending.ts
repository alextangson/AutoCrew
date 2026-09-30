/**
 * agent 报原片的后台核对（1b §3）：`record kind=aroll` 名字没对上 → `pending_match` 事实 + 高优先级作业。
 *
 * 作业在锁外转写、打分；落结果时自己取文件归属锁，锁内先核（§14-1/2/6）：
 * 事实仍是同轮、同 sha、同作业代号的 pending_match（创始人已定过 → 作废，无副作用）；
 * 池内各稿 round / 正文哈希 / 标题与快照一致（变了 → 用缓存转写重新打分再判）；
 * 重跑落位检查（可搬入根、路径安全、A-roll 独占含预留、ChatCut 引用、本体启用）；最后重算完整 sha 复核文件身份。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot } from "../../../storage/content-project.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { isOntologyActive, readProductionDoc, readProductionDocOrEmpty } from "../../../storage/production-store.js";
import type { Fact, ProductionDoc } from "../../../storage/production-types.js";
import { resolveLocalFile, stableFingerprint } from "../files.js";
import { withFileOwnership } from "../mutex.js";
import type { RecordArgs } from "../record-args.js";
import { checkTargetDir, referencedByChatcut, type FilePlan } from "../record-plan.js";
import { commitFile } from "../record.js";
import { classify, movableRoots, now } from "../roots.js";
import { mutateProduction, registerReadyHook } from "../service.js";
import { arollOwnerElsewhere, shaIndex } from "../sha-index.js";
import { readTranscript } from "./cache.js";
import { decide, describeTop3, sameSnapshot, snapshotOf, type Heard, type MatchDecision } from "./decide.js";
import { hear } from "./hear.js";
import { chatcutHold, inUseEvidence } from "../chatcut-refs.js";
import { matchDeps } from "./deps.js";
import { arollPool } from "./pool.js";
import { cancelMatchJob, enqueueMatchJob, kickMatchWorker, registerMatchHandler, type JobResult, type JobSpec, type MatchJob } from "./queue.js";
import { pendingElsewhere, pendingElsewhereText, type PendingHolder } from "./reservation.js";

export const RECORD_AROLL = "record_aroll";

interface Waiting { content: Content; doc: ProductionDoc; fact: Fact }
interface Payload { content_id: string; fact_id: string }

function specFor(contentId: string, fact: Fact, round: number): JobSpec {
  return { id: fact.match_job, purpose: RECORD_AROLL, priority: "explicit", sha256: fact.sha256!, path: fact.path!, size: fact.size ?? 0, mtime_ms: fact.mtime_ms ?? 0,
    target: `${contentId}:${round}`, payload: { content_id: contentId, fact_id: fact.id } };
}

/** record 写完 pending_match 事实后入队；入队失败回一句 warning（事实留着，重启时重新入队） */
export async function startMatchJob(dataDir: string, contentId: string, factId: string, jobId: string, round: number, p: FilePlan): Promise<string | null> {
  const fact = { id: factId, match_job: jobId, sha256: p.sha256, path: p.source, size: p.id.size, mtime_ms: p.id.mtime_ms } as Fact;
  try { await enqueueMatchJob(dataDir, specFor(contentId, fact, round)); return null; }
  catch (e) { return `核对作业没排上（${e instanceof Error ? e.message : String(e)}）：服务重启时会重新排`; }
}

function settleRequest(doc: ProductionDoc, f: Fact): void {
  const req = f.request_id ? doc.requests?.[f.request_id] : undefined;
  if (req) req.receipt = { ...req.receipt, state: f.state, ...(f.state === "candidate" || f.state === "rejected" ? { reason: f.evidence } : {}) };
}

/** 创始人把同一文件挂到了别条（B28）：取消这边的核对，事实转 rejected */
export async function cancelPendingFor(dataDir: string, held: PendingHolder, byTitle: string): Promise<void> {
  await mutateProduction(held.content_id, dataDir, (doc) => {
    const f = doc.facts.find((x) => x.id === held.fact.id && x.state === "pending_match");
    if (!f) return { value: null, events: [] };
    Object.assign(f, { state: "rejected", evidence: `创始人挂到了《${byTitle}》` });
    settleRequest(doc, f);
    return { value: null, events: [{ type: "aroll_match_cancelled", detail: { fact_id: f.id, reason: f.evidence } }] };
  });
  if (held.fact.match_job) await cancelMatchJob(dataDir, held.fact.match_job, `创始人挂到了《${byTitle}》`);
}

async function waiting(dataDir: string, job: MatchJob): Promise<Waiting | string> {
  const { content_id, fact_id } = job.payload as unknown as Payload;
  const content = await getContent(content_id, dataDir);
  if (!content || content.deletedAt) return "稿已删除，这次核对作废";
  if (content.status === "archived") return "稿已归档，这次核对作废";
  if (!(await isOntologyActive(dataDir, content_id))) return "本体没启用，这次核对作废";
  const doc = await readProductionDocOrEmpty(content_id, dataDir);
  const fact = doc.facts.find((f) => f.id === fact_id);
  if (!fact || fact.round !== doc.round) return "稿已重开文稿，这次核对作废";
  if (fact.state !== "pending_match" || fact.match_job !== job.id || fact.sha256 !== job.sha256) return "这条原片已经定过了，核对结果作废";
  return { content, doc, fact };
}

const summaryOf = (d: MatchDecision): NonNullable<Fact["match"]> => ({ winner: d.winner, reason: d.reason, top3: d.top3.map((r) => ({ ...r })) });

async function resolveTo(dataDir: string, w: Waiting, job: MatchJob, state: "candidate" | "rejected", evidence: string, d?: MatchDecision): Promise<JobResult> {
  await mutateProduction(w.content.id, dataDir, (doc) => {
    const f = doc.facts.find((x) => x.id === w.fact.id && x.state === "pending_match" && x.match_job === job.id);
    if (!f) return { value: null, events: [] };
    Object.assign(f, { state, evidence, ...(d ? { match: summaryOf(d) } : {}) });
    settleRequest(doc, f);
    return { value: null, events: [{ type: `aroll_match_${state}`, detail: { fact_id: f.id, job: job.id, reason: evidence } }] };
  });
  return { state: "done", outcome: `${state}：${evidence}` };
}

/** 池变了（新稿认稿、正文 / 标题改了）：用缓存转写重新打分，不重转（B26） */
async function rescored(dataDir: string, job: MatchJob, first: MatchDecision, heard: Heard, contentId: string): Promise<MatchDecision> {
  const pool = await arollPool(dataDir, contentId);
  if (sameSnapshot(snapshotOf(job.sha256, pool), first.snapshot)) return first;
  const cached = heard.text === null ? null : await readTranscript(dataDir, job.sha256);
  const again: Heard = heard.text === null ? heard : { text: cached?.text ?? heard.text };
  return decide({ fileName: path.basename(job.path), sha256: job.sha256, pool, heard: again }, matchDeps().thresholds);
}

export type Check = { ok: true; source: string; projectRoot: string; location: "inbox" | "watch" } | { ok: false; gone: boolean; why: string };

/**
 * 重跑原 spec §3 的落位检查（B27）：全部只读。pending_match 落结果、收件箱自动挪（§4）共用。
 * `fact`：已有的 pending 事实（查它有没有被 ChatCut 工程引用）；收件箱新文件没有。
 */
export async function placementCheck(content: Content, doc: ProductionDoc, file: string, sha: string, fact: Fact | undefined, dataDir: string, allow: ReadonlyArray<"inbox" | "watch"> = ["inbox", "watch"]): Promise<Check> {
  const at = await resolveLocalFile(file, "原片");
  if (!at.ok) return { ok: false, gone: at.code === "path_missing", why: at.error };
  const projectRoot = await fs.realpath(contentRoot(content.id, dataDir));
  const where = classify(at.value, projectRoot, await movableRoots(dataDir));
  if (where !== "inbox" && where !== "watch") return { ok: false, gone: false, why: "原片所在目录现在不允许直接搬入" };
  if (!allow.includes(where)) return { ok: false, gone: false, why: "这个目录只给建议，不自动挪" };
  const owner = await arollOwnerElsewhere(dataDir, sha, content.id);
  if (owner) return { ok: false, gone: false, why: `这个原片已经是《${(await getContent(owner, dataDir))?.title ?? owner}》的 A-roll` };
  const held = await pendingElsewhere(dataDir, sha, content.id);
  if (held) return { ok: false, gone: false, why: pendingElsewhereText(held.title) };
  if (referencedByChatcut(doc, fact)) return { ok: false, gone: false, why: "原片已被 ChatCut 工程引用，不挪" };
  const safe = await checkTargetDir(projectRoot, "02-aroll");
  if (!safe.ok) return { ok: false, gone: false, why: safe.error };
  return { ok: true, source: at.value, projectRoot, location: where };
}

async function accept(dataDir: string, w: Waiting, job: MatchJob, d: MatchDecision, c: Extract<Check, { ok: true }>, id: FilePlan["id"]): Promise<JobResult> {
  const a: RecordArgs = { content_id: w.content.id, kind: "aroll", request_id: w.fact.request_id ?? `match-${job.id}`, host: w.fact.by?.host ?? "autocrew" };
  const hold = await chatcutHold(c.source);
  const plan: FilePlan = { action: hold.project ? "in_place" : "move", kind: "aroll", source: c.source, sha256: job.sha256, id, projectRoot: c.projectRoot, location: c.location,
    evidence: hold.project ? `核对认出：${d.reason}；${inUseEvidence(hold.project)}` : `核对认出：${d.reason}${hold.note}`, existing: w.fact, ...(w.fact.duration_ms ? { duration_ms: w.fact.duration_ms } : {}) };
  const r = await commitFile(a, w.content, plan, dataDir, undefined, { keepArgs: true, patch: { auto_attached: true, match: summaryOf(d) }, event: "aroll_match_accepted" });
  if (!r.ok) return resolveTo(dataDir, w, job, "candidate", `对上了，但挪进项目失败：${String(r.error)}`, d);
  return { state: "done", outcome: `accepted：${String(r.path ?? "")}` };
}

async function commitJob(dataDir: string, job: MatchJob, first: MatchDecision, heard: Heard): Promise<JobResult> {
  const w = await waiting(dataDir, job);
  if (typeof w === "string") return { state: "cancelled", outcome: w };
  const d = await rescored(dataDir, job, first, heard, w.content.id);
  const check = await placementCheck(w.content, w.doc, w.fact.path!, w.fact.sha256!, w.fact, dataDir);
  if (!check.ok && check.gone) return resolveTo(dataDir, w, job, "rejected", "核对期间文件不见了，没挪", d);
  const source = check.ok ? check.source : w.fact.path!;
  const fp = await stableFingerprint(source, now());
  if (!fp.ok || fp.value.sha256 !== job.sha256) return resolveTo(dataDir, w, job, "rejected", "核对期间文件变了，没挪", d);
  const top = d.top3.length ? `；前三名：${describeTop3(d.top3)}` : "";
  if (!check.ok) return resolveTo(dataDir, w, job, "candidate", `${check.why}，没挪；${d.reason}${top}`, d);
  if (d.winner !== w.content.id) return resolveTo(dataDir, w, job, "candidate", `${d.reason}${top}`, d);
  return accept(dataDir, w, job, d, check, fp.value.id);
}

async function handleRecordJob(ctx: { dataDir: string; job: MatchJob; signal: AbortSignal }): Promise<JobResult> {
  const { dataDir, job, signal } = ctx;
  const pre = await waiting(dataDir, job);
  if (typeof pre === "string") return { state: "cancelled", outcome: pre };
  const heard = await hear(dataDir, job, signal);
  const first = decide({ fileName: path.basename(job.path), sha256: job.sha256, pool: await arollPool(dataDir, pre.content.id), heard }, matchDeps().thresholds);
  return withFileOwnership(() => commitJob(dataDir, job, first, heard));
}

/** 作业重试到头还失败（Codex 审 segB4 P2，§3-4「失败 → candidate」）：事实别再永远「正在核对」，也别一直占着预留 */
async function recordJobFailed(dataDir: string, job: MatchJob, error: string): Promise<void> {
  await withFileOwnership(async () => {
    const w = await waiting(dataDir, job);
    if (typeof w !== "string") await resolveTo(dataDir, w, job, "candidate", `核对没做成：${error}；等你在卡片上确认是不是这条`);
  });
}

registerMatchHandler(RECORD_AROLL, handleRecordJob, recordJobFailed);

/** 服务重启（1b §3-5）：恢复事务、重建索引之后，本轮所有 pending_match 重新入队（同代号的活作业不重复排） */
export async function requeuePending(dataDir: string): Promise<void> {
  for (const list of Object.values((await shaIndex(dataDir)).entries)) {
    for (const e of list) {
      if (e.kind !== "aroll" || e.state !== "pending_match") continue;
      const doc = await readProductionDoc(e.content_id, dataDir).catch(() => null);
      const f = doc?.facts.find((x) => x.id === e.fact_id && x.round === doc.round && x.state === "pending_match");
      if (doc && f?.match_job && f.sha256 && f.path) await enqueueMatchJob(dataDir, specFor(e.content_id, f, doc.round));
    }
  }
  // 盘上还排着的作业（卡片挂载核对、退避中的后台转写……）不等新入队：启动就叫醒工人，它跑完会按退避时间重新定时（Codex 审 segB P2）
  kickMatchWorker(dataDir);
}

registerReadyHook(requeuePending);
