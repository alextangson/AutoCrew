/**
 * 标题方法库的留 / 删 / 改走同一道升级门（规格 §四末段；原 ② 规则）。
 * 入口：autocrew_insights calib_bump{target:"title_library", op}
 *   propose：完整新库组成 + kind + rationale。试用期没到终版（8 条）或剔完待复核/单样本方法后不够 8 条 → 只能是「判断」，不改库；
 *            终版：留一均值回测 → 排序门（rank-gate）→ 跨模型审计 C（audit），两个都过才标「已验证」。
 *   apply：只收「已验证」的提议，且方法库自提议后没变；要创始人确认（confirm:true）。改动追加进 rubric-memo，被删方法留墓碑。
 *   revert：撤销一次改动（追加 title_revert），要创始人确认 + 原话 reason。
 *   status：当前生效库、墓碑、试用期统计、最近的提议。
 */
import crypto from "node:crypto";
import { TITLE_METHODS } from "../writing/title-method-library.js";
import { loadTitlePosts, TRIAL_FINAL, type TitleMethodReport } from "../writing/title-method-stats.js";
import type { runLoop } from "../../engine/loop.js";
import { runAudit, type AuditVerdict } from "./audit.js";
import { observe } from "./observations.js";
import { readObservations, normText } from "./obs-store.js";
import { rankGate, type RankGateResult } from "./rank-gate.js";
import { appendLog, assertLogsIntact, readLog, serializeCalibration } from "./store.js";
import { readTitleLibrary, type TitleLibraryState } from "./title-library.js";
import {
  backtestSamples, eligiblePosts, findOutliers, newLibraryIds, ONE_SAMPLE_NOTE, outlierOnlyMethods, readComposition, remainingCategories,
  type Composition, type Eligibility, type Outlier,
} from "./title-gate.js";

type Obj = Record<string, unknown>;
export type TitleBumpDeps = { auditLoop?: typeof runLoop };
const JUDGMENT_NOTE = "样本少，这是判断不是验证：不改方法库，攒够终版样本再走门";

function readKind(args: Obj): { kind: string; rationale: string } {
  const kind = String(args.kind ?? "");
  if (kind !== "default-aligned" && kind !== "judgment-driven") throw new Error("kind 只能是 default-aligned 或 judgment-driven");
  const rationale = typeof args.rationale === "string" ? args.rationale.trim() : "";
  if (!rationale) throw new Error("rationale 必填：写明为什么留 / 删 / 改");
  return { kind, rationale };
}

/** 单条异常记进观察生命周期（已有同文的活观察或墓碑就不重记） */
async function recordOutliers(outliers: Outlier[], dataDir?: string): Promise<string[]> {
  const ids: string[] = [];
  for (const o of outliers) {
    const text = `标题方法 ${o.method} 有一条稿（${o.id}）点击率 ${o.clickRate.toFixed(2)}%，是基线 ${o.baseline.toFixed(2)}% 的 ${o.ratio} 倍：单条异常只记观察，不改方法库`;
    const { live } = await readObservations(dataDir);
    const same = live.find((x) => normText(x.text) === normText(text));
    if (same) { ids.push(same.id); continue; }
    const r = await observe({ op: "add", text, sample_ids: [o.id], source: "title_trial" }, dataDir);
    if (r.ok) ids.push(String(r.id));
  }
  return ids;
}

/** 为什么只能是「判断」；null = 可以走门 */
function judgmentReason(report: TitleMethodReport, el: Eligibility): string | null {
  if (report.stage !== "final") return `试用期还在${report.stage === "mid" ? "中期" : "起步"}（${report.publishedWithMethod} 条带方法的稿 <${TRIAL_FINAL}）：只能出「判断」`;
  if (el.samples.length >= TRIAL_FINAL) return null;
  const parts = [el.flagged ? `${el.flagged} 条待复核数据` : "", el.noData ? `${el.noData} 条无数据` : "", el.oneSample.length ? `单样本方法 ${el.oneSample.join("、")}` : ""].filter(Boolean);
  return `剔掉${parts.join("、") || "不可用样本"}后只剩 ${el.samples.length} 条可回测（<${TRIAL_FINAL}）：降级为「判断」`;
}

interface Ctx { state: TitleLibraryState; comp: Composition; el: Eligibility; outliers: Outlier[]; observationIds: string[]; base: Obj }

