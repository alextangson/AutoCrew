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
import { isOntologyActive, newId, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact, ProductionDoc, ReadyMark } from "../../storage/production-types.js";
import { addMember, admittedGroupKey, ensureGroup, groupOfVersion, groupsOfFact, validCoverGroups, nextCoverVersion, retiredGroupOfLabel, slotTaken, versionLabelOf, withCoverGroups } from "./cover-groups.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import type { Explanation } from "./explain.js";
import { checkDuration, cloneInto, identityOf, reserveTarget, safeStem, sameIdentity } from "./files.js";
import { probe } from "./roots.js";
import { withFileOwnership } from "./mutex.js";
import { normalizeRecordArgs, type RecordArgs } from "./record-args.js";
import { checkTargetDir, planFileRecord, targetDirOf, type FilePlan } from "./record-plan.js";
import { resolveLocalFile, stableFingerprint } from "./files.js";
import { arollOwnerElsewhere } from "./sha-index.js";
import { isWithin } from "../../storage/storage-roots.js";
import fs from "node:fs/promises";
import { explainContent } from "./read.js";
import { approvedCoverShas, ensureProductionReady, mutateProduction } from "./service.js";
import { commitRegistration } from "./registration.js";
import { canonPlatform, observationFact } from "./receipts.js";
import { dropTxn, isCommitted, rollbackTxn, runMove, saveTxn, type ReleaseOp, type Txn, type TxnOp } from "./txn.js";
import { applyRelease } from "./release.js";
import { STORYBOARD_HINT, validateStoryboard } from "./storyboard.js";
import { currentCut, triggerSliverCheck } from "./sliver/check.js";
import { latestCheck } from "./sliver/verdict.js";
import { pendingElsewhere, pendingElsewhereText, type PendingHolder } from "./match/reservation.js";
import { cancelPendingFor, startMatchJob } from "./match/pending.js";
import { chatcutHold, inUseEvidence } from "./chatcut-refs.js";

type Receipt = Record<string, unknown>;
const fail = (code: string, error: string, extra: Receipt = {}): Receipt => ({ ok: false, code, error, ...extra });

/**
 * 模型报的「发了」（record kind=publish、模型调 confirm_published）：记成本轮一条**待核**回执（§6，§13-E），
 * 不动阶段；卡上问创始人「是吗？」，数据回流对上或创始人确认后才算已发布。调用方持有文件归属事务或不需要（只写事实）。
 */
export async function recordPublishClaim(content: Content, dataDir: string, a: Pick<RecordArgs, "platform" | "account" | "url" | "item_id" | "host" | "request_id" | "note">): Promise<Receipt> {
  const platform = a.platform || content.platform ? canonPlatform((a.platform || content.platform)!) : undefined;
  if (!platform) return fail("bad_param", "kind=publish 要带 platform");
  if (!a.url && !a.item_id) return fail("bad_param", "kind=publish 要带作品链接 url 或平台作品 id item_id");
  if (a.url && !/^https?:\/\//.test(a.url)) return fail("bad_param", `url 只接受 http/https：${a.url.slice(0, 80)}`);
  const r = await mutateProduction(content.id, dataDir, (doc) => {
    // 模型声明是一条独立的观察（不可变，不与可信回执合并）；是本轮刚说的，所以属于本轮
    const obs = { source: "claim" as const, platform, pub_state: "reviewing" as const, evidence: `${a.host} 说已发布`, by: { host: a.host },
      ...(a.account ? { account: a.account } : {}), ...(a.url ? { url: a.url } : {}), ...(a.item_id ? { item_id: a.item_id } : {}) };
    // 同一个 request_id 重放不再写；否则追加一条（AI 的说法只能被同平台的可信观察顶掉或创始人确认）
    // 同一轮、同平台、同一个 AI、同一链接 / 作品 id 已经说过：重复的「发了」不再追加（模型反复 confirm_published）
    const same = doc.facts.find((f) => f.kind === "publish" && f.request_id === a.request_id)
      ?? doc.facts.find((f) => f.kind === "publish" && f.obs_source === "claim" && f.round === doc.round && f.platform === platform
        && f.by?.host === a.host && (f.url ?? "") === (a.url ?? "") && (f.item_id ?? "") === (a.item_id ?? ""));
    const fact = same ?? { ...observationFact(doc, obs, doc.round), request_id: a.request_id };
    if (!same) doc.facts.push(fact);
    doc.requests = { ...(doc.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), args: requestArgs({ ...a, kind: "publish", content_id: content.id }), receipt: { fact_id: fact.id, kind: "publish", state: fact.state } } };
    return { value: fact, events: same ? [] : [{ type: "publish_claimed", detail: { fact_id: fact.id, platform, by: a.host, url: a.url } }] };
  });
  return { ok: true, content_id: content.id, fact_id: r.value.id, kind: "publish", verified: false, stage: r.explanation.stage ?? r.explanation.column, badges: r.explanation.badges,
    next_action: "已记成待核的发布回执：卡上会问创始人「是吗？」，数据回流对上或创始人确认后才算已发布。不要再改状态。" };
}

