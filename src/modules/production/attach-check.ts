/**
 * 卡片挂载核对（1b §7）：挂载照旧同步完成；挂上后入队（高优先级）比开头转写。
 * 别条分数超过这条且满足 §2.1 差距 → 卡片 badge「这段原片听起来更像《X》」+「改挂到《X》」/「就是这条」（记住）。
 * 转写没就绪 / 核对失败 → 卡片小字写原因。
 *
 * 「改挂到《X》」= 双内容事务（§14-12）：这条按 §4.1 同样的前提撤下（文件不挪回原处），同一事务里按原 spec §3 检查后收进《X》并搬入改名。
 * 提交点在《X》：接收方写好之后才释放这条（ReleaseOp.undo，崩了由启动恢复按提交点补做）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot } from "../../storage/content-project.js";
import { getContent, type Content } from "../../storage/local-store.js";
import { isOntologyActive, readProductionDoc, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { stableFingerprint } from "./files.js";
import { chatcutHold } from "./chatcut-refs.js";
import { decide, describeTop3 } from "./match/decide.js";
import { matchDeps } from "./match/deps.js";
import { hear } from "./match/hear.js";
import { withFileOwnership } from "./mutex.js";
import { arollPool } from "./match/pool.js";
import { enqueueMatchJob, listMatchJobs, registerMatchHandler, type JobResult, type JobSpec, type MatchJob } from "./match/queue.js";
import { pendingElsewhere, pendingElsewhereText } from "./match/reservation.js";
import { checkTargetDir, type FilePlan } from "./record-plan.js";
import { commitFile } from "./record.js";
import { now } from "./roots.js";
import { mutateProduction, registerReadyHook } from "./service.js";
import { arollOwnerElsewhere, shaIndex } from "./sha-index.js";
import { chatcutInUse, factFile, IN_EDIT_REASSIGN, undoBlocker } from "./undo-attach.js";
import { newId } from "../../storage/production-store.js";

export const ATTACH_CHECK = "attach_check";
type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });

/** 挂上之后入队；调用方持锁（founderDecision）。入队失败写进事实，卡片上看得见 */
function checkSpec(dataDir: string, contentId: string, fact: Fact, job: string): JobSpec {
  return { id: job, purpose: ATTACH_CHECK, priority: "explicit", sha256: fact.sha256!, path: fact.path && path.isAbsolute(fact.path) ? fact.path : path.join(contentRoot(contentId, dataDir), fact.path ?? ""),
    size: fact.size ?? 0, mtime_ms: fact.mtime_ms ?? 0, target: `${contentId}:${fact.id}`, payload: { content_id: contentId, fact_id: fact.id } };
}

export async function startAttachCheck(dataDir: string, contentId: string, fact: Fact): Promise<void> {
  const job = newId("mjob");
  const at = new Date().toISOString();
  await mutateProduction(contentId, dataDir, (doc) => {
    const f = doc.facts.find((x) => x.id === fact.id);
    if (f) f.attach_check = { status: "checking", job, at };
    return { value: null, events: [] };
  });
  await enqueueMatchJob(dataDir, checkSpec(dataDir, contentId, fact, job))
    .catch((e: unknown) => settle(dataDir, contentId, fact.id, job, { status: "failed", reason: `核对没排上：${e instanceof Error ? e.message : String(e)}` }));
}

async function settle(dataDir: string, contentId: string, factId: string, job: string, patch: Omit<NonNullable<Fact["attach_check"]>, "at" | "job">): Promise<void> {
  await withFileOwnership(() => mutateProduction(contentId, dataDir, (doc) => {
    const f = doc.facts.find((x) => x.id === factId && x.state === "accepted" && x.attach_check?.job === job);
    if (f) f.attach_check = { ...patch, job, at: new Date().toISOString() };
    return { value: null, events: f && patch.status === "suggest" ? [{ type: "attach_check_suggest", detail: { fact_id: factId, other: patch.other_id } }] : [] };
  }));
}

async function handle({ dataDir, job, signal }: { dataDir: string; job: MatchJob; signal: AbortSignal }): Promise<JobResult> {
  const { content_id, fact_id } = job.payload as { content_id: string; fact_id: string };
  const content = await getContent(content_id, dataDir);
  const doc = content ? await readProductionDocOrEmpty(content_id, dataDir) : null;
  const fact = doc?.facts.find((f) => f.id === fact_id && f.state === "accepted" && f.attach_check?.job === job.id);
  if (!content || content.deletedAt || !fact) return { state: "cancelled", outcome: "这条原片已经不在了" };
  const h = await hear(dataDir, job, signal);
  if (h.text === null) {
    await settle(dataDir, content_id, fact_id, job.id, { status: h.failed ? "failed" : "not_ready", reason: h.failed ? `核对失败：${h.why}` : `没做内容核对：${h.why}` });
    return { state: "done", outcome: h.why };
  }
  // 只按转写分数与差距判（Codex 审 segB P2）：文件名不参与——创始人挂的时候已经看过名字，
  // 这一步要回答的是「听起来是不是这条」；带文件名进去，L1 强命中会在打分前就定了 winner
  const d = decide({ fileName: "", sha256: job.sha256, pool: await arollPool(dataDir, content_id), heard: h }, matchDeps().thresholds);
  const other = d.winner && d.winner !== content_id ? d.top3.find((r) => r.content_id === d.winner) : undefined;
  await settle(dataDir, content_id, fact_id, job.id, other ? { status: "suggest", other_id: other.content_id, other_title: other.title, reason: `${d.reason}；前三名：${describeTop3(d.top3)}` } : { status: "ok", reason: d.reason });
  return { state: "done", outcome: other ? `更像《${other.title}》` : "对上这条" };
}