async function judgmentPath(ctx: Ctx, reason: string, kind: string, dataDir?: string): Promise<Obj> {
  const sole = outlierOnlyMethods(ctx.comp, ctx.el.withData, ctx.outliers);
  if (sole.length) return reject({ ...ctx.base, kind: "judgment-driven", label: "判断" }, "outlier_sole_basis", `方法 ${sole.join("、")} 除了单条异常稿没有别的数据：单条异常只能记观察，不能改库`, dataDir);
  const id = `tlp-${crypto.randomUUID().slice(0, 8)}`;
  const forced = kind !== "judgment-driven" ? `提议标的是 ${kind}，没到终版门槛一律按 judgment-driven 处理` : undefined;
  await serializeCalibration(dataDir, () => appendLog("rubric-memo", { type: "title_proposal", id, ...ctx.base, kind: "judgment-driven", label: "判断", reason, applicable: false, at: new Date().toISOString() }, dataDir));
  return { ok: true, proposal_id: id, label: "判断", kind: "judgment-driven", applicable: false, reason, note: JUDGMENT_NOTE, ...(forced ? { forced } : {}), outlier_observations: ctx.observationIds, one_sample: ctx.el.oneSample.map((m) => `${m}：${ONE_SAMPLE_NOTE}`) };
}

async function reject(base: Obj, code: string, reason: string, dataDir?: string, extra: Obj = {}): Promise<Obj> {
  await serializeCalibration(dataDir, () => appendLog("rubric-memo", { type: "title_rejected", ...base, code, reason, ...extra, at: new Date().toISOString() }, dataDir));
  return { ok: false, code, error: `标题方法库改动被拒：${reason}`, ...extra, next_action: "不改库；不许放宽阈值，攒更多样本再提" };
}

function auditPayload(ctx: Ctx, newIds: string[], gate: RankGateResult): string {
  const oldIds = ctx.state.methods.map((m) => m.id);
  const rows = ctx.el.samples.map((p) => ({ id: p.id, title: p.title, method: p.method, click_rate: p.clickRate }));
  return `这次不是改打分公式，而是改标题方法库。预测器：每条稿的分 = 同方法其它稿的平均点击率（留一），方法被删或没有别的稿 = 全库其它稿平均。\n旧库：${oldIds.join("、")}\n新库：${newIds.join("、")}\n改动：${JSON.stringify(ctx.comp)}\n理由：${String(ctx.base.rationale)}\n\n已发布稿（方法、点击率%）：\n${JSON.stringify(rows)}\n\n排序对照：\n${JSON.stringify({ table: gate.table, spearman: gate.spearman, consistency: gate.consistency, regressions: gate.regressions })}`;
}

async function gatedPath(ctx: Ctx, kind: string, dataDir: string | undefined, deps: TitleBumpDeps): Promise<Obj> {
  const newIds = newLibraryIds(ctx.state, ctx.comp);
  const oldIds = ctx.state.methods.map((m) => m.id);
  const gate = rankGate(backtestSamples(ctx.el.samples, oldIds, newIds));
  const base = { ...ctx.base, kind, gate };
  if (!gate.pass) return reject(base, "gate_failed", gate.reasons.join("；"), dataDir, { step: 3, gate });
  const bad = new Set(ctx.outliers.map((o) => o.id));
  if (ctx.el.samples.some((p) => bad.has(p.id))) {
    const rest = ctx.el.samples.filter((p) => !bad.has(p.id));
    const without = rankGate(backtestSamples(rest, oldIds, newIds));
    if (rest.length < TRIAL_FINAL || !without.pass) {
      return reject(base, "outlier_sole_basis", `去掉单条异常稿后${rest.length < TRIAL_FINAL ? `只剩 ${rest.length} 条` : `门不过（${without.reasons.join("；")}）`}：单条异常不能撑起改库`, dataDir, { step: 3, gate_without_outliers: without });
    }
  }
  const audit: AuditVerdict = await runAudit(auditPayload(ctx, newIds, gate), dataDir, { runLoopImpl: deps.auditLoop });
  if (audit.verdict !== "PASS") return reject(base, "audit_rejected", audit.verdict === "REJECT" ? "本地 PASS + 审计 REJECT，视为 REJECT" : audit.reason, dataDir, { step: 4, audit });
  const id = `tlp-${crypto.randomUUID().slice(0, 8)}`;
  await serializeCalibration(dataDir, () => appendLog("rubric-memo", { type: "title_proposal", id, ...base, audit, label: "已验证", applicable: true, at: new Date().toISOString() }, dataDir));
  return { ok: true, proposal_id: id, label: "已验证", kind, applicable: true, gate, audit, outlier_observations: ctx.observationIds, one_sample: ctx.el.oneSample.map((m) => `${m}：${ONE_SAMPLE_NOTE}`),
    next_action: `摆给创始人看；他确认后调 calib_bump{target:"title_library", op:"apply", proposal_id:"${id}", confirm:true} 落库` };
}

