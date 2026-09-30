/**
 * 「等你拍板」的单一决定入口（spec 2026-09-30-review-inbox §3.1，R1 / R2 / R18）。
 *
 * 每个动作都带条目的 `item_id` + 审阅代次 `gen`；服务端在文件归属锁内重新推导这件事、比对代次后消费：
 * - 代次不符 → 「这件事刚变过，重新看一下」，不写；
 * - 同一件事同一代次已被消费：同一决定 → 回放原结果；不同决定 → 拒。
 * 网页的旧决定路由（卡片 / 工作台）也走这里：没带代次时按页面带来的指纹找到对应条目、取它当前的代次；
 * 找不到条目的动作（撤销批准、纠正发布、挂原片…）不在列表里，直接交给创始人决定。
 */
import { getContent, getDataDir, type Content } from "../../storage/local-store.js";
import { newId, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Decision, InboxConsumption } from "../../storage/production-types.js";
import { isModelCall } from "../../storage/stage-guard.js";
import { executeContentSave } from "../../tools/content-save.js";
import { checkInputsNow, executePublishCheck } from "../publish/review-gate/check.js";
import { readCheckRecord } from "../publish/review-gate/check-store.js";
import type { JevCaller } from "../publish/review-gate/jev-client.js";
import type { Override } from "../publish/review-gate/types.js";
import { founderAnswer, undoReportedAnswer } from "./asks.js";
import { DECISION_ACTIONS, FOUNDER_ONLY, founderDecision } from "./decisions.js";
import { scopedId, type InboxAction, type InboxItem } from "./inbox.js";
import { currentChecks, readInbox } from "./inbox-read.js";
import { withFileOwnership } from "./mutex.js";
import { mutateProduction } from "./service.js";
import { canonPlatform } from "./receipts.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const KEEP = 200;
/** 请求里允许改的字段；其余（fact_id / sha / 平台 / 选项…）一律取自条目 */
const EDITABLE = ["note", "cover_text", "url", "to"];
/** 同一决定正在锁外跑时，等它的上限与轮询间隔 */
const WAIT_MS = 10 * 60_000;
const POLL_MS = 50;
export const stalePending = (e: InboxConsumption, now = Date.now()) => Boolean(e.pending) && now - Date.parse(e.at) > WAIT_MS;

export interface DecideDeps { jev?: JevCaller; now?: number }

/** 条目允许的动作（闪帧的「这处是故意的」挂在每一处缝上） */
function allowed(item: InboxItem): InboxAction[] {
  const per = item.type === "sliver" ? (item.detail.items as Array<{ action: InboxAction }>).map((x) => x.action) : [];
  return [...item.actions, ...per];
}

/** 决定的指纹：动作 + 创始人给的参数（不含条目 / 代次本身） */
function fingerprint(action: string, params: Record<string, unknown>): string {
  const keys = Object.keys(params).filter((k) => !["item_id", "gen", "content_id", "action"].includes(k) && !k.startsWith("_")).sort();
  return JSON.stringify([action, keys.map((k) => [k, params[k]])]);
}

async function logOf(contentId: string, dataDir: string): Promise<InboxConsumption[]> {
  return (await readProductionDocOrEmpty(contentId, dataDir)).inbox_log ?? [];
}

async function consume(contentId: string, dataDir: string, entry: InboxConsumption): Promise<void> {
  await mutateProduction(contentId, dataDir, (d) => {
    d.inbox_log = [...(d.inbox_log ?? []), entry].slice(-KEEP);
    return { value: null, events: [{ type: "inbox_decided", detail: { item_id: entry.item_id, action: entry.action } }] };
  });
}

async function pushDecision(contentId: string, dataDir: string, d: Omit<Decision, "id" | "round" | "at" | "source">, event: string): Promise<Decision> {
  return (await mutateProduction(contentId, dataDir, (doc) => {
    const full: Decision = { id: newId("dec"), round: doc.round, at: new Date().toISOString(), source: "founder", ...d };
    doc.decisions.push(full);
    return { value: full, events: [{ type: event, detail: { decision_id: full.id, ...d } }] };
  })).value;
}