/**
 * 重启恢复（Codex 审 segB10 P2）：事实写成 checking 之后、作业落盘之前崩了 → 就绪时按事实重新入队（同作业代号：
 * 还活着的作业直接复用，终态的重排）。否则卡片会永远「正在核对内容」。
 */
export async function requeueAttachChecks(dataDir: string): Promise<void> {
  const live = new Set((await listMatchJobs(dataDir)).filter((j) => j.purpose === ATTACH_CHECK && (j.state === "queued" || j.state === "running")).map((j) => j.id));
  for (const list of Object.values((await shaIndex(dataDir)).entries)) {
    for (const e of list) {
      if (e.kind !== "aroll" || e.state !== "accepted") continue;
      const doc = await readProductionDoc(e.content_id, dataDir).catch(() => null);
      const f = doc?.facts.find((x) => x.id === e.fact_id && x.round === doc.round && x.attach_check?.status === "checking");
      if (f?.attach_check?.job && f.sha256 && !live.has(f.attach_check.job)) await enqueueMatchJob(dataDir, checkSpec(dataDir, e.content_id, f, f.attach_check.job));
    }
  }
}

registerReadyHook(requeueAttachChecks);

registerMatchHandler(ATTACH_CHECK, handle, async (dataDir, job, error) => {
  const { content_id, fact_id } = job.payload as { content_id: string; fact_id: string };
  await settle(dataDir, content_id, fact_id, job.id, { status: "failed", reason: `核对没做成：${error}` });
});

/** 「就是这条」：记住，不再提示 */
export async function keepAttach(content: Content, fact: Fact, dataDir: string): Promise<Result> {
  if (fact.attach_check?.status !== "suggest") return { ok: true, note: "没有要确认的提示" };
  await mutateProduction(content.id, dataDir, (doc) => {
    const f = doc.facts.find((x) => x.id === fact.id)!;
    f.attach_check = { ...f.attach_check!, status: "kept", at: new Date().toISOString() };
    doc.decisions.push({ id: newId("dec"), type: "attach_check_keep", round: doc.round, at: new Date().toISOString(), source: "founder", fact_id: f.id, sha256: f.sha256 });
    return { value: null, events: [{ type: "attach_check_kept", detail: { fact_id: f.id } }] };
  });
  return { ok: true };
}

/** 收进《X》的检查（原 spec §3：路径、完整性、独占含预留、点过「不是这条」、目标目录安全） */
async function receiverProblem(to: Content | null, fact: Fact, from: Content, dataDir: string): Promise<string | null> {
  if (!to || to.deletedAt || to.status === "archived" || !isVideoPlatform(to.platform) || !(await isOntologyActive(dataDir, to.id))) return "要改挂的那条稿不在了或不按本体走";
  const doc = await readProductionDocOrEmpty(to.id, dataDir);
  if (doc.facts.some((f) => f.kind === "aroll" && f.sha256 === fact.sha256 && f.state === "rejected")) return `你对《${to.title}》说过这段原片不是它`;
  const owner = await arollOwnerElsewhere(dataDir, fact.sha256!, to.id);
  if (owner && owner !== from.id) return `这个原片已经是另一条稿（${owner}）的 A-roll`;
  const held = await pendingElsewhere(dataDir, fact.sha256!, to.id);
  if (held && held.content_id !== from.id) return pendingElsewhereText(held.title);
  const safe = await checkTargetDir(await fs.realpath(contentRoot(to.id, dataDir)), "02-aroll");
  return safe.ok ? null : safe.error;
}

/** 「改挂到《X》」：调用方持锁 */
export async function reassignAroll(content: Content, doc: ProductionDoc, fact: Fact, toId: string, dataDir: string): Promise<Result> {
  const blocked = undoBlocker(content, doc, fact);
  if (blocked) return fail("reassign_blocked", blocked === IN_EDIT_REASSIGN || blocked.startsWith("ChatCut") ? blocked : IN_EDIT_REASSIGN);
  const to = await getContent(toId, dataDir);
  const problem = await receiverProblem(to, fact, content, dataDir);
  if (problem) return fail("reassign_blocked", problem);
  const source = await factFile(content, fact, dataDir);
  const hold = await chatcutHold(source);
  if (hold.project) return fail("reassign_blocked", chatcutInUse(hold.project));
  // 原地收下的原片（绝对路径）改挂：同样不挪文件，《X》原地收下（Codex 审 segB5 P2）
  const inPlace = path.isAbsolute(fact.path!);
  const fp = await stableFingerprint(source, now());
  if (!fp.ok) return fail(fp.code, fp.error);
  if (fp.value.sha256 !== fact.sha256) return fail("stale", "项目里的原片被改过，刷新再看");
  const plan: FilePlan = { action: inPlace ? "in_place" : "move", kind: "aroll", source, sha256: fact.sha256!, id: fp.value.id, projectRoot: await fs.realpath(contentRoot(to!.id, dataDir)), location: "other",
    evidence: `创始人从《${content.title}》改挂过来（内容核对：${fact.attach_check?.reason ?? "—"}）`, ...(fact.duration_ms ? { duration_ms: fact.duration_ms } : {}) };
  const a = { content_id: to!.id, kind: "aroll" as const, request_id: `reassign-${fact.id}`, host: "founder" };
  const r = await commitFile(a, to!, plan, dataDir, { owner: content.id, sha256: fact.sha256!, to: to!.id, undo: { fact_id: fact.id, to_title: to!.title } },
    { patch: { source: "founder", source_path: fact.source_path ?? source } });
  return r.ok ? { ok: true, reassigned_to: to!.id, path: r.path, project_path: r.project_path } : r;
}
