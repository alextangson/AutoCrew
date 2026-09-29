/**
 * `autocrew_content action=record`（spec §3）：agent 只报事实。不要认领、不要交接、不带任何批准语义。
 *
 * 1 request_id 已处理 → 重放（搬走之后重试不会因源路径没了而报错）
 * 2–6 只读核验与落位计划（record-plan.ts），全部先于任何副作用
 * 7 在文件归属事务里落位：aroll 挪进 02-aroll 改名「<标题>-原片」；cut/srt/cover APFS 克隆进 04-edit / 05-cover/vNNN
 * 9 写事实 → refreshProductionProjection → 回执（事实 id、项目内路径、阶段、还差什么、候选、next_action）
 */
import path from "node:path";
import { getContent, getDataDir, type Content } from "../../storage/local-store.js";
import { contentRoot } from "../../storage/content-project.js";
import { newId, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import type { Explanation } from "./explain.js";
import { cloneInto, identityOf, reserveTarget, safeStem, sameIdentity } from "./files.js";
import { withFileOwnership } from "./mutex.js";
import { normalizeRecordArgs, type RecordArgs } from "./record-args.js";
import { planFileRecord, type FilePlan } from "./record-plan.js";
import { explainContent } from "./read.js";
import { ensureProductionReady, mutateProduction } from "./service.js";
import { dropTxn, rollbackTxn, runMove, saveTxn, type Txn, type TxnOp } from "./txn.js";

type Receipt = Record<string, unknown>;
const fail = (code: string, error: string, extra: Receipt = {}): Receipt => ({ ok: false, code, error, ...extra });

export const PUBLISH_NOT_YET =
  "发布回执（kind=publish）这一版还没开：发完照旧由 AutoCrew 发布器记录，或请创始人在看板上点「我发了」。";

export async function executeRecord(params: Record<string, unknown>): Promise<Receipt> {
  const parsed = normalizeRecordArgs(params);
  if (!parsed.ok) return fail(parsed.code, parsed.error);
  const a = parsed.value;
  if (a.kind === "publish") return fail("publish_not_supported", PUBLISH_NOT_YET);
  const dataDir = getDataDir(params._dataDir as string | undefined);
  await ensureProductionReady(dataDir);
  return withFileOwnership(() => recordLocked(a, dataDir));
}

async function recordLocked(a: RecordArgs, dataDir: string): Promise<Receipt> {
  const content = await getContent(a.content_id, dataDir);
  if (!content || content.deletedAt) return fail("not_found", `找不到这篇稿（${a.content_id}）：不存在或已删除`);
  if (!isVideoPlatform(content.platform)) return fail("not_video", "图文稿不走制作段，没有原片 / 成片可报");
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const replay = doc.requests?.[a.request_id];
  if (replay) return { ...(await receiptFor(content, dataDir, replay.receipt as unknown as ReceiptCore)), replayed: true };
  if (a.kind === "chatcut_project") return recordChatcut(a, content, doc, dataDir);
  const plan = await planFileRecord(a, content, doc, dataDir);
  if (!plan.ok) return fail(plan.code, plan.error);
  try {
    return await commitFile(a, content, plan.value, dataDir);
  } catch (err) {
    return fail("place_failed", `落位失败，原件没动：${err instanceof Error ? err.message : String(err)}`);
  }
}

interface ReceiptCore { fact_id: string; kind: Fact["kind"]; state: Fact["state"]; path?: string }

// ---- 落位 ----

function coverDir(version: number): string {
  return `05-cover/v${String(version).padStart(3, "0")}`;
}

async function reserveFor(p: FilePlan, content: Content): Promise<string> {
  const ext = path.extname(p.source).toLowerCase();
  if (p.kind === "aroll") return reserveTarget(path.join(p.projectRoot, "02-aroll"), `${safeStem(content.title)}-原片`, ext);
  if (p.kind === "cover") return reserveTarget(path.join(p.projectRoot, coverDir(p.version!)), `封面-${p.ratio === "3:4" ? "3x4" : "4x3"}`, ext);
  return reserveTarget(path.join(p.projectRoot, "04-edit"), path.basename(p.source, path.extname(p.source)), ext);
}

/** 第 7 步：先落事务日志再动文件；返回落位后的项目内相对路径 */
async function place(p: FilePlan, content: Content, txn: Txn, dataDir: string): Promise<string> {
  const target = await reserveFor(p, content);
  const op: TxnOp = { op: p.action === "move" ? "move" : "clone", source: p.source, target, sha256: p.sha256, step: "planned" };
  txn.ops.push(op);
  await saveTxn(dataDir, txn);
  if (op.op === "move") {
    await runMove(dataDir, txn, op, async () => {
      if (!sameIdentity(p.id, await identityOf(p.source))) throw new Error("原片在拷贝途中变了（还在写入？）");
    });
  } else {
    await cloneInto(p.source, target, p.sha256, p.id);
    op.step = "placed";
    await saveTxn(dataDir, txn);
  }
  return path.relative(p.projectRoot, target);
}

function factFrom(a: RecordArgs, p: FilePlan, doc: ProductionDoc, relPath: string | null, txnId: string | undefined): Fact {
  const accepted = p.action !== "candidate";
  return {
    id: newId("fact"), kind: p.kind, round: doc.round, state: accepted ? "accepted" : "candidate", availability: "present",
    source: "record", by: { host: a.host, ...(a.session ? { session: a.session } : {}) }, at: new Date().toISOString(),
    request_id: a.request_id, evidence: p.evidence, ...(txnId ? { txn_id: txnId } : {}),
    path: relPath ?? p.source, sha256: p.sha256, size: p.id.size, mtime_ms: p.id.mtime_ms,
    ...(p.duration_ms ? { duration_ms: p.duration_ms } : {}), ...(p.ratio ? { ratio: p.ratio } : {}), ...(p.version ? { version: p.version } : {}),
    ...(a.cover_text && p.kind === "cover" ? { text: a.cover_text } : {}), ...(p.for_cut ? { for_cut: p.for_cut } : {}), ...(a.note ? { note: a.note } : {}),
  };
}

/** 已有候选被再次报成可收的：原地升级（挪了的改路径），不另起一条 */
function upsertFact(doc: ProductionDoc, fact: Fact, existing: Fact | undefined): Fact {
  if (!existing) { doc.facts.push(fact); return fact; }
  const target = doc.facts.find((f) => f.id === existing.id)!;
  Object.assign(target, { state: fact.state, path: fact.path, availability: "present", evidence: fact.evidence, ...(fact.txn_id ? { txn_id: fact.txn_id } : {}) });
  return target;
}

async function commitFile(a: RecordArgs, content: Content, p: FilePlan, dataDir: string): Promise<Receipt> {
  const reuse = p.action === "existing" || (p.action === "candidate" && p.existing);
  const moves = p.action === "move" || p.action === "clone";
  const txn: Txn = { id: newId("txn"), kind: "record", content_id: content.id, round: 0, ops: [], at: new Date().toISOString() };
  let rel: string | null = p.action === "in_place" && p.location === "project" ? path.relative(p.projectRoot, p.source) : null;
  if (moves) {
    try { rel = await place(p, content, txn, dataDir); }
    catch (err) { await rollbackTxn(dataDir, txn).catch(() => undefined); throw err; }
  }
  const r = await mutateProduction(content.id, dataDir, (doc) => {
    const fact = reuse ? p.existing! : upsertFact(doc, factFrom(a, p, doc, rel, moves ? txn.id : undefined), p.existing);
    const core: ReceiptCore = { fact_id: fact.id, kind: fact.kind, state: fact.state, ...(fact.path ? { path: fact.path } : {}) };
    doc.requests = { ...(doc.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), receipt: { ...core } } };
    if (moves) doc.txns = [...(doc.txns ?? []), txn.id];
    return { value: core, events: reuse ? [] : [{ type: "fact_recorded", detail: { fact_id: fact.id, kind: fact.kind, state: fact.state, by: a.host } }] };
  });
  if (moves) await dropTxn(dataDir, txn.id);
  return receipt(r.value, r.explanation, content, p.projectRoot, reuse ? "同一文件已经记过，这次没有新动作" : undefined);
}