// ---- 各类条目的动作 ----

interface Ctx { item: InboxItem; content: Content | null; dataDir: string; params: Record<string, unknown>; spec: InboxAction; deps: DecideDeps }

const noteOf = (ctx: Ctx) => str(ctx.params.note);

async function publishOverride(ctx: Ctx): Promise<Result> {
  const quote = noteOf(ctx);
  if (!quote) return fail("note_required", "写一句你的原话：为什么这次破例");
  const checkId = String(ctx.item.detail.check_id);
  // 破例只作用在创始人看到的那份计划上：输入变了就拒，不在新内容上破例（Codex 审 2a-1 r5 P1）
  if (!(await checkInputsNow(ctx.content!.id, checkId, ctx.dataDir)).same) return fail("plan_changed", "计划刚改过，按新计划重新检查后再看");
  const rec = await readCheckRecord(ctx.content!.id, checkId, ctx.dataDir) as (Record<string, unknown> & { platform?: string; input_at?: string; checked_at?: string; items?: Array<{ result?: string; rule?: string; overridable?: boolean }>;
    inputs?: { plan_source?: string; plan_snapshot?: unknown; founder_quotes?: string[]; overrides?: Override[]; instruction_id?: string | null } }) | null;
  if (!rec) return fail("stale", "这次检查的留档不见了，刷新再看");
  const rules = [...new Set((rec.items ?? []).filter((i) => i.result === "block" && i.overridable && i.rule).map((i) => i.rule!))];
  if (!rules.length) return fail("not_overridable", "这次检查没有能破例的拦截项：只能改计划后重跑");
  const founderOverrides = rules.map((rule) => ({ platform: rec.platform!, rule, founder_quote: quote }));
  const inputs = rec.inputs ?? {};
  const plan = inputs.plan_source === "inline" ? inputs.plan_snapshot : inputs.plan_source || "06-publish/publish-plan.json";
  // 留档不可变：用原来的输入 + 你的原话重跑，得到一次新的检查（新 check_id），不改旧检查
  const r = await executePublishCheck({ _dataDir: ctx.dataDir, content_id: ctx.content!.id, plan, founder_quotes: inputs.founder_quotes ?? [], overrides: inputs.overrides ?? [], ...(inputs.instruction_id ? { instruction_id: inputs.instruction_id } : {}) },
    { ...(ctx.deps.jev ? { jev: ctx.deps.jev } : {}), founderOverrides, rerunOf: checkId, ...(rec.input_at ?? rec.checked_at ? { inputAt: rec.input_at ?? rec.checked_at } : {}) });
  if (r.ok !== true) return fail(String(r.code ?? "check_failed"), `重跑检查没成：${String(r.error ?? "")}`);
  const mine = (r.platforms as Array<{ platform: string; check_id: string; verdict: string }>).find((p) => p.platform === rec.platform);
  return { ok: true, rerun_of: checkId, check_id: mine?.check_id ?? null, verdict: mine?.verdict ?? null, ...(r.semantic ? { semantic: r.semantic } : {}) };
}

async function scriptDecision(ctx: Ctx, approve: boolean): Promise<Result> {
  const c = ctx.content!;
  if (!approve) {
    const note = noteOf(ctx);
    if (!note) return fail("note_required", "写一句要改哪里");
    const d = await pushDecision(c.id, ctx.dataDir, { type: "script_revise", note }, "script_revise_requested");
    const t = await executeContentSave({ _dataDir: ctx.dataDir, action: "transition", id: c.id, target_status: "revision", from_status: "draft_ready", force: true }) as Result;
    return t.ok ? { ok: true, decision: d } : fail("transition_failed", `意见记下了，但稿子没退回修改：${String(t.error ?? "")}`, { decision: d });
  }
  const t = await executeContentSave({ _dataDir: ctx.dataDir, action: "transition", id: c.id, target_status: "approved", from_status: "draft_ready", force: true }) as Result;
  return t.ok ? { ok: true, status: "approved" } : fail("transition_failed", String(t.error ?? "认稿没成"));
}