/** 请求参数指纹（kind / 路径 / 比例 / 平台 / 链接…）：同一 request_id 换了参数不是重试 */
function requestArgs(a: RecordArgs): string {
  return JSON.stringify([a.kind, a.path ?? "", a.ratio ?? "", a.version ?? "", a.for_cut ?? "", a.platform ?? "", a.url ?? "", a.item_id ?? "",
    a.chatcut_project_id ?? "", a.timeline_id ?? "", [...(a.uses_aroll ?? [])].sort(), ...(a.review ? ["review"] : []), ...(a.paths ? [a.paths] : []), ...(a.pair_with ? [a.pair_with] : [])]);
}

export async function executeRecord(params: Record<string, unknown>): Promise<Receipt> {
  const parsed = normalizeRecordArgs(params);
  if (!parsed.ok) return fail(parsed.code, parsed.error);
  const a = parsed.value;
  const dataDir = getDataDir(params._dataDir as string | undefined);
  await ensureProductionReady(dataDir);
  return withFileOwnership(() => recordLocked(a, dataDir));
}

async function recordLocked(a: RecordArgs, dataDir: string): Promise<Receipt> {
  const content = await getContent(a.content_id, dataDir);
  if (!content || content.deletedAt) return fail("not_found", `找不到这篇稿（${a.content_id}）：不存在或已删除`);
  if (!isVideoPlatform(content.platform)) return fail("not_video", "图文稿不走制作段，没有原片 / 成片可报");
  // 影子模式边界（§4.1，Codex 审 P1）：没启用（或这条被排除）之前不写事实、不搬文件
  if (!(await isOntologyActive(dataDir, content.id))) return fail("ontology_not_enabled", ONTOLOGY_NOT_ENABLED);
  // 封面组按 §6.2 迁移后的样子规划（还没落盘的迁移在内存里做，写入时 mutateProduction 落同一个结果）
  const raw = await readProductionDocOrEmpty(content.id, dataDir);
  const doc = withCoverGroups(raw, approvedCoverShas(raw, content.body));
  const replay = doc.requests?.[a.request_id];
  if (replay && (replay.args ? replay.args !== requestArgs(a) : replay.receipt.kind !== a.kind)) {
    return fail("request_conflict", `request_id「${a.request_id}」已经用来报过另一件东西（${String(replay.receipt.kind)}）：这次的参数不同，换一个新的 request_id 再报`);
  }
  if (replay?.receipt.pair) return { ...(await pairReceiptNow(content, doc, dataDir, replay.receipt.pair as Receipt)), replayed: true };
  if (replay) return { ...(await receiptFor(content, dataDir, currentCore(doc, replay.receipt as unknown as ReceiptCore))), replayed: true };
  if (a.kind === "chatcut_project") return withSliverCheck(await recordChatcut(a, content, doc, dataDir), content.id, dataDir);
  if (a.kind === "publish") return recordPublishClaim(content, dataDir, a);
  if (a.kind === "storyboard") return recordStoryboard(a, content, dataDir);
  if (a.kind === "cover" && a.paths) return recordCoverPair(a, content, doc, dataDir);
  const plan = await planFileRecord(a, content, doc, dataDir);
  if (!plan.ok) return fail(plan.code, plan.error);
  const r = a.kind === "cut" || a.kind === "srt" ? await withSliverCheck(await commitFile(a, content, plan.value, dataDir), content.id, dataDir) : await commitFile(a, content, plan.value, dataDir);
  // 字幕等后到时，补齐事实就自动完成登记（§5：两个判断已给过，不算替创始人判断）
  if (r.ok) {
    const commit = await commitRegistration(content.id, dataDir);
    if (!commit.ok) return { ...r, registration_failed: commit.reason };
    // 登记的 warning（投影没写完、实拍版没存上）一路带回回执（Codex 审 seg3 P2）
    const warnings = commit.warnings?.length ? { warnings: commit.warnings } : {};
    if (commit.registration) return { ...r, registration: commit.registration.id, ...warnings };
    if (commit.warnings?.length) return { ...r, ...warnings };
  }
  return r;
}

/**
 * 成片 / ChatCut 工程报上来之后跑一次抽帧检查（spec §5）：结果带进回执，让剪辑当场知道有没有缝。
 * 检查自己的失败落成「未检查」；只有结果写不上才带 warning。
 */
async function withSliverCheck(r: Receipt, contentId: string, dataDir: string): Promise<Receipt> {
  if (!r.ok) return r;
  const err = await triggerSliverCheck(contentId, dataDir);
  if (err) return { ...r, warnings: [...((r.warnings as string[] | undefined) ?? []), err] };
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const cut = currentCut(doc);
  const check = cut ? latestCheck(doc, cut.sha256!) : null;
  if (!check) return r;
  const summary = check.status === "clean" ? "没有抽帧缝" : check.status === "slivers" ? `抽帧缝 ${check.slivers.length} 处（${check.slivers.map((x) => x.start_tc).join("、")}）：修好后重新导出再报，或等创始人逐处放行` : `抽帧检查没跑成：${check.reason ?? ""}`;
  return { ...r, sliver_check: { status: check.status, slivers: check.slivers.length, ...(check.reason ? { reason: check.reason } : {}), summary } };
}

/**
 * `autocrew_content action=mark_ready`（review-inbox §7-1）：给已收的成片补标「可以审了」。独立、幂等的事件，
 * 绑 fact / sha / round；只 agent 标（网页没有这个动作）。BGM 和混音都好了才标。
 */