// ---- chatcut_project：不带文件，只记工程与它显式引用的原片 ----

async function recordChatcut(a: RecordArgs, content: Content, doc: ProductionDoc, dataDir: string): Promise<Receipt> {
  if (!a.chatcut_project_id) return fail("bad_param", "kind=chatcut_project 要带 chatcut_project_id");
  const arolls = new Set(doc.facts.filter((f) => f.round === doc.round && f.kind === "aroll" && f.state !== "rejected").map((f) => f.id));
  const unknown = (a.uses_aroll ?? []).filter((id) => !arolls.has(id));
  if (unknown.length) return fail("bad_param", `uses_aroll 里有本条本轮没有的原片事实：${unknown.join("、")}（用 record 回执或摘要里的 A-roll fact_id）`);
  const r = await mutateProduction(content.id, dataDir, (d) => {
    const same = d.facts.find((f) => f.round === d.round && f.kind === "chatcut_project" && f.project_id === a.chatcut_project_id && (f.timeline_id ?? null) === (a.timeline_id ?? null));
    const fact: Fact = same ?? {
      id: newId("fact"), kind: "chatcut_project", round: d.round, state: "accepted", availability: "present", source: "record",
      by: { host: a.host }, at: new Date().toISOString(), request_id: a.request_id, project_id: a.chatcut_project_id,
      ...(a.timeline_id ? { timeline_id: a.timeline_id } : {}),
    };
    if (!same) d.facts.push(fact);
    fact.uses_aroll = [...new Set([...(fact.uses_aroll ?? []), ...(a.uses_aroll ?? [])])];
    const core: ReceiptCore = { fact_id: fact.id, kind: fact.kind, state: fact.state };
    d.requests = { ...(d.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), receipt: { ...core } } };
    return { value: core, events: [{ type: "fact_recorded", detail: { fact_id: fact.id, kind: "chatcut_project", uses_aroll: fact.uses_aroll } }] };
  });
  return receipt(r.value, r.explanation, content, null);
}