async function run(ctx: Ctx): Promise<Result> {
  const { item, dataDir, params, spec } = ctx;
  const c = ctx.content;
  // 对象身份只取自条目（Codex 审 2a-1 r2 P2）：请求只能改可编辑的字段（一句话、封面字、链接、指定给哪条）；
  // 挑哪一版 / 哪一组要在这个条目自己的清单里，下面逐个核
  const merged: Record<string, unknown> = { ...spec.params, ...Object.fromEntries(EDITABLE.filter((k) => params[k] !== undefined).map((k) => [k, params[k]])) };
  const chosenVersion = () => {
    // 闪帧条目只绑它自己那一版成片（Codex 审 2a-1 r5 P2）
    if (item.type === "sliver") return params.fact_id === undefined || params.fact_id === item.detail.cut_fact_id ? { fact_id: item.detail.cut_fact_id, sha256: item.detail.cut_sha } : null;
    if (params.fact_id === undefined) return spec.params?.fact_id ? { fact_id: spec.params.fact_id, sha256: spec.params.sha256 } : null;
    const v = ((item.detail.versions as Array<{ fact_id: string; sha256: string }> | undefined) ?? []).find((x) => x.fact_id === params.fact_id);
    return v ? { fact_id: v.fact_id, sha256: v.sha256 } : null;
  };
  const chosenGroup = () => {
    const id = params.group_id ?? spec.params?.group_id;
    return ((item.detail.groups as Array<{ group_id: string }> | undefined) ?? []).some((g) => g.group_id === id) ? String(id) : null;
  };
  switch (spec.action) {
    case "answer_ask": return founderAnswer(c!, dataDir, String(spec.params!.ask_id), String(spec.params!.option_id), noteOf(ctx));
    case "undo_ask_answer": return undoReportedAnswer(c!, dataDir, String(spec.params!.ask_id), ctx.deps.now);
    case "ack": return { ok: true, decision: await pushDecision(c!.id, dataDir, { type: "inbox_ack", item_id: item.item_id }, "inbox_acked") };
    case "nudge": return { ok: true, decision: await pushDecision(c!.id, dataDir, { type: "inbox_ack", item_id: item.item_id, note: `创始人让你补：${String(item.detail.reason ?? "")}` }, "founder_nudged") };
    case "publish_check_confirm": return { ok: true, decision: await pushDecision(c!.id, dataDir, { type: "publish_check_confirm", check_id: String(item.detail.check_id), platform: String(item.detail.platform) }, "publish_check_confirmed") };
    case "publish_check_revise": {
      if (!noteOf(ctx)) return fail("note_required", "写一句哪几处要改");
      return { ok: true, decision: await pushDecision(c!.id, dataDir, { type: "publish_check_revise", check_id: String(item.detail.check_id), platform: String(item.detail.platform), note: noteOf(ctx) }, "publish_check_revise") };
    }
    case "publish_check_override": return publishOverride(ctx);
    case "approve_script": return scriptDecision(ctx, true);
    case "revise_script": return scriptDecision(ctx, false);
    case "assign": {
      const to = str(params.to);
      if (!to) return fail("bad_request", "选一条稿：指定给哪条");
      // 路径只取服务端给这个条目的动作参数，不从页面取（整分支审 P2）
      return founderDecision(to, "attach_aroll", { path: spec.params?.path, confirm_other: true }, dataDir);
    }
    case "reject_cut": {
      const v = chosenVersion();
      if (!v) return fail("stale", "这一版不在这件事的成片清单里，刷新再看");
      return founderDecision(c!.id, "reject_cut", { ...v, note: noteOf(ctx) || (item.type === "sliver" ? "画面有闪帧，去剪辑里改" : "") }, dataDir);
    }
    case "retire_cover_group": {
      const g = chosenGroup();
      if (!g) return fail("stale", "这组不在这件事的封面清单里，刷新再看");
      return founderDecision(c!.id, "retire_cover_group", { group_id: g }, dataDir);
    }
    case "reject_cover": {
      // 只打回面板上还没定的那几组：已批的那组不跟着失效
      const groups = (item.detail.groups as Array<{ group_id: string; approved: boolean; "3:4": { sha256: string } | null; "4:3": { sha256: string } | null }>).filter((g) => !g.approved);
      const shas = groups.flatMap((g) => [g["3:4"]?.sha256, g["4:3"]?.sha256]).filter((x): x is string => Boolean(x));
      // 打回绑组身份（group_ids）：只作废这几组，不按共用的图牵连已批的组
      return founderDecision(c!.id, "reject_cover", { sha256: `inbox:${item.gen}`, cover_shas: shas, group_ids: groups.map((g) => g.group_id), note: noteOf(ctx) }, dataDir);
    }
    case "approve_cut": {
      const pick = chosenVersion();
      if (!pick) return fail("stale", "这一版不在本轮的成片里，刷新再看");
      return founderDecision(c!.id, "approve_cut", { fact_id: pick.fact_id, sha256: pick.sha256 }, dataDir);
    }
    case "pick_cover": {
      const g = chosenGroup();
      if (!g) return fail("stale", "这组不在面板上了，刷新再看");
      return founderDecision(c!.id, "pick_cover", { group_id: g, ...(str(merged.cover_text) ? { cover_text: str(merged.cover_text) } : {}) }, dataDir);
    }
    case "i_published": return founderDecision(c!.id, "i_published", { platform: spec.params!.platform, ...(noteOf(ctx) ? { url: noteOf(ctx) } : str(params.url) ? { url: str(params.url) } : {}) }, dataDir);
    default:
      if ((DECISION_ACTIONS as readonly string[]).includes(spec.action)) return founderDecision(c!.id, spec.action, merged, dataDir);
      return fail("bad_request", `不认识的动作：${spec.action}`);
  }
}

