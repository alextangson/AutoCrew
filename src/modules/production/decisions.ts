/**
 * 创始人决定（spec §2.4）：只由浏览器会话路由（看板 / 工作台）写入；MCP 没有任何动作能到这里，
 * 模型调用在入口一律拒。每个决定带它针对的指纹（fact id + sha、封面两张 sha + 字……），**不带 expectedStatus**；
 * 幂等键 = (决定类型, 指纹)：重复点击返回原决定，不重写时间。
 *
 * 写完决定：成片 / 封面批准齐了就在同一个文件归属事务里跑登记提交（§5 批准即登记）。
 */
import { contentRoot } from "../../storage/content-project.js";
import { readLibraryLocation } from "../../storage/storage-roots.js";
import path from "node:path";
import { getContent, getDataDir, listContents, type Content } from "../../storage/local-store.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { exportMatchesTitle } from "../video/unregistered-cut.js";
import { checkDuration, resolveLocalFile, stableFingerprint } from "./files.js";
import { probe } from "./roots.js";
import { bodyHash, isOntologyActive, newId, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Decision, DecisionType, Fact, ProductionDoc } from "../../storage/production-types.js";
import { isModelCall } from "../../storage/stage-guard.js";
import { withFileOwnership } from "./mutex.js";
import { validCoverApproval, validCutApproval } from "./derive.js";
import { canonPlatform, normSlotId, slotGate, slotId, slotOf } from "./receipts.js";
import { gateFromPlan, isUngated } from "./publish-check-link.js";
import { adoptCandidate } from "./record.js";
import { commitRegistration, type CommitResult } from "./registration.js";
import { explainContent } from "./read.js";
import { ensureProductionReady, mutateProduction } from "./service.js";
import { currentCut, runSliverCheck } from "./sliver/check.js";
import { latestCheck, sliverKey, sliverVerdict, type Verdict } from "./sliver/verdict.js";

export type DecisionAction =
  | "confirm_candidate" | "reject_candidate" | "approve_cut" | "reject_cut" | "pick_cover" | "reject_cover"
  | "revoke_approval" | "i_published" | "confirm_receipt" | "correct_publish" | "attach_aroll" | "waive_sliver" | "waive_sliver_check";

export const DECISION_ACTIONS: readonly DecisionAction[] = [
  "confirm_candidate", "reject_candidate", "approve_cut", "reject_cut", "pick_cover", "reject_cover",
  "revoke_approval", "i_published", "confirm_receipt", "correct_publish", "attach_aroll", "waive_sliver", "waive_sliver_check",
];

type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");

export const FOUNDER_ONLY = "这是创始人的决定，只能在看板 / 工作台上点，AI 宿主不能代做。";

interface Ctx { content: Content; doc: ProductionDoc; dataDir: string; params: Record<string, unknown> }

const inRound = (doc: ProductionDoc) => doc.facts.filter((f) => f.round === doc.round);

function factBy(doc: ProductionDoc, params: Record<string, unknown>, kind?: Fact["kind"]): Fact | string {
  const id = str(params.fact_id), sha = str(params.sha256);
  const f = inRound(doc).find((x) => x.id === id && (!kind || x.kind === kind));
  if (!f) return "这条记录不在本轮里（可能刷新前已变），刷新再看";
  if (f.sha256 && f.sha256 !== sha) return "页面上的文件和记录对不上（文件换过），刷新再看";
  return f;
}

/** 幂等：同类型、同指纹、本轮最近一条还有效（没被撤）就直接返回它 */
function sameDecision(doc: ProductionDoc, type: DecisionType, fp: (d: Decision) => boolean): Decision | null {
  const revoked = new Set(doc.decisions.filter((d) => d.type === "approval_revoke" || d.type === "publish_correction").map((d) => d.target_id));
  const latest = [...doc.decisions].reverse().find((d) => d.round === doc.round && d.type === type);
  return latest && fp(latest) && !revoked.has(latest.id) ? latest : null;
}

async function push(ctx: Ctx, d: Omit<Decision, "id" | "round" | "at" | "source">, event: string, fact?: (doc: ProductionDoc) => void): Promise<Decision> {
  return (await mutateProduction(ctx.content.id, ctx.dataDir, (doc) => {
    const full: Decision = { id: newId("dec"), round: doc.round, at: new Date().toISOString(), source: "founder", ...d };
    doc.decisions.push(full);
    fact?.(doc);
    return { value: full, events: [{ type: event, detail: { decision_id: full.id, ...d } }] };
  })).value;
}