export async function executeMarkReady(params: Record<string, unknown>): Promise<Receipt> {
  const contentId = typeof params.content_id === "string" ? params.content_id.trim() : typeof params.id === "string" ? params.id.trim() : "";
  const factId = typeof params.fact_id === "string" ? params.fact_id.trim() : "";
  if (!contentId || !factId) return fail("bad_param", "mark_ready 要带 content_id 和成片的 fact_id（record 回执或 summary 里的）");
  const host = typeof params._host === "string" && params._host.trim() ? params._host.trim() : "local-user";
  const session = typeof params._session === "string" ? params._session : undefined;
  const dataDir = getDataDir(params._dataDir as string | undefined);
  if (!(await isOntologyActive(dataDir, contentId))) return fail("ontology_not_enabled", ONTOLOGY_NOT_ENABLED);
  await ensureProductionReady(dataDir);
  return withFileOwnership(async () => {
    const content = await getContent(contentId, dataDir);
    if (!content || content.deletedAt) return fail("not_found", `找不到这篇稿（${contentId}）`);
    const doc = await readProductionDocOrEmpty(contentId, dataDir);
    const f = doc.facts.find((x) => x.id === factId && x.round === doc.round);
    if (!f || f.kind !== "cut") return fail("not_found", `本轮没有这版成片：${factId}（用 record kind=cut 的回执或 summary 里的成片 fact_id）`);
    if (f.state !== "accepted") return fail("not_accepted", "这版成片还是候选：等创始人确认它是这条的成片再标");
    if (f.replaced_at) return fail("cut_replaced", "这版成片的文件被覆盖过：重新导出后 record kind=cut review=true");
    const r = await mutateProduction(contentId, dataDir, (d) => {
      const fact = d.facts.find((x) => x.id === factId)!;
      const events = addReadyMark(d, fact, { host, ...(session ? { session } : {}) });
      return { value: events.length > 0, events };
    });
    return { ok: true, content_id: contentId, fact_id: factId, marked: true, ...(r.value ? {} : { note: "这版之前已经标过，这次没有新动作" }),
      next_action: "已标「可以审了」：创始人会在「等你拍板」里看到它。不要替创始人通过；用 autocrew_content summary 看结果。" };
  });
}

export const ONTOLOGY_NOT_ENABLED =
  "本体还没启用（或这条在启用时被排除了）：record 现在不写事实、不搬文件。请创始人先在看板顶部看差异清单并确认启用；在那之前照旧流程走。";

/**
 * 重放按事实的当前状态回（Codex 审 segA P2）：同一文件用 r1、r2 两个 request_id 报过，核对落定后
 * 两个都要回落定后的状态与路径，不能一个停在 pending_match / 旧路径。
 */
function currentCore(doc: ProductionDoc, stored: ReceiptCore): ReceiptCore {
  const f = stored.fact_id ? doc.facts.find((x) => x.id === stored.fact_id) : undefined;
  if (!f) return stored;
  const rest: ReceiptCore = { ...stored };
  delete rest.reason;
  return { ...rest, state: f.state, ...(f.path ? { path: f.path } : {}), ...(f.state === "candidate" || f.state === "rejected" ? { reason: f.evidence ?? stored.reason } : {}) };
}

interface ReceiptCore { fact_id: string; kind: Fact["kind"]; state: Fact["state"]; path?: string; reason?: string; group_id?: string }

type NewEvent = { type: string; detail: Record<string, unknown> };

function joinCoverGroup(doc: ProductionDoc, fact: Fact, p: FilePlan, a: RecordArgs): NewEvent[] {
  const explicit = Boolean(a.paths || a.pair_with || a.version);
  const key = p.action === "in_place" && !explicit ? admittedGroupKey(fact.path) ?? p.group : p.group ?? admittedGroupKey(fact.path);
  if (!key) return [];
  const g = ensureGroup(doc, key, { source: a.host === "founder" ? "founder" : "record", by: { host: a.host, ...(a.session ? { session: a.session } : {}) } });
  const added = addMember(doc, g, fact);
  return [{ type: added ? "cover_grouped" : "cover_group_same", detail: { group_id: g.id, label: g.label, fact_id: fact.id, ratio: fact.ratio } }];
}

/** 「可以审了」：同一轮同一 fact + sha 只记一次（幂等） */
export function addReadyMark(doc: ProductionDoc, fact: Fact, a: Pick<RecordArgs, "host" | "session">): NewEvent[] {
  // 只对「还在等审」的标记去重：这版被打回（还要改…）之后再标 = 重新交审，开新代次（Codex 审 2a-1 P2）
  const rejectedAfter = (at: string) => doc.decisions.some((d) => d.round === doc.round && d.type === "cut_reject" && d.sha256 === fact.sha256 && d.at >= at);
  if ((doc.ready_marks ?? []).some((m) => m.round === doc.round && m.fact_id === fact.id && m.sha256 === fact.sha256 && !rejectedAfter(m.at))) return [];
  const mark: ReadyMark = { id: newId("rdy"), fact_id: fact.id, sha256: fact.sha256!, round: doc.round, at: new Date().toISOString(), by: { host: a.host, ...(a.session ? { session: a.session } : {}) } };
  doc.ready_marks = [...(doc.ready_marks ?? []), mark];
  return [{ type: "cut_ready", detail: { fact_id: fact.id, mark_id: mark.id, by: a.host } }];
}