/** 这件事在哪条稿上记消费（收件箱里的视频记在被指定的那条） */
const logContentOf = (item: InboxItem, params: Record<string, unknown>) => item.content_id ?? (str(params.to) || null);

/** 带代次的决定（R1 / R2）：锁内推导、比对、消费 */
export async function decideItem(req: Record<string, unknown>, dataDir = getDataDir(), deps: DecideDeps = {}): Promise<Result> {
  if (isModelCall(req)) return fail("founder_only", FOUNDER_ONLY);
  const itemId = str(req.item_id), gen = str(req.gen), action = str(req.action), contentId = str(req.content_id);
  if (!itemId || !gen || !action) return fail("bad_request", "要带 item_id、gen 和 action（刷新再点）");
  const fp = fingerprint(action, req);
  const locked = () => withFileOwnership(async () => {
    const view = await readInbox(dataDir, { ...(contentId ? { contentId } : {}), ...(deps.now ? { now: deps.now } : {}) });
    const item = view.items.find((x) => x.item_id === itemId);
    const logId = item ? logContentOf(item, req) : contentId || str(req.to) || null;
    // 占位超过等待上限（服务中途重启、没落定）算作废，不永久卡住这件事
    const prior = logId ? (await logOf(logId, dataDir)).find((e) => e.item_id === itemId && e.gen === gen && !stalePending(e)) : undefined;
    if (prior && (prior.fp !== fp || prior.action !== action)) return { phase: "done" as const, result: fail("already_decided", prior.pending ? "这件事正在别处处理（做的是另一个决定），刷新看现在的样子" : "这件事已经在别处处理过了（做的是另一个决定），刷新看现在的样子") };
    // 同一个决定正在锁外跑：等它的结果回放，不再跑一遍
    if (prior?.pending) return { phase: "wait" as const };
    if (prior) return { phase: "done" as const, result: { ...prior.result, replayed: true } };
    if (!item) return { phase: "done" as const, result: fail("gone", "这件事已在别处处理，或已经关了：刷新再看") };
    if (item.gen !== gen) return { phase: "done" as const, result: fail("stale", "这件事刚变过，重新看一下") };
    // 同一动作可能有几个（每个选项、每一处缝）：选项 / 缝必须和请求一致，不许落到第一个
    const chosen = allowed(item).filter((a) => a.action === action).find((a) => ["option_id", "sliver_key"].every((k) => a.params?.[k] === undefined || a.params[k] === req[k]));
    if (!chosen) return { phase: "done" as const, result: fail("bad_request", "这件事没有这个动作") };
    if (chosen.note === "required" && !str(req.note)) return { phase: "done" as const, result: fail("note_required", "写一句话再发") };
    const content = item.content_id ? await getContent(item.content_id, dataDir) : null;
    const ctx: Ctx = { item, content, dataDir, params: req, spec: chosen, deps };
    // 破例重跑要调外部模型：不占着锁跑，跑完回锁里再核一次代次
    // 离开锁之前先把这一代占住（持久记录，带动作与指纹）：相反的决定拒、同样的请求等结果回放（Codex 审 2a-1 P2）
    if (chosen.action === "publish_check_override") {
      if (!logId) return { phase: "done" as const, result: fail("bad_request", "这件事没有可记的稿") };
      await consume(logId, dataDir, { item_id: itemId, gen, action, fp, at: new Date().toISOString(), result: {}, pending: true });
      return { phase: "outside" as const, ctx, logId };
    }
    const result = await run(ctx);
    if (result.ok === true && logId) await consume(logId, dataDir, { item_id: itemId, gen, action, fp, at: new Date().toISOString(), result: slim(result) });
    return { phase: "done" as const, result };
  });
  let first = await locked();
  for (let waited = 0; first.phase === "wait" && waited < WAIT_MS; waited += POLL_MS) {
    await new Promise((ok) => setTimeout(ok, POLL_MS));
    first = await locked();
  }
  if (first.phase === "wait") return fail("in_progress", "这件事还在处理（在等模型），过一会儿刷新再看", { item_id: itemId, gen });
  if (first.phase === "done") return { ...first.result, item_id: itemId, gen };
  const { ctx, logId } = first;
  let result: Result;
  try { result = await run(ctx); } catch (e) { result = fail("failed", `没做成：${e instanceof Error ? e.message : String(e)}`); }
  // 回锁里落定：成功 → 占位换成结果；失败 → 释放占位（看得见原因，之后能再点）
  await withFileOwnership(async () => {
    // 等模型期间来了新计划的检查：这次重跑留档但不算当前（输入代次排在后面），告诉创始人按新计划重看（Codex 审 2a-1 r3 P2）
    if (result.ok === true && result.check_id) {
      const content = await getContent(ctx.content!.id, dataDir);
      const current = content ? (await currentChecks(content, await readProductionDocOrEmpty(content.id, dataDir), dataDir)).find((x) => x.platform === ctx.item.detail.platform) : null;
      if (current?.check_id !== result.check_id) result = fail("plan_changed", "这期间计划变了，按新计划重新看一眼", { superseded_check_id: result.check_id, current_check_id: current?.check_id ?? null });
    }
    await mutateProduction(logId!, dataDir, (d) => {
    const log = (d.inbox_log ?? []).filter((e) => !(e.item_id === itemId && e.gen === gen && e.pending));
    d.inbox_log = result.ok === true ? [...log, { item_id: itemId, gen, action, fp, at: new Date().toISOString(), result: slim(result) }].slice(-KEEP) : log;
    return { value: null, events: [{ type: result.ok === true ? "inbox_decided" : "inbox_decide_failed", detail: { item_id: itemId, action, ...(result.ok === true ? {} : { error: result.error }) } }] };
    });
  });
  return { ...result, item_id: itemId, gen };
}