export async function proposeTitleChange(args: Obj, dataDir?: string, deps: TitleBumpDeps = {}): Promise<Obj> {
  await assertLogsIntact(["rubric-memo"], dataDir);
  if (args.threshold !== undefined) return { ok: false, code: "bump_not_allowed", error: "THRESHOLD 写死 80%，不收参数" };
  const { kind, rationale } = readKind(args);
  const state = await readTitleLibrary(dataDir);
  const comp = readComposition(args.composition, state, args.new_evidence);
  if (remainingCategories(state.methods, [...TITLE_METHODS], comp) < 3) return { ok: false, code: "library_too_small", error: "改完剩下的方法不到 3 个类：标题候选要分属 3 个不同类" };
  const { report, posts } = await loadTitlePosts(dataDir);
  const el = eligiblePosts(posts, [...state.methods.map((m) => m.id), ...comp.restore]);
  const outliers = findOutliers(el.withData);
  const observationIds = await recordOutliers(outliers, dataDir);
  const base = { composition: comp, rationale, ...(args.new_evidence ? { new_evidence: String(args.new_evidence) } : {}), library_version: state.version, stage: report.stage, sample_ids: el.samples.map((p) => p.id), outliers };
  const ctx: Ctx = { state, comp, el, outliers, observationIds, base };
  const reason = judgmentReason(report, el);
  return reason ? judgmentPath(ctx, reason, kind, dataDir) : gatedPath(ctx, kind, dataDir, deps);
}

async function memoRecords(dataDir?: string) {
  return (await readLog("rubric-memo", dataDir)).records;
}

async function applyTitleChange(args: Obj, dataDir?: string): Promise<Obj> {
  if (args.confirm !== true) return { ok: false, code: "needs_confirmation", error: "落库前先把提议摆给创始人，他确认后带 confirm:true" };
  return serializeCalibration(dataDir, async () => {
    await assertLogsIntact(["rubric-memo"], dataDir);
    const records = await memoRecords(dataDir);
    const p = records.find((r) => r.type === "title_proposal" && r.id === args.proposal_id);
    if (!p) return { ok: false, code: "not_found", error: `提议 ${String(args.proposal_id)} 不存在` };
    if (p.label !== "已验证") return { ok: false, code: "not_verified", error: "这条提议是「判断」，不能改库：攒够终版样本再走门" };
    if (records.some((r) => r.type === "title_change" && r.proposal_id === p.id)) return { ok: false, code: "already_applied", error: "这条提议已经落过库" };
    const state = await readTitleLibrary(dataDir);
    if (state.version !== p.library_version) return { ok: false, code: "stale", error: "提议之后方法库已经变过：重新提议、重新过门" };
    const comp = p.composition as Composition;
    const change = { type: "title_change", id: `tlc-${crypto.randomUUID().slice(0, 8)}`, proposal_id: p.id, removed: comp.remove, changed: comp.change, restored: comp.restore, at: new Date().toISOString() };
    await appendLog("rubric-memo", change, dataDir);
    const after = await readTitleLibrary(dataDir);
    return { ok: true, change_id: change.id, methods: after.methods.map((m) => m.id), tombstones: after.tombstones, note: "改动已记进 rubric-memo；要撤销用 op:revert" };
  });
}

async function revertTitleChange(args: Obj, dataDir?: string): Promise<Obj> {
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (args.confirm !== true || !reason) return { ok: false, code: "needs_confirmation", error: "撤销要创始人确认：带 confirm:true 和他的原话 reason" };
  return serializeCalibration(dataDir, async () => {
    await assertLogsIntact(["rubric-memo"], dataDir);
    const state = await readTitleLibrary(dataDir);
    if (!state.applied.some((c) => c.id === args.change_id)) return { ok: false, code: "not_found", error: `改动 ${String(args.change_id)} 不在生效中（不存在或已撤销）` };
    await appendLog("rubric-memo", { type: "title_revert", change_id: String(args.change_id), reason, at: new Date().toISOString() }, dataDir);
    return { ok: true, reverted: args.change_id, methods: (await readTitleLibrary(dataDir)).methods.map((m) => m.id) };
  });
}

async function titleStatus(dataDir?: string): Promise<Obj> {
  const state = await readTitleLibrary(dataDir);
  const { report } = await loadTitlePosts(dataDir);
  const proposals = (await memoRecords(dataDir)).filter((r) => r.type === "title_proposal" || r.type === "title_rejected").slice(-5)
    .map((r) => ({ type: r.type, id: r.id, label: r.label, code: r.code, reason: r.reason, at: r.at }));
  return { ok: true, methods: state.methods.map((m) => m.id), tombstones: state.tombstones, applied: state.applied, trial_report: report, recent: proposals };
}

export async function titleLibraryAction(args: Obj, dataDir?: string, deps: TitleBumpDeps = {}): Promise<Obj> {
  const op = String(args.op ?? "status");
  if (op === "propose") return proposeTitleChange(args, dataDir, deps);
  if (op === "apply") return applyTitleChange(args, dataDir);
  if (op === "revert") return revertTitleChange(args, dataDir);
  if (op === "status") return titleStatus(dataDir);
  throw new Error("target:title_library 的 op 只能是 propose / apply / revert / status");
}