// ---- 落位 ----

async function reserveFor(p: FilePlan, content: Content): Promise<string> {
  const ext = path.extname(p.source).toLowerCase();
  const rel = targetDirOf(p.kind, p.version);
  const again = await checkTargetDir(p.projectRoot, rel);
  if (!again.ok) throw new Error(again.error);
  const dir = path.join(p.projectRoot, rel);
  await fs.mkdir(dir, { recursive: true });
  if (!isWithin(p.projectRoot, await fs.realpath(dir))) throw new Error(`目标目录出了项目：${rel}`);
  const stem = p.kind === "aroll" ? `${safeStem(content.title)}-原片` : p.kind === "cover" ? `封面-${p.ratio === "3:4" ? "3x4" : "4x3"}` : path.basename(p.source, path.extname(p.source));
  return reserveTarget(dir, stem, ext);
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

function factFrom(a: RecordArgs, p: FilePlan, doc: ProductionDoc, relPath: string | null, txnId: string | undefined, jobId?: string): Fact {
  const state: Fact["state"] = p.action === "pending" ? "pending_match" : p.action === "candidate" ? "candidate" : "accepted";
  const at = new Date().toISOString();
  return {
    id: newId("fact"), kind: p.kind, round: doc.round, state, availability: "present",
    source: "record", by: { host: a.host, ...(a.session ? { session: a.session } : {}) }, at, ...(jobId ? { match_job: jobId, match_started_at: at } : {}),
    request_id: a.request_id, evidence: p.evidence, ...(txnId ? { txn_id: txnId } : {}),
    path: relPath ?? p.source, sha256: p.sha256, size: p.id.size, mtime_ms: p.id.mtime_ms,
    ...(p.duration_ms ? { duration_ms: p.duration_ms } : {}), ...(p.kind === "cut" ? { export_mtime_ms: p.id.mtime_ms } : {}), ...(p.kind === "aroll" ? { source_path: p.source } : {}), ...(p.ratio ? { ratio: p.ratio } : {}), ...(p.version ? { version: p.version } : {}),
    ...(a.cover_text && p.kind === "cover" ? { text: a.cover_text } : {}), ...(p.for_cut ? { for_cut: p.for_cut } : {}), ...(a.note ? { note: a.note } : {}),
  };
}

/** 已有候选被再次报成可收的：原地升级（挪了的改路径），不另起一条 */
function upsertFact(doc: ProductionDoc, fact: Fact, existing: Fact | undefined): Fact {
  if (!existing) { doc.facts.push(fact); return fact; }
  const target = doc.facts.find((f) => f.id === existing.id)!;
  // 导出时间与原始路径随升级带上（Codex 审 sliver P1）：克隆后的 mtime_ms 是落位时间，不能拿来比时间线保存时间
  Object.assign(target, { state: fact.state, path: fact.path, availability: "present", evidence: fact.evidence, size: fact.size, mtime_ms: fact.mtime_ms, ...(fact.txn_id ? { txn_id: fact.txn_id } : {}),
    ...(fact.match_job ? { match_job: fact.match_job, match_started_at: fact.match_started_at } : {}),
    ...(fact.export_mtime_ms !== undefined ? { export_mtime_ms: target.export_mtime_ms ?? fact.export_mtime_ms } : {}), ...(fact.source_path ? { source_path: target.source_path ?? fact.source_path } : {}) });
  return target;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 放文件失败：撤回成功才说「原件没动」，撤不回就照实说日志留着 */
async function placeFailed(dataDir: string, txn: Txn, err: unknown): Promise<Receipt> {
  const undone = await rollbackTxn(dataDir, txn).then(() => true, () => false);
  return fail("place_failed", undone ? `落位失败，已撤回、原件没动：${errMsg(err)}` : `落位失败，且没能自动撤回（事务日志留着，重启时按事务 id 核定）：${errMsg(err)}`);
}

/** 写事实那一步抛错：按持久提交点核定（Codex 审 P1），已提交补回执，确定未提交才撤回，不确定就留日志 */
async function commitFailed(a: RecordArgs, content: Content, dataDir: string, txn: Txn, moves: boolean, err: unknown): Promise<Receipt> {
  if (!moves) return fail("record_failed", `事实没记上：${errMsg(err)}`);
  const committed = await isCommitted(dataDir, content.id, txn.id);
  if (committed === true) {
    if (txn.release) await applyRelease(dataDir, txn.release);
    await dropTxn(dataDir, txn.id);
    const core = (await readProductionDocOrEmpty(content.id, dataDir)).requests?.[a.request_id]?.receipt as unknown as ReceiptCore;
    return { ...(await receiptFor(content, dataDir, core)), warning: `事实已记下，但之后的派生写入（投影 / 时间线 / 索引）失败：${errMsg(err)}` };
  }
  if (committed === false) {
    const undone = await rollbackTxn(dataDir, txn).then(() => true, () => false);
    return fail("record_failed", undone ? `事实没记上，已把文件撤回原处：${errMsg(err)}` : `事实没记上，文件也没能自动撤回（日志留着，重启时核定）：${errMsg(err)}`);
  }
  return fail("record_uncertain", `结果不确定（读不了制作记录）：事务日志留着，重启时按事务 id 核定。${errMsg(err)}`);
}

/** keepArgs：核对作业落结果时沿用原请求的参数指纹（重放照旧认）；patch：同一次写里给事实补的字段 */
export interface CommitOpts { keepArgs?: boolean; patch?: Partial<Fact>; event?: string }

export async function commitFile(a: RecordArgs, content: Content, p: FilePlan, dataDir: string, release?: ReleaseOp, opts: CommitOpts = {}): Promise<Receipt> {
  const reuse = p.action === "existing" || (p.action === "candidate" && p.existing);
  const moves = p.action === "move" || p.action === "clone";
  // 改挂：释放原稿记进同一份事务日志，接收方提交之后才执行（崩了由启动恢复按提交点补做或放弃）
  const journaled = moves || Boolean(release);
  const txn: Txn = { id: newId("txn"), kind: "record", content_id: content.id, round: 0, ops: [], at: new Date().toISOString(), ...(release ? { release } : {}) };
  if (release) await saveTxn(dataDir, txn);
  let rel: string | null = p.action === "in_place" && p.location === "project" ? path.relative(p.projectRoot, p.source) : null;
  let placed: { size: number; mtime_ms: number } | null = null;
  if (moves) {
    try {
      rel = await place(p, content, txn, dataDir);
      // 落位后的文件自己的大小 / 修改时间（克隆会得到新的修改时间；Codex 审 seg2 P1：别拿源文件时间比目标文件）
      const id = await identityOf(path.join(p.projectRoot, rel));
      placed = { size: id.size, mtime_ms: id.mtime_ms };
    } catch (err) { return placeFailed(dataDir, txn, err); }
  }
  const jobId = p.action === "pending" ? newId("mjob") : undefined;
  let r;
  try {
    r = await mutateProduction(content.id, dataDir, (doc) => {
      const fact = reuse ? doc.facts.find((f) => f.id === p.existing!.id)! : upsertFact(doc, { ...factFrom(a, p, doc, rel, moves ? txn.id : undefined, jobId), ...(placed ?? {}) }, p.existing);
      if (opts.patch) Object.assign(fact, opts.patch);
      // 封面记进组（review-inbox §6.1）：项目内原地收的按所在目录；其余按计划的组。同 sha 进新组 = 新成员关系
      const coverEvents = fact.kind === "cover" && fact.state === "accepted" ? joinCoverGroup(doc, fact, p, a) : [];
      // 已有字幕没绑成片、这次报了 for_cut：补上绑定，不丢新信息（Codex 审 P2）
      if (reuse && p.for_cut && fact.kind === "srt" && !fact.for_cut) fact.for_cut = p.for_cut;
      const core: ReceiptCore = { fact_id: fact.id, kind: fact.kind, state: fact.state, ...(fact.path ? { path: fact.path } : {}), ...(fact.state === "candidate" ? { reason: p.evidence } : {}) };
      const args = opts.keepArgs ? doc.requests?.[a.request_id]?.args ?? requestArgs(a) : requestArgs(a);
      doc.requests = { ...(doc.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), args, receipt: { ...core } } };
      if (journaled) doc.txns = [...(doc.txns ?? []), txn.id];
      if (coverEvents.length) core.group_id = coverEvents[0].detail.group_id as string;
      if (a.review && fact.kind === "cut" && fact.state === "accepted") coverEvents.push(...addReadyMark(doc, fact, a));
      return { value: core, events: [...(reuse ? [] : [{ type: opts.event ?? "fact_recorded", detail: { fact_id: fact.id, kind: fact.kind, state: fact.state, by: a.host } }]), ...coverEvents] };
    });
  } catch (err) { return commitFailed(a, content, dataDir, txn, journaled, err); }
  if (release) await applyRelease(dataDir, release);
  if (journaled) await dropTxn(dataDir, txn.id);
  const queued = jobId ? await startMatchJob(dataDir, content.id, r.value.fact_id, jobId, r.doc.round, p) : null;
  const rc = receipt(r.value, r.explanation, content, p.projectRoot, reuse ? "同一文件已经记过，这次没有新动作" : undefined);
  return queued ? { ...rc, warnings: [queued] } : rc;
}

async function joinExistingPair(a: RecordArgs, content: Content, doc: ProductionDoc, plans: FilePlan[], dataDir: string): Promise<Receipt | null> {
  const facts = plans.map((p) => p.existing);
  if (!facts.every((f) => f?.state === "accepted")) return null;
  const f34 = facts.find((f) => f!.ratio === "3:4")!, f43 = facts.find((f) => f!.ratio === "4:3")!;
  const group = validCoverGroups(doc).find((g) => g.complete && g.slots["3:4"][0].id === f34.id && g.slots["4:3"][0].id === f43.id);
  if (!group) return null;
  await mutateProduction(content.id, dataDir, (d) => {
    for (const f of d.facts.filter((x) => x.id === f34.id || x.id === f43.id)) if (a.cover_text && !f.text) f.text = a.cover_text;
    d.requests = { ...(d.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), args: requestArgs(a), receipt: { kind: "cover", pair: { facts: [{ fact_id: f34.id, ratio: "3:4" }, { fact_id: f43.id, ratio: "4:3" }] } } } };
    return { value: null, events: [{ type: "cover_pair_joined", detail: { group_id: group.group.id, by: a.host } }] };
  });
  const fresh = await readProductionDocOrEmpty(content.id, dataDir);
  return pairReceiptNow(content, withCoverGroups(fresh, approvedCoverShas(fresh, content.body)), dataDir, { facts: [{ fact_id: f34.id }, { fact_id: f43.id }] });
}