/** 消费记录只留回放要的：别把整份回执塞进制作记录 */
function slim(r: Result): Result {
  const keep = ["ok", "decision", "stage", "missing", "registration", "registration_failed", "check_id", "rerun_of", "verdict", "status", "storyboard_approved", "group_id"];
  return Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k)));
}

// ---- 旧路由（卡片 / 工作台）：按页面带来的指纹找条目 ----

function legacyMatch(item: InboxItem, action: string, p: Record<string, unknown>): boolean {
  const d = item.detail;
  switch (action) {
    case "approve_cut": case "reject_cut":
      return (item.type === "cut_review" && (d.versions as Array<{ fact_id: string }>).some((v) => v.fact_id === p.fact_id));
    case "pick_cover": return item.type === "cover_pick" && (d.groups as Array<{ group_id: string; "3:4": { fact_id: string } | null; "4:3": { fact_id: string } | null }>)
      .some((g) => g.group_id === p.group_id || (g["3:4"]?.fact_id === p.cover_3x4_fact_id && g["4:3"]?.fact_id === p.cover_4x3_fact_id));
    case "confirm_candidate": case "reject_candidate": return item.type === "candidate" && d.fact_id === p.fact_id;
    case "undo_auto_attach": return item.type === "auto_attached" && d.fact_id === p.fact_id;
    case "keep_attach": case "reassign_aroll": return item.type === "attach_check" && d.fact_id === p.fact_id;
    case "waive_sliver": case "waive_sliver_check": return item.type === "sliver" && d.cut_sha === p.cut_sha;
    case "i_published": return item.type === "published_ask" && d.platform === p.platform;
    case "confirm_receipt": return item.type === "publish_claim" && item.actions[0].params?.fact_id === p.fact_id;
    default: return false;
  }
}