async function approveCut(ctx: Ctx): Promise<Result> {
  const f = factBy(ctx.doc, ctx.params, "cut");
  if (typeof f === "string") return fail("stale", f);
  if (f.state !== "accepted") return fail("not_accepted", "这版成片还是候选：先确认它是这条的成片");
  if (f.replaced_at) return fail("cut_replaced", "这版成片的文件被覆盖过，盘上已经不是它了：刷新看现在的成片再审");
  const bh = bodyHash(ctx.content.body);
  // 幂等重放只对仍然有效的批准（Codex 审 seg2 P2）：被打回之后再批，要落一条晚于打回的新决定
  const same = sameDecision(ctx.doc, "cut_approval", (d) => d.sha256 === f.sha256 && d.body_hash === bh && validCutApproval(ctx.doc, ctx.content.body)?.id === d.id);
  if (same) return { ok: true, decision: same };
  // 抽帧检查默认拦（spec 2026-09-30 §12-1）：写批准之前在服务端重跑 / 核对指纹，不只靠推导和界面
  const gate = await sliverGate(ctx, f.sha256!);
  if (!gate.ok) return fail("sliver_blocked", `成片还不能通过：${gate.missing}。在卡片上看每处缝，修好重新导出，或逐处点「这处是故意的」`);
  return { ok: true, decision: await push(ctx, { type: "cut_approval", fact_id: f.id, sha256: f.sha256, body_hash: bh }, "cut_approved") };
}

/** 重跑（同指纹直接用缓存）→ 用重算出的当前指纹判：结果必须对应现在的输入 */
async function sliverGate(ctx: Ctx, cutSha: string): Promise<Verdict> {
  const run = await runSliverCheck(ctx.content.id, ctx.dataDir);
  const doc = await readProductionDocOrEmpty(ctx.content.id, ctx.dataDir);
  if (currentCut(doc)?.sha256 !== cutSha) return { ok: false, missing: "这版已经不是当前成片", check: null, open: [], wholeWaived: false, wholeWaivable: false };
  return sliverVerdict(doc, cutSha, run?.fingerprint ?? "\u0000none");
}

/** 「这处是故意的」：绑 round + 成片 sha + 结果指纹 + 缝身份；只对当前结果里的那一处有效（§12-8、E28） */
async function waiveSliver(ctx: Ctx): Promise<Result> {
  const cutSha = str(ctx.params.cut_sha), fingerprint = str(ctx.params.fingerprint), key = str(ctx.params.sliver_key);
  if (!cutSha || !fingerprint || !key) return fail("bad_request", "要带成片、检查结果和哪一处（刷新再点）");
  const run = await runSliverCheck(ctx.content.id, ctx.dataDir);
  const doc = await readProductionDocOrEmpty(ctx.content.id, ctx.dataDir);
  if (currentCut(doc)?.sha256 !== cutSha) return fail("stale", "成片换过了，放行不继承：刷新看新成片的检查结果");
  const check = latestCheck(doc, cutSha);
  if (!run || !check || check.fingerprint !== fingerprint || run.fingerprint !== fingerprint || !check.slivers.some((x) => sliverKey(x) === key)) {
    return fail("stale", "这处缝已经不在当前的检查结果里了（时间线或成片变过）：刷新再看");
  }
  const same = doc.decisions.find((d) => d.type === "sliver_waive" && d.round === doc.round && d.sha256 === cutSha && d.fingerprint === fingerprint && d.sliver_key === key);
  return { ok: true, decision: same ?? (await push(ctx, { type: "sliver_waive", sha256: cutSha, fingerprint, sliver_key: key }, "sliver_waived")) };
}

/** 「这条不查了，放行」：只在检查没跑成（或没结果）时有（E13）；绑 round + 成片 sha */
async function waiveSliverCheck(ctx: Ctx): Promise<Result> {
  const cutSha = str(ctx.params.cut_sha);
  await runSliverCheck(ctx.content.id, ctx.dataDir);
  const doc = await readProductionDocOrEmpty(ctx.content.id, ctx.dataDir);
  if (!cutSha || currentCut(doc)?.sha256 !== cutSha) return fail("stale", "成片换过了，放行不继承：刷新再看");
  const check = latestCheck(doc, cutSha);
  if (check && check.status !== "unchecked") return fail("not_unchecked", check.status === "clean" ? "这版成片查过了、没有缝，不用放行" : "这版成片查出了缝：逐处看，故意的点「这处是故意的」");
  const same = doc.decisions.find((d) => d.type === "sliver_waive_all" && d.round === doc.round && d.sha256 === cutSha);
  return { ok: true, decision: same ?? (await push(ctx, { type: "sliver_waive_all", sha256: cutSha, ...(check?.reason ? { note: check.reason } : {}) }, "sliver_check_waived")) };
}