/**
 * 一对封面的重放按现在的样子回（整分支审 7 P2）：两张后来被确认收进组了，就回现在的状态、路径、组、阶段，
 * 和单张重放一样，不回当初缓存的那份。
 */
async function pairReceiptNow(content: Content, doc: ProductionDoc, dataDir: string, stored: Receipt): Promise<Receipt> {
  const facts = ((stored.facts as Array<{ fact_id: string; ratio?: string }>) ?? []).map((x) => {
    const f = doc.facts.find((y) => y.id === x.fact_id);
    return { fact_id: x.fact_id, ratio: f?.ratio ?? x.ratio, state: f?.state ?? "rejected", path: f?.path };
  });
  const groups = facts.map((f) => groupsOfFact(doc, f.fact_id).map((g) => g.group.id));
  const shared = groups[0]?.find((id) => groups.every((g) => g.includes(id))) ?? null;
  const exp = await explainContent(content, dataDir);
  const view = exp.shadow ?? exp;
  return { ok: true, content_id: content.id, kind: "cover", facts, group_id: shared, stage: view.stage ?? view.column, missing: view.missing,
    next_action: shared ? "这一组封面已记下（3:4 + 4:3）。挑哪组只能创始人在「等你拍板」里点。" : "这一对还没成组（候选等创始人确认，或其中一张没收下）：看「等你拍板」。" };
}