/**
 * 列表里的那类事（Codex 审 2a-1 r7 P1）：没有条目时不能直接落到创始人决定——它可能刚被消费（打回之后旧页面又点通过）。
 * 找这件事的消费记录：相反的决定拒，同样的回放，都没有 = 刚变过。只有本来就不在列表里的动作（撤销批准、纠正发布、
 * 挂原片、重开…）直接交给创始人决定；「我发了」在卡片上对任何平台都能点，没有记录时照旧放行。
 */
const INBOX_ACTIONS: ReadonlySet<string> = new Set(["approve_cut", "reject_cut", "pick_cover", "reject_cover", "retire_cover_group", "confirm_candidate", "reject_candidate",
  "undo_auto_attach", "keep_attach", "reassign_aroll", "waive_sliver", "waive_sliver_check", "confirm_receipt", "i_published", "approve_script", "revise_script", "answer_ask", "publish_check_confirm"]);
const PASS_WITHOUT_RECORD: ReadonlySet<string> = new Set(["i_published"]);
const OBJ_KEYS = ["fact_id", "group_id", "cover_3x4_fact_id", "cover_4x3_fact_id", "platform", "option_id", "cut_sha", "sliver_key", "check_id", "ask_id"];

async function objectItemIds(contentId: string, action: string, p: Record<string, unknown>, dataDir: string): Promise<string[]> {
  return (await localItemIds(contentId, action, p, dataDir)).map((id) => scopedId(contentId, id));
}