async function rejectWith(ctx: Ctx, type: "cut_reject" | "cover_reject", kind: Fact["kind"]): Promise<Result> {
  const note = str(ctx.params.note);
  if (!note) return fail("note_required", "打回要写原话，告诉剪辑哪里要改");
  // 封面打回针对「当前展示的整批」：带整批指纹即可，不指某一张
  const f = type === "cover_reject" && !str(ctx.params.fact_id) ? { id: undefined, sha256: str(ctx.params.sha256) } : factBy(ctx.doc, ctx.params, kind);
  if (typeof f === "string") return fail("stale", f);
  if (!f.sha256) return fail("stale", "页面上没有可打回的产物，刷新再看");
  const same = sameDecision(ctx.doc, type, (d) => d.sha256 === f.sha256 && d.note === note);
  const shas = Array.isArray(ctx.params.cover_shas) ? ctx.params.cover_shas.map(String) : f.id ? [f.sha256] : [];
  return { ok: true, decision: same ?? (await push(ctx, { type, ...(f.id ? { fact_id: f.id } : {}), sha256: f.sha256, note, ...(type === "cover_reject" ? { shas } : {}) }, type === "cut_reject" ? "cut_rejected" : "cover_rejected")) };
}

/** 用这一版封面：两个比例都得有（E10），封面字当场要有（E9：没写就用报上来的默认字，都没有就要创始人补） */
async function pickCover(ctx: Ctx): Promise<Result> {
  const a = factBy(ctx.doc, { fact_id: ctx.params.cover_3x4_fact_id, sha256: ctx.params.cover_3x4_sha }, "cover");
  const b = factBy(ctx.doc, { fact_id: ctx.params.cover_4x3_fact_id, sha256: ctx.params.cover_4x3_sha }, "cover");
  if (typeof a === "string" || typeof b === "string") return fail("both_ratios_required", "两个比例（3:4 和 4:3）都选了才能用这一版封面");
  if (a.ratio !== "3:4" || b.ratio !== "4:3" || a.state !== "accepted" || b.state !== "accepted") return fail("both_ratios_required", "要一张 3:4、一张 4:3，且都已确认是这条的封面");
  // 被覆盖过（字节已不是这张）的封面选了也不会生效：直接说，不回「成功」
  if (a.replaced_at || b.replaced_at) return fail("cover_replaced", "这张封面的文件被覆盖过，盘上已经不是这张图了：刷新看现在的封面再选");
  const text = str(ctx.params.cover_text) || a.text || b.text || "";
  if (!text) return fail("cover_text_required", "选封面时要写封面字");
  const bh = bodyHash(ctx.content.body);
  const same = sameDecision(ctx.doc, "cover_approval", (d) => d.cover_3x4_sha === a.sha256 && d.cover_4x3_sha === b.sha256 && d.cover_text === text && d.body_hash === bh
    && validCoverApproval(ctx.doc, ctx.content.body)?.id === d.id);
  return { ok: true, decision: same ?? (await push(ctx, { type: "cover_approval", cover_3x4_sha: a.sha256, cover_4x3_sha: b.sha256, cover_text: text, body_hash: bh }, "cover_picked")) };
}

async function revoke(ctx: Ctx): Promise<Result> {
  const id = str(ctx.params.decision_id);
  const target = ctx.doc.decisions.find((d) => d.id === id && d.round === ctx.doc.round && (d.type === "cut_approval" || d.type === "cover_approval"));
  if (!target) return fail("stale", "要撤的批准不在本轮里，刷新再看");
  const same = sameDecision(ctx.doc, "approval_revoke", (d) => d.target_id === id);
  return { ok: true, decision: same ?? (await push(ctx, { type: "approval_revoke", target_id: id }, "approval_revoked")) };
}

async function candidate(ctx: Ctx, confirm: boolean): Promise<Result> {
  const f = factBy(ctx.doc, ctx.params);
  if (typeof f === "string") return fail("stale", f);
  if (f.state !== "candidate" && f.state !== "pending_match") return { ok: true, fact_id: f.id, state: f.state, note: "这条已经定过了" };
  if (!confirm) return { ok: true, decision: await push(ctx, { type: "candidate_reject", fact_id: f.id, sha256: f.sha256 }, "candidate_rejected", (doc) => { doc.facts.find((x) => x.id === f.id)!.state = "rejected"; }) };
  const adopted = await adoptCandidate(ctx.content, f, ctx.dataDir, { reassign: ctx.params.reassign === true, cancelPending: ctx.params.cancel_pending === true });
  if (!adopted.ok) return adopted;
  return { ...adopted, decision: await push(ctx, { type: "candidate_confirm", fact_id: f.id, sha256: f.sha256 }, "candidate_confirmed") };
}