// ---- 封面一次记一组（review-inbox §6.1）：两张都先核完再落位；同一组、同一版本号 ----

async function recordCoverPair(a: RecordArgs, content: Content, doc: ProductionDoc, dataDir: string): Promise<Receipt> {
  const version = a.version ?? nextCoverVersion(doc);
  const parts = a.paths!.map((p, i): RecordArgs => ({ ...a, path: p, paths: a.paths, request_id: `${a.request_id}#${i}`, version }));
  const plans: FilePlan[] = [];
  for (const part of parts) {
    const plan = await planFileRecord(part, content, doc, dataDir);
    if (!plan.ok) return fail(plan.code, `${part.path}：${plan.error}`);
    plans.push(plan.value);
  }
  const ratios = plans.map((p) => p.ratio).sort().join(",");
  if (ratios !== "3:4,4:3") return fail("both_ratios_required", `paths 要一张 3:4、一张 4:3（按像素认），收到的是 ${plans.map((p) => p.ratio ?? "?").join(" + ")}`);
  // 这一对已经是一组了（最常见：对账先收了 05-cover/vNNN，agent 再报同两张）：并进那一组、补上封面字，不另起一组（verifier 2a P2）
  // 显式带了版本号 = agent 要另起那一版，不并
  const joined = a.version ? null : await joinExistingPair(a, content, doc, plans, dataDir);
  if (joined) return joined;
  const receipts: Receipt[] = [];
  for (const [i, plan] of plans.entries()) {
    const r = await commitFile(parts[i], content, plan, dataDir);
    receipts.push(r);
    if (!r.ok) return i === 0 ? r : { ...r, error: `第一张（${plans[0].ratio}）已记下，第二张没记上：${String(r.error)}`, first: receipts[0] };
  }
  const facts = receipts.map((r) => ({ fact_id: r.fact_id, ratio: plans[receipts.indexOf(r)].ratio, state: r.state, path: r.path }));
  const groupId = (receipts.find((r) => r.group_id)?.group_id as string | undefined) ?? null;
  const out = { ok: true, content_id: content.id, kind: "cover", facts, group_id: groupId, stage: receipts[1].stage, missing: receipts[1].missing,
    next_action: groupId ? "这一组封面已记下（3:4 + 4:3）。挑哪组只能创始人在「等你拍板」里点。" : "两张都只记成了候选（不在可搬入目录），等创始人在「等你拍板」里确认。" };
  await mutateProduction(content.id, dataDir, (d) => {
    d.requests = { ...(d.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), args: requestArgs(a), receipt: { kind: "cover", pair: out } } };
    return { value: null, events: [] };
  });
  return out;
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
    d.requests = { ...(d.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), args: requestArgs(a), receipt: { ...core } } };
    return { value: core, events: [{ type: "fact_recorded", detail: { fact_id: fact.id, kind: "chatcut_project", uses_aroll: fact.uses_aroll } }] };
  });
  return receipt(r.value, r.explanation, content, null);
}

// ---- storyboard：脚本生成的审阅页，原地收（不挪、不克隆），只显示不影响阶段 ----