async function localItemIds(contentId: string, action: string, p: Record<string, unknown>, dataDir: string): Promise<string[]> {
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const r = doc.round;
  const factBySha = (sha: unknown) => doc.facts.find((f) => f.sha256 === sha && f.kind === "cut" && f.round === r)?.id;
  switch (action) {
    case "approve_cut": case "reject_cut": return [`cut:r${r}`, `sliver:${String(p.fact_id)}`];
    case "pick_cover": case "reject_cover": case "retire_cover_group": return [`cover:r${r}`];
    case "confirm_candidate": case "reject_candidate": return [`cand:${String(p.fact_id)}`];
    case "undo_auto_attach": return [`auto:${String(p.fact_id)}`];
    case "keep_attach": case "reassign_aroll": return [`attach:${String(p.fact_id)}`];
    case "waive_sliver": case "waive_sliver_check": return [`sliver:${String(factBySha(p.cut_sha))}`];
    case "confirm_receipt": {
      const f = doc.facts.find((x) => x.id === p.fact_id);
      return f?.platform ? [`claim:r${r}:${canonPlatform(f.platform)}`] : [];
    }
    case "i_published": return p.platform ? [`published:r${r}:${canonPlatform(String(p.platform))}`, `claim:r${r}:${canonPlatform(String(p.platform))}`] : [];
    case "approve_script": case "revise_script": return [`draft:${contentId}`];
    case "answer_ask": return [`ask:${String(p.ask_id)}`];
    default: return [];
  }
}

async function legacyWithoutItem(contentId: string, action: string, params: Record<string, unknown>, dataDir: string): Promise<Result> {
  if (!INBOX_ACTIONS.has(action)) return founderDecision(contentId, action, params, dataDir);
  const ids = await objectItemIds(contentId, action, params, dataDir);
  const last = (await logOf(contentId, dataDir)).filter((e) => ids.includes(e.item_id) && !e.pending).at(-1);
  if (last) {
    const logged = (JSON.parse(last.fp) as [string, Array<[string, unknown]>])[1];
    const key = (pairs: Array<[string, unknown]>) => JSON.stringify(pairs.filter(([k]) => OBJ_KEYS.includes(k)).map(([k, v]) => [k, String(v)]).sort());
    const mine = key(Object.entries(params));
    const same = last.action === action && (key(logged) === "[]" || mine === "[]" || key(logged) === mine);
    return same ? { ...last.result, replayed: true, item_id: last.item_id, gen: last.gen } : fail("already_decided", "这件事已经在别处定了，刷新再看", { item_id: last.item_id });
  }
  if (PASS_WITHOUT_RECORD.has(action)) return founderDecision(contentId, action, params, dataDir);
  return fail("stale", "这件事刚变过（列表里已经没有它了），刷新再看");
}

/**
 * 网页决定的唯一入口：带 item_id + gen → 走 CAS；旧页面（没带代次）→ 按指纹找到条目、用它当前的代次走同一个 CAS；
 * 不在列表里的动作（撤销批准、纠正已发布、挂原片…）直接交给创始人决定。
 */
export async function decide(contentId: string, action: string, params: Record<string, unknown>, dataDir = getDataDir(), deps: DecideDeps = {}): Promise<Result> {
  if (isModelCall(params)) return fail("founder_only", FOUNDER_ONLY);
  if (str(params.item_id)) return decideItem({ ...params, action, content_id: contentId }, dataDir, deps);
  const view = await readInbox(dataDir, { contentId });
  const item = view.items.find((x) => legacyMatch(x, action, params));
  if (!item) return legacyWithoutItem(contentId, action, params, dataDir);
  // 旧页面：按它带来的具体对象选动作参数（哪一版 / 哪一组 / 哪一处）
  // 选封面：按 3:4 + 4:3 两张一起认组，恰好一组对得上才行；不按单张取最新一组（Codex 审 2a-1 r3 P1）
  let pinned: Record<string, unknown> = {};
  if (action === "pick_cover" && !params.group_id) {
    const exact = (item.detail.groups as Array<{ group_id: string; "3:4": { fact_id: string } | null; "4:3": { fact_id: string } | null }>)
      .filter((g) => g["3:4"]?.fact_id === params.cover_3x4_fact_id && g["4:3"]?.fact_id === params.cover_4x3_fact_id);
    if (exact.length !== 1) return fail("stale", "这件事刚变过（这两张对不上唯一的一组），重新看一下");
    pinned = { group_id: exact[0].group_id };
  }
  return decideItem({ ...params, ...pinned, action, content_id: contentId, item_id: item.item_id, gen: item.gen }, dataDir, deps);
}
