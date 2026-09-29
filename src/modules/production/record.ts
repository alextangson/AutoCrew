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
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import type { Explanation } from "./explain.js";
import { cloneInto, identityOf, reserveTarget, safeStem, sameIdentity } from "./files.js";
import { withFileOwnership } from "./mutex.js";
import { normalizeRecordArgs, type RecordArgs } from "./record-args.js";
import { checkTargetDir, planFileRecord, targetDirOf, type FilePlan } from "./record-plan.js";
import { resolveLocalFile, stableFingerprint } from "./files.js";
import { arollOwnerElsewhere } from "./sha-index.js";
import { isWithin } from "../../storage/storage-roots.js";
import fs from "node:fs/promises";
import { explainContent } from "./read.js";
import { ensureProductionReady, mutateProduction } from "./service.js";
import { commitRegistration } from "./registration.js";
import { canonPlatform, observationFact } from "./receipts.js";
import { dropTxn, isCommitted, rollbackTxn, runMove, saveTxn, type ReleaseOp, type Txn, type TxnOp } from "./txn.js";
import { applyRelease } from "./release.js";

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
    a.chatcut_project_id ?? "", a.timeline_id ?? "", [...(a.uses_aroll ?? [])].sort()]);
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
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const replay = doc.requests?.[a.request_id];
  if (replay && (replay.args ? replay.args !== requestArgs(a) : replay.receipt.kind !== a.kind)) {
    return fail("request_conflict", `request_id「${a.request_id}」已经用来报过另一件东西（${String(replay.receipt.kind)}）：这次的参数不同，换一个新的 request_id 再报`);
  }
  if (replay) return { ...(await receiptFor(content, dataDir, replay.receipt as unknown as ReceiptCore)), replayed: true };
  if (a.kind === "chatcut_project") return recordChatcut(a, content, doc, dataDir);
  if (a.kind === "publish") return recordPublishClaim(content, dataDir, a);
  const plan = await planFileRecord(a, content, doc, dataDir);
  if (!plan.ok) return fail(plan.code, plan.error);
  const r = await commitFile(a, content, plan.value, dataDir);
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

export const ONTOLOGY_NOT_ENABLED =
  "本体还没启用（或这条在启用时被排除了）：record 现在不写事实、不搬文件。请创始人先在看板顶部看差异清单并确认启用；在那之前照旧流程走。";

interface ReceiptCore { fact_id: string; kind: Fact["kind"]; state: Fact["state"]; path?: string; reason?: string }

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
  Object.assign(target, { state: fact.state, path: fact.path, availability: "present", evidence: fact.evidence, size: fact.size, mtime_ms: fact.mtime_ms, ...(fact.txn_id ? { txn_id: fact.txn_id } : {}) });
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

async function commitFile(a: RecordArgs, content: Content, p: FilePlan, dataDir: string, release?: ReleaseOp): Promise<Receipt> {
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
  let r;
  try {
    r = await mutateProduction(content.id, dataDir, (doc) => {
      const fact = reuse ? doc.facts.find((f) => f.id === p.existing!.id)! : upsertFact(doc, { ...factFrom(a, p, doc, rel, moves ? txn.id : undefined), ...(placed ?? {}) }, p.existing);
      // 已有字幕没绑成片、这次报了 for_cut：补上绑定，不丢新信息（Codex 审 P2）
      if (reuse && p.for_cut && fact.kind === "srt" && !fact.for_cut) fact.for_cut = p.for_cut;
      const core: ReceiptCore = { fact_id: fact.id, kind: fact.kind, state: fact.state, ...(fact.path ? { path: fact.path } : {}), ...(fact.state === "candidate" ? { reason: p.evidence } : {}) };
      doc.requests = { ...(doc.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), args: requestArgs(a), receipt: { ...core } } };
      if (journaled) doc.txns = [...(doc.txns ?? []), txn.id];
      return { value: core, events: reuse ? [] : [{ type: "fact_recorded", detail: { fact_id: fact.id, kind: fact.kind, state: fact.state, by: a.host } }] };
    });
  } catch (err) { return commitFailed(a, content, dataDir, txn, journaled, err); }
  if (release) await applyRelease(dataDir, release);
  if (journaled) await dropTxn(dataDir, txn.id);
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
    d.requests = { ...(d.requests ?? {}), [a.request_id]: { at: new Date().toISOString(), args: requestArgs(a), receipt: { ...core } } };
    return { value: core, events: [{ type: "fact_recorded", detail: { fact_id: fact.id, kind: "chatcut_project", uses_aroll: fact.uses_aroll } }] };
  });
  return receipt(r.value, r.explanation, content, null);
}

// ---- 回执 ----

function nextAction(core: ReceiptCore, exp: Explanation): string {
  if (core.state === "candidate") return `已记成候选（${core.reason ?? "归属要创始人确认"}），等创始人在卡片上点「是这条」。不要替创始人确认，也不要自己挪文件。`;
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

export async function adoptCandidate(content: Content, fact: Fact, dataDir: string, opts: { reassign?: boolean } = {}): Promise<Receipt> {
  const a: RecordArgs = { content_id: content.id, kind: fact.kind, request_id: `confirm-${fact.id}`, host: "founder", ...(fact.path ? { path: fact.path } : {}), ...(fact.ratio ? { ratio: fact.ratio } : {}) };
  if (!fact.path || !fact.sha256) return fail("bad_request", "这条候选没有文件");
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const projectRoot = await fs.realpath(contentRoot(content.id, dataDir));
  const abs = path.isAbsolute(fact.path) ? fact.path : path.join(projectRoot, fact.path);
  const checked = await resolveLocalFile(abs, "候选文件");
  if (!checked.ok) return fail(checked.code, checked.error);
  const fp = await stableFingerprint(checked.value, Date.now());
  if (!fp.ok) return fail(fp.code, fp.error);
  if (fp.value.sha256 !== fact.sha256) return fail("stale", "候选文件在发现之后被改过，刷新再看");
  let release: ReleaseOp | undefined;
  if (fact.kind === "aroll") {
    const own = await arollOwnership(content, fact.sha256, dataDir, opts.reassign === true);
    if ("block" in own) return own.block;
    release = own.release;
  }
  const referenced = doc.facts.some((f) => f.round === doc.round && f.kind === "chatcut_project" && f.uses_aroll?.includes(fact.id));
  const inProject = isWithin(projectRoot, checked.value);
  const action = inProject || (fact.kind === "aroll" && referenced) ? "in_place" : fact.kind === "aroll" ? "move" : "clone";
  const version = fact.kind === "cover" ? fact.version ?? Math.max(0, ...doc.facts.filter((f) => f.kind === "cover" && f.version).map((f) => f.version!)) + 1 : undefined;
  const plan: FilePlan = { action, kind: fact.kind, source: checked.value, sha256: fact.sha256, id: fp.value.id, projectRoot, location: inProject ? "project" : "other",
    evidence: "创始人确认是这条", existing: fact, ...(fact.ratio ? { ratio: fact.ratio } : {}), ...(version ? { version } : {}), ...(fact.for_cut ? { for_cut: fact.for_cut } : {}) };
  if (action !== "in_place") {
    const safe = await checkTargetDir(projectRoot, targetDirOf(fact.kind, version));
    if (!safe.ok) return fail(safe.code, safe.error);
  }
  return commitFile(a, content, plan, dataDir, release);
}