async function recordStoryboard(a: RecordArgs, content: Content, dataDir: string): Promise<Receipt> {
  if (!a.path) return fail("bad_param", `kind=storyboard 要带 path（审阅页）。${STORYBOARD_HINT}`);
  const root = contentRoot(content.id, dataDir);
  const v = await validateStoryboard(root, a.path);
  if (!v.ok) return fail(v.code, v.error);
  const r = await mutateProduction(content.id, dataDir, (d) => {
    // 同一份页面重复报：幂等，不另起一条（E7）
    // 不分轮次（Codex 审 storyboard P2）：重开文稿后重报同一份页面也不另起一条，与对账去重一致
    const same = d.facts.find((f) => f.kind === "storyboard" && f.sha256 === v.value.sha256);
    const fact: Fact = same ?? { id: newId("fact"), kind: "storyboard", round: d.round, state: "accepted", availability: "present", source: "record",
      by: { host: a.host, ...(a.session ? { session: a.session } : {}) }, at: new Date().toISOString(), request_id: a.request_id, evidence: "脚本生成的审阅页（回执核对通过）",
      path: v.value.rel, sha256: v.value.sha256, size: v.value.size, mtime_ms: v.value.mtime_ms, version: v.value.version, receipt_sha256: v.value.receipt_sha256 };
    if (!same) d.facts.push(fact);
    const core: ReceiptCore = { fact_id: fact.id, kind: "storyboard", state: fact.state, path: fact.path };
    d.requests = { ...(d.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), args: requestArgs(a), receipt: { ...core } } };
    return { value: core, events: same ? [] : [{ type: "fact_recorded", detail: { fact_id: fact.id, kind: "storyboard", version: fact.version, by: a.host } }] };
  });
  return receipt(r.value, r.explanation, content, root);
}

// ---- 回执 ----

export const PENDING_NEXT = "正在核对这段原片是不是这条（约 2 分钟）：对上了会自动挪进项目，之后用 autocrew_content summary（带 since_seq）取 aroll[] 里的新路径导入 ChatCut；对不上会转成候选等创始人在「等你拍板」里点。";