// ---- 回执 ----

function nextAction(core: ReceiptCore, exp: Explanation): string {
  if (core.state === "candidate") return "已记成候选：文件不在可搬入的目录里，等创始人在卡片上点「是这条」。不要替创始人确认，也不要自己挪文件。";
  if (core.kind === "aroll") return `原片已在项目里（path）。从这个新路径导入 ChatCut，导入后 record kind=chatcut_project chatcut_project_id=<工程 id> uses_aroll=["${core.fact_id}"]。`;
  if (core.kind === "cut") return `成片已收。把这版的字幕也报上来（record kind=srt for_cut="${core.fact_id}"），然后等创始人审成片——成片通过只能创始人点。`;
  const missing = exp.missing.length ? `还差：${exp.missing.join("、")}。` : "";
  return `${missing}看 autocrew_content summary 取最新进度；批准与选封面只能创始人点。`;
}

async function receiptFor(content: Content, dataDir: string, core: ReceiptCore): Promise<Receipt> {
  const exp = await explainContent(content, dataDir);
  return receipt(core, exp, content, contentRoot(content.id, dataDir));
}

function receipt(core: ReceiptCore, exp: Explanation, content: Content, projectRoot: string | null, note?: string): Receipt {
  const view = exp.shadow ?? exp;
  return {
    ok: true, content_id: content.id, ...core,
    ...(projectRoot && core.path && !path.isAbsolute(core.path) ? { project_path: path.join(projectRoot, core.path) } : {}),
    stage: view.stage ?? view.column, missing: view.missing, badges: view.badges, candidates: view.candidates,
    ...(exp.shadow ? { shadow: true } : {}), ...(note ? { note } : {}),
    next_action: nextAction(core, view),
  };
}