async function published(ctx: Ctx): Promise<Result> {
  const platform = canonPlatform(str(ctx.params.platform) || ctx.content.platform || "");
  if (!platform) return fail("platform_required", "说一下发在哪个平台");
  const url = str(ctx.params.url);
  if (url && !/^https?:\/\//i.test(url)) return fail("bad_url", "作品链接只接受 http / https 开头的地址");
  // 幂等只对「这个槽现在就是你标的那条」：纠正过之后再点，要落一条新的
  const slot = slotOf(ctx.doc, ctx.doc.round, platform);
  const same = sameDecision(ctx.doc, "i_published", (d) => d.platform === platform && (d.note ?? "") === url);
  if (same && slot?.by === "founder" && slot.fact_id === null) return { ok: true, decision: same };
  // 点「我发了」时盖把关结论：之前有没有这个平台的有效检查（事后补检不改这条）
  // 槽里已经盖过结论（纠正之后的首次）就继承，换成「我发了」翻不了案
  const gate = slotGate(ctx.doc, ctx.doc.round, platform) ?? await gateFromPlan(ctx.content.id, platform, ctx.dataDir);
  return { ok: true, decision: await push(ctx, { type: "i_published", platform, gate, ...(url ? { note: url } : {}) }, isUngated(gate) ? "founder_published_ungated" : "founder_published") };
}

async function confirmReceipt(ctx: Ctx): Promise<Result> {
  const f = factBy(ctx.doc, ctx.params, "publish");
  if (typeof f === "string") return fail("stale", f);
  const same = sameDecision(ctx.doc, "publish_confirm", (d) => d.fact_id === f.id);
  const gate = same ? undefined : slotGate(ctx.doc, f.round, canonPlatform(f.platform ?? "?")) ?? await gateFromPlan(ctx.content.id, canonPlatform(f.platform ?? "?"), ctx.dataDir);
  return { ok: true, decision: same ?? (await push(ctx, { type: "publish_confirm", fact_id: f.id, platform: f.platform, ...(gate ? { gate } : {}) }, "receipt_confirmed")) };
}

/**
 * 纠正发布记录：目标是本轮某个平台的发布槽 `slot:<轮次>:<平台>`（或页面给的那条观察 / 决定 id，按它所在的槽算）。
 * 槽里纠正之前的一切作废；之后新来的照算。槽已经空了再点 = 幂等。
 */
async function correct(ctx: Ctx): Promise<Result> {
  const raw = str(ctx.params.target_id);
  const fact = ctx.doc.facts.find((f) => f.id === raw && f.kind === "publish");
  const dec = ctx.doc.decisions.find((d) => d.id === raw && d.type === "i_published");
  const id = raw.startsWith("slot:") ? normSlotId(raw) : fact ? slotId(fact.round, canonPlatform(fact.platform ?? "?")) : dec ? slotId(dec.round, canonPlatform(dec.platform ?? "?")) : "";
  const m = /^slot:(\d+):(.+)$/.exec(id);
  if (!m || Number(m[1]) !== ctx.doc.round) return fail("stale", "要纠正的发布记录不在这一轮，刷新再看");
  const same = slotOf(ctx.doc, ctx.doc.round, m[2]) ? null : sameDecision(ctx.doc, "publish_correction", (d) => normSlotId(d.target_id ?? "") === id);
  return { ok: true, decision: same ?? (await push(ctx, { type: "publish_correction", target_id: id, ...(str(ctx.params.note) ? { note: str(ctx.params.note) } : {}) }, "publish_corrected")) };
}

/**
 * 卡片挂载 A-roll（§9.1-3）：创始人贴路径 / 选文件 = 决定，直接 accepted 并按 §3-7 落位。
 * 匹配器只做不花钱的那一步：文件名对得上别条在制稿的标题 → 先提醒「更像《X》」，创始人再点一次（confirm_other）才挂。
 */
async function attachAroll(ctx: Ctx): Promise<Result> {
  const input = str(ctx.params.path);
  if (!input) return fail("path_required", "贴一个原片的完整路径");
  const library = readLibraryLocation()?.root;
  const at = await resolveLocalFile(input, "原片", [contentRoot(ctx.content.id, ctx.dataDir), ...(library ? [library] : [])]);
  if (!at.ok) return fail(at.code, at.error);
  const fp = await stableFingerprint(at.value, Date.now());
  if (!fp.ok) return fail(fp.code, fp.error);
  // 与 record 同一套完整性核验（Codex 审 seg3 P2）：读不出时长的不收，不挪、不冻结
  const dur = await checkDuration(at.value, probe);
  if (!dur.ok) return fail(dur.code, dur.error);
  if (ctx.params.confirm_other !== true) {
    const name = path.basename(at.value);
    const other = (await listContents(ctx.dataDir)).find((c) => c.id !== ctx.content.id && isVideoPlatform(c.platform) && !c.deletedAt
      && c.status !== "archived" && exportMatchesTitle(name, c.title) && !exportMatchesTitle(name, ctx.content.title));
    if (other) return { ok: false, code: "looks_like_other", error: `这个视频更像《${other.title}》，确定挂到这条？`, other_id: other.id };
  }
  const existing = ctx.doc.facts.find((f) => f.round === ctx.doc.round && f.kind === "aroll" && f.sha256 === fp.value.sha256);
  if (existing?.state === "accepted") return { ok: true, fact_id: existing.id, state: "accepted", note: "这个原片已经挂过了" };
  const fact = existing ?? (await mutateProduction(ctx.content.id, ctx.dataDir, (doc) => {
    const f: Fact = { id: newId("fact"), kind: "aroll", round: doc.round, state: "candidate", availability: "present", source: "founder", at: new Date().toISOString(),
      path: at.value, sha256: fp.value.sha256, size: fp.value.id.size, mtime_ms: fp.value.id.mtime_ms, evidence: "创始人在卡片上挂载" };
    doc.facts.push(f);
    return { value: f, events: [] };
  })).value;
  const adopted = await adoptCandidate(ctx.content, fact, ctx.dataDir, { reassign: ctx.params.reassign === true, cancelPending: ctx.params.cancel_pending === true });
  if (!adopted.ok) return adopted;
  return { ...adopted, decision: await push(ctx, { type: "candidate_confirm", fact_id: fact.id, sha256: fact.sha256, note: "卡片挂载" }, "aroll_attached") };
}

const HANDLERS: Record<DecisionAction, (ctx: Ctx) => Promise<Result>> = {
  confirm_candidate: (c) => candidate(c, true), reject_candidate: (c) => candidate(c, false),
  approve_cut: approveCut, reject_cut: (c) => rejectWith(c, "cut_reject", "cut"), reject_cover: (c) => rejectWith(c, "cover_reject", "cover"),
  pick_cover: pickCover, revoke_approval: revoke, i_published: published, confirm_receipt: confirmReceipt, correct_publish: correct,
  attach_aroll: attachAroll, waive_sliver: waiveSliver, waive_sliver_check: waiveSliverCheck,
};

/**
 * 创始人决定的唯一入口。`params` 里带了模型标记（_host / _modelCall）一律拒——路由层已只放浏览器会话，这里再挡一道。
 */
export async function founderDecision(contentId: string, action: string, params: Record<string, unknown>, dataDir = getDataDir()): Promise<Result> {
  if (isModelCall(params)) return fail("founder_only", FOUNDER_ONLY);
  if (!DECISION_ACTIONS.includes(action as DecisionAction)) return fail("bad_request", `不认识的决定：${action}`);
  if (!(await isOntologyActive(dataDir, contentId))) return fail("ontology_not_enabled", "本体还没启用（或这条被排除），这个决定还不能在这里做");
  await ensureProductionReady(dataDir);
  return withFileOwnership(async () => {
    const content = await getContent(contentId, dataDir);
    if (!content || content.deletedAt) return fail("not_found", "这条稿不在了");
    const ctx: Ctx = { content, doc: await readProductionDocOrEmpty(contentId, dataDir), dataDir, params };
    const r = await HANDLERS[action as DecisionAction](ctx);
    const commit: CommitResult | null = r.ok ? await commitRegistration(contentId, dataDir) : null;
    const exp = await explainContent((await getContent(contentId, dataDir)) ?? content, dataDir);
    return { ...r, ...(commit && !commit.ok ? { registration_failed: commit.reason } : {}), ...(commit?.ok && commit.registration ? { registration: commit.registration.id } : {}),
      ...(commit?.ok && commit.warnings ? { warnings: commit.warnings } : {}), stage: exp.stage ?? exp.column, missing: exp.missing, badges: exp.badges };
  });
}