function nextAction(core: ReceiptCore, exp: Explanation): string {
  if (core.state === "pending_match") return PENDING_NEXT;
  // 被拒的（核对期间文件变了 / 创始人说不是这条…）：给原因，别再提示导入（Codex 审 segB4 P2）
  if (core.state === "rejected") return `这个文件没收下${core.reason ? `：${core.reason}` : ""}。换一个文件重新 record（新的 request_id）；不要导入这个文件。`;
  if (core.state === "candidate") return `已记成候选（${core.reason ?? "归属要创始人确认"}），等创始人在「等你拍板」里点「对，就是它」。不要替创始人确认，也不要自己挪文件。`;
  if (core.kind === "aroll") return `原片已在项目里（path）。从这个新路径导入 ChatCut，导入后 record kind=chatcut_project chatcut_project_id=<工程 id> uses_aroll=["${core.fact_id}"]。`;
  if (core.kind === "storyboard") return `分镜已收下。要创始人拍板就用 ask kind=分镜 fact_id="${core.fact_id}"（选项里放 id=approve 表示通过），它会进「等你拍板」；不要再发 MD 或文件路径当分镜，也别在聊天里问。`;
  if (core.kind === "cut") return `成片已收。把这版的字幕也报上来（record kind=srt for_cut="${core.fact_id}"）。配乐和混音都好了才算可以审：那时 mark_ready fact_id="${core.fact_id}"（或 record 时带 review=true），创始人在「等你拍板」里审——成片通过只能创始人点。`;
  if (core.kind === "cover") return "封面已记下。一组要 3:4 + 4:3：下次用 paths 一次记一对，或第二张带 pair_with=<第一张 fact_id>。挑哪组只能创始人在「等你拍板」里点。";
  const missing = exp.missing.length ? `还差：${exp.missing.join("、")}。` : "";
  return `${missing}看 autocrew_content summary 取最新进度；批准与选封面只能创始人在「等你拍板」里点。`;
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

// ---- 创始人确认候选（§2.4「是这条」）：创始人的决定就是搬入授权 ----

/**
 * 候选 → accepted：库外的按 §3-7 落位（原片挪、其余克隆；被 ChatCut 引用的原片留原位），项目内的原地收。
 * 核验照 record 的顺序全部先做：路径、完整性、字节还是当初那份、A-roll 独占、目标目录安全。调用方持有文件归属事务。
 */
/**
 * 原片归属（创始人 09-29 默认：重开前那一轮的原片仍归原稿）。本轮在用 → 硬冲突；只是历史归属 → 没确认改挂就回冲突
 * （带归属信息供卡片确认）；确认了就返回要释放的原稿——释放和接收在同一个可恢复事务里做（commitFile）。
 */
async function arollOwnership(content: Content, sha: string, dataDir: string, reassign: boolean): Promise<{ block: Receipt } | { release?: ReleaseOp }> {
  const owner = await arollOwnerElsewhere(dataDir, sha, content.id);
  if (!owner) return {};
  const current = await arollOwnerElsewhere(dataDir, sha, content.id, { allowHistorical: true });
  const title = (await getContent(owner, dataDir))?.title ?? owner;
  if (current || !reassign) {
    return { block: fail("aroll_conflict", current ? `这个原片是《${title}》本轮正在用的 A-roll，一个原片只能属于一条稿` : `这个原片归《${title}》（它重开文稿前那一轮用过）；创始人确认改挂后才能挂到这条`,
      { owner_id: owner, owner_title: title, reassignable: !current }) };
  }
  return { release: { owner, sha256: sha, to: content.id } };
}

/**
 * `cancelPending`：别条稿正在核对这份原片（pending 预留，1b §3-7）时，创始人看过提示仍确认挂到这条 → 挂上之后取消那边的核对
 * （那边的事实转 rejected，evidence「创始人挂到了《这条》」）。没带就拒，说是哪条。
 */
export async function adoptCandidate(content: Content, fact: Fact, dataDir: string, opts: { reassign?: boolean; cancelPending?: boolean } = {}): Promise<Receipt> {
  const a: RecordArgs = { content_id: content.id, kind: fact.kind, request_id: `confirm-${fact.id}`, host: "founder", ...(fact.path ? { path: fact.path } : {}), ...(fact.ratio ? { ratio: fact.ratio } : {}) };
  if (!fact.path || !fact.sha256) return fail("bad_request", "这条候选没有文件");
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const projectRoot = await fs.realpath(contentRoot(content.id, dataDir));
  const abs = path.isAbsolute(fact.path) ? fact.path : path.join(projectRoot, fact.path);
  const checked = await resolveLocalFile(abs, "候选文件");
  // 报错不给绝对路径（verifier 2a P2）：只说文件名和怎么回事
  if (!checked.ok) return fail(checked.code, `「${path.basename(abs)}」已经不在原来的位置了（可能挂到了别条稿，或被挪走 / 删掉了）`);
  const fp = await stableFingerprint(checked.value, Date.now());
  if (!fp.ok) return fail(fp.code, fp.error);
  if (fp.value.sha256 !== fact.sha256) return fail("stale", "候选文件在发现之后被改过，刷新再看");
  // 完整性（Codex 审 segB12 P2）：原片 / 成片要读得出时长——名字对上的坏文件、没拷完的文件不收，原处不动，原因回给创始人
  if (fact.kind === "aroll" || fact.kind === "cut") {
    const dur = await checkDuration(checked.value, probe);
    if (!dur.ok) return fail(dur.code, `${dur.error}（文件留在原处：${path.basename(checked.value)}）`);
  }
  let release: ReleaseOp | undefined;
  let held: PendingHolder | null = null;
  if (fact.kind === "aroll") {
    const own = await arollOwnership(content, fact.sha256, dataDir, opts.reassign === true);
    if ("block" in own) return own.block;
    release = own.release;
    held = await pendingElsewhere(dataDir, fact.sha256, content.id);
    if (held && !opts.cancelPending) {
      return fail("aroll_pending_elsewhere", `${pendingElsewhereText(held.title)}；挂到这条会取消那边的核对`, { holder_id: held.content_id, holder_title: held.title });
    }
  }
  const referenced = doc.facts.some((f) => f.round === doc.round && f.kind === "chatcut_project" && f.uses_aroll?.includes(fact.id));
  const inProject = isWithin(projectRoot, checked.value);
  // 本机 ChatCut 工程按绝对路径在用的原片也不挪（§13-A 隐式引用）
  const hold = fact.kind === "aroll" && !inProject && !referenced ? await chatcutHold(checked.value) : { project: null, unverified: null };
  // 核不了 ChatCut 引用：不挪，原处不动，稍后再点（Codex 审 segB18 P2）
  if (hold.unverified) return fail("chatcut_unverified", hold.unverified);
  // 封面统一准入：项目里不在 vNNN/ 或 final/ 的候选封面确认后克隆进新一组（review-inbox §6.2）
  const coverOutside = fact.kind === "cover" && inProject && !admittedGroupKey(path.relative(projectRoot, checked.value));
  const action = (inProject && !coverOutside) || (fact.kind === "aroll" && (referenced || hold.project)) ? "in_place" : fact.kind === "aroll" ? "move" : "clone";
  // 确认的候选封面：record 时显式成对（paths / pair_with）记下的版本号沿用——一对的两张确认后仍在同一组；
  // 没有显式成对（对账找到的零散图）、那一版已作废或这个比例已被占，才自成新一组（Codex 审 2a-1 r6 P2）
  const keep = fact.kind === "cover" && fact.version && fact.ratio && fact.source === "record" && !retiredGroupOfLabel(doc, versionLabelOf(fact.version))
    && !(groupOfVersion(doc, fact.version) && slotTaken(doc, groupOfVersion(doc, fact.version)!, fact.ratio, fact.id));
  const version = fact.kind === "cover" ? (keep ? fact.version! : nextCoverVersion(doc)) : undefined;
  const plan: FilePlan = { action, kind: fact.kind, source: checked.value, sha256: fact.sha256, id: fp.value.id, projectRoot, location: inProject ? "project" : "other",
    evidence: hold.project ? `创始人确认是这条；${inUseEvidence(hold.project)}` : "创始人确认是这条", existing: fact, ...(fact.ratio ? { ratio: fact.ratio } : {}), ...(version ? { version, group: { label: versionLabelOf(version), version } } : {}), ...(fact.for_cut ? { for_cut: fact.for_cut } : {}) };
  if (action !== "in_place") {
    const safe = await checkTargetDir(projectRoot, targetDirOf(fact.kind, version));
    if (!safe.ok) return fail(safe.code, safe.error);
  }
  const r = await commitFile(a, content, plan, dataDir, release);
  if (r.ok && held) await cancelPendingFor(dataDir, held, content.title);
  return r;
}
