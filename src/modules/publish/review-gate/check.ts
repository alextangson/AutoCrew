/**
 * `autocrew_publish action=check`（发布前把关 spec §2）：平台集合与归属 → 确定性检查 → Jev A → Jev B → 按平台汇总。
 *
 * 只写检查留档（`06-publish/checks/`）与 Jev 缓存，不改任何业务状态；不调旧预检执行器（它会推进状态）。
 * 每平台单独判（E1），一个被拦不影响其他。
 *
 * §11 集成：`verifyCheck` 供 `ego_lite_prepare` 按平台出包前核检查仍有效（ego-lite.prepareCheckedPublish）；
 * 发布回执引用 check_id、「发布前未把关」与「发布前例外」在本体发布槽里做（production/publish-check-link.ts）。
 */
import path from "node:path";
import { commitSha, STILL_SETTLING } from "../../production/hash-cache.js";
import { getContent, getDataDir, type Content } from "../../../storage/local-store.js";
import { contentRoot } from "../../../storage/content-project.js";
import { registeredPackage } from "../../production/publish-gate.js";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import { COVER_CROP_CHECKS, effectiveCoverRatios } from "../../cover/platform-ratios.js";
import { applyOverrides, deterministicChecks, type CoverFact, type RegistrationState } from "./deterministic.js";
import { makeJevCaller, JEV_MODEL, type JevCaller } from "./jev-client.js";
import { fingerprint, payloadHash, QUESTION_SET_VERSION, textSha } from "./identity.js";
import { readInstruction, splitInstruction, type StoredInstruction } from "./instructions.js";
import { readOverrides, readQuotes } from "./inputs.js";
import { loadPlan, missingAsNull, parsePlan, resolveInProject, type ParsedPlan, type PlanEntry } from "./plan.js";
import { platformLabel, platformsNamedIn, type GatePlatform } from "./platforms.js";
import { prefsVersion, readPublishPrefs, type PublishPrefs } from "./preferences.js";
import { buildA, buildB, type BEntryView, type Instruction } from "./semantic.js";
import { runSemantic, type CallRecord } from "./semantic-run.js";
import { loadBasis, type Basis } from "./subtitles.js";
import { newCheckId, readCheckRecord, writeCheckRecord } from "./check-store.js";
import { summaryMarkdown, summaryRows } from "./summary.js";
import { platformVerdict, type CheckItem, type Override, type SummaryRow, type Verdict } from "./types.js";

/**
 * overrideSource：创始人在「等你拍板」里亲手写的破例（review-inbox §7-6）→ 重跑出新的检查，
 * 留档里例外标 source=founder、rerun_of=原检查；不在旧检查上改。只能由服务端调用方给，模型传不进来。
 */
export interface CheckDeps { jev?: JevCaller; founderOverrides?: Override[]; rerunOf?: string;
  /** 输入代次（review-inbox §7-4）：检查开始读输入的时间；破例重跑沿用原检查的，所以晚完成的重跑排不到新计划的检查前面 */
  inputAt?: string }

interface Ctx {
  content: Content; dataDir: string; root: string; quotes: string[]; overrides: Override[];
  instruction: StoredInstruction | null; plan: ParsedPlan; planSource: string; planRaw: Record<string, unknown>; prefs: PublishPrefs;
  registration: RegistrationState; basis: () => Promise<Basis>; caller: JevCaller;
  /** 启动检查时的制作轮次（review-inbox §7-4：检查绑轮次 / 平台 / 输入指纹） */
  round: number; deps: CheckDeps;
  /** 发布时（执行检查 / 出包前核检查）：计划里每个要进发布包的文件都现算，不信元数据缓存 */
  fresh: boolean;
}

interface Detail { result: PlatformResult; covers: CoverFact[]; account: string | null }

export interface PlatformResult {
  platform: string; verdict: Verdict; check_id: string; payload_hash: string | null; fingerprint: string | null;
  items: CheckItem[]; semantic: { cached: boolean; calls: number; failed: string[] };
}

type Fail = { ok: false; code: string; error: string };

async function registrationState(content: Content, dataDir: string, fresh: boolean): Promise<RegistrationState> {
  const g = await registeredPackage(content, dataDir, { fresh });
  if (!g) return { kind: "none", reason: "这条没按内容本体登记（旧流程或非视频稿），没有登记记录可比" };
  if (!g.ok) return { kind: "blocked", error: g.error };
  return { kind: "ok", registration: g.files.registration, srt: g.files.srt };
}

/** fresh：真要发 / 出包前现算登记文件的字节；只是看检查还新不新鲜的读路径走缓存 */
async function buildCtx(params: Record<string, unknown>, deps: CheckDeps, fresh = false): Promise<Ctx | Fail> {
  const startedAt = new Date().toISOString();
  const dataDir = getDataDir((params._dataDir as string) || undefined);
  const id = typeof params.content_id === "string" ? params.content_id.trim() : "";
  if (!id) return { ok: false, code: "missing_content_id", error: "content_id 必填" };
  const content = await getContent(id, dataDir).catch(missingAsNull);
  if (!content) return { ok: false, code: "not_found", error: `内容不在 AutoCrew 里：${id}。按技能说明在最终点击前停下来问创始人，明确说「这次不检查直接发」才继续` };
  const quotes = readQuotes(params.founder_quotes);
  if (!quotes.ok) return quotes;
  const overrides = readOverrides(params.overrides);
  if (!overrides.ok) return overrides;
  let instruction: StoredInstruction | null = null;
  if (typeof params.instruction_id === "string" && params.instruction_id.trim()) {
    const r = await readInstruction(id, params.instruction_id.trim(), dataDir);
    if (!r.ok) return r;
    instruction = r.instruction;
  }
  const root = contentRoot(id, dataDir);
  const loaded = await loadPlan(params.plan, root);
  if (!loaded.ok) return loaded;
  const registration = await registrationState(content, dataDir, fresh);
  let basis: Promise<Basis> | null = null;
  return {
    content, dataDir, root, quotes: quotes.value, overrides: [...overrides.value, ...(deps.founderOverrides ?? [])], instruction, plan: parsePlan(loaded.plan), planSource: loaded.source, planRaw: loaded.plan,
    prefs: await readPublishPrefs(dataDir), registration, caller: deps.jev ?? makeJevCaller(),
    basis: () => (basis ??= loadBasis(registration.kind === "ok" ? registration.srt : null, content.body ?? "")),
    round: (await readProductionDocOrEmpty(id, dataDir).catch(() => null))?.round ?? 1, deps: { ...deps, inputAt: deps.inputAt ?? startedAt }, fresh,
  };
}

function allInstructions(ctx: Ctx, platform: string): Instruction[] {
  const list: Instruction[] = [];
  for (const q of ctx.quotes) list.push({ n: list.length + 1, source: "原话", text: q });
  for (const s of ctx.instruction ? splitInstruction(ctx.instruction.text) : []) list.push({ n: list.length + 1, source: "网页指令", text: s });
  for (const r of ctx.prefs.publishRules.filter((x) => !x.platform || x.platform === platform)) list.push({ n: list.length + 1, source: "发布规则", text: r.text });
  return list;
}

/** 点名了具体平台、但没点这个平台的指令：代码按平台别名表判不适用，不问 Jev（「小红书的标题不要带问号」不问抖音） */
const appliesTo = (ins: Instruction, platform: string) => { const named = platformsNamedIn(ins.text); return !named.length || named.includes(platform as GatePlatform); };

function instructionList(ctx: Ctx, platform: string): Instruction[] {
  return allInstructions(ctx, platform).filter((i) => appliesTo(i, platform));
}

function skippedInstructions(ctx: Ctx, platform: string): CheckItem[] {
  return allInstructions(ctx, platform).filter((i) => !appliesTo(i, platform)).map((i) => ({ check: "B 执行符合指令", result: "info" as const,
    basis: `第 ${i.n} 条（${i.source}）「${i.text}」只点名了${platformsNamedIn(i.text).map(platformLabel).join("、")}，不适用${platformLabel(platform)}` }));
}

function bView(ctx: Ctx, entry: PlanEntry, covers: Awaited<ReturnType<typeof deterministicChecks>>["covers"]): BEntryView {
  const selected = entry.campaigns.filter((c) => c && typeof c === "object" && (c as { selected?: unknown }).selected === true);
  return {
    platform: platformLabel(entry.platform), 平台集合: ctx.plan.entries.map((e) => platformLabel(e.platform)), 账号: entry.account, 标题: entry.title, 文案: entry.caption, 标签: entry.tags,
    封面: covers.map((c) => ({ 用途: c.usage, 比例: c.pixel_ratio, 文件: c.path.split("/").pop() ?? c.path })), 排期: entry.scheduled_at ? `${entry.scheduled_at} ${entry.timezone ?? ""}`.trim() : null, 活动: selected,
  };
}

function shapeItems(ctx: Ctx, platform: string, named: GatePlatform[]): CheckItem[] {
  const items: CheckItem[] = ctx.plan.problems.filter((p) => p.platform === platform)
    .map((p) => ({ check: "计划形状", result: "block" as const, rule: "plan_shape", overridable: false, field: p.field, basis: p.detail }));
  if (named.length && !named.includes(platform as GatePlatform)) items.push({ check: "平台集合", result: "warn", field: "platform", basis: `原话 / 网页指令里没点名${platformLabel(platform)}，计划里多出了这个平台` });
  return items;
}

async function writeRecord(ctx: Ctx, r: PlatformResult, extra: Record<string, unknown>): Promise<void> {
  await writeCheckRecord(ctx.content.id, r.check_id, {
    check_id: r.check_id, content_id: ctx.content.id, platform: r.platform, checked_at: new Date().toISOString(), round: ctx.round, input_at: ctx.deps.inputAt,
    ...(ctx.deps.rerunOf ? { rerun_of: ctx.deps.rerunOf } : {}),
    inputs: { plan_source: ctx.planSource, ...(ctx.planSource === "inline" ? { plan_snapshot: ctx.planRaw } : {}), founder_quotes: ctx.quotes, instruction_id: ctx.instruction?.id ?? null,
      overrides: ctx.overrides.filter((o) => o.platform === r.platform).map((o) => (ctx.deps.founderOverrides?.some((f) => f.platform === o.platform && f.rule === o.rule && f.founder_quote === o.founder_quote) ? { ...o, source: "founder" } : o)), publish_rules: ctx.prefs.publishRules.filter((x) => !x.platform || x.platform === r.platform) },
    payload_hash: r.payload_hash, fingerprint: r.fingerprint, verdict: r.verdict, items: r.items, plan_problems: planLevelProblems(ctx), ...extra,
  }, ctx.dataDir);
}

/** 归不到具体平台的计划级问题（空条目、没有平台…）：整份计划被拦，任何平台都不能凭这次检查出包 */
function planLevelProblems(ctx: Ctx) {
  return ctx.plan.problems.filter((p) => !p.platform || !ctx.plan.entries.some((e) => e.platform === p.platform));
}

/** 一个平台的检查身份（确定性项 + payload 哈希 + 指纹）：出包前重算它来核对检查没过期，不调 Jev */
async function identityFor(ctx: Ctx, entry: PlanEntry, named: GatePlatform[]) {
  const det = await deterministicChecks({
    contentId: ctx.content.id, siblings: ctx.content.siblings ?? [], projectRoot: ctx.root, entry, videoPath: entry.video_path ?? ctx.plan.final_video_path,
    allowedRatios: effectiveCoverRatios(entry.platform, ctx.prefs.coverRatios), cropChecks: COVER_CROP_CHECKS[entry.platform] ?? [], registration: ctx.registration, fresh: ctx.fresh,
  });
  const detItems = applyOverrides(entry.platform, [...shapeItems(ctx, entry.platform, named), ...det.items], ctx.overrides);
  const payload = payloadHash(entry, ctx.content.id, det.covers, det.video?.sha256 ?? null);
  const instructions = instructionList(ctx, entry.platform);
  const basis = await ctx.basis();
  const reg = ctx.registration.kind === "ok" ? ctx.registration.registration : null;
  const a = buildA({ platform: platformLabel(entry.platform), title: entry.title, caption: entry.caption, scriptTitle: ctx.content.title, basis });
  const mine = ctx.overrides.filter((o) => o.platform === entry.platform);
  const b = buildB(bView(ctx, entry, det.covers), instructions, mine);
  const parts = {
    payload_hash: payload, registration_id: reg?.id ?? null, approval_ids: [reg?.cut_approval_id ?? "", reg?.cover_approval_id ?? ""], prefs_version: prefsVersion(ctx.prefs),
    instruction_id: ctx.instruction?.id ?? null, srt_sha: reg?.srt_sha ?? null, question_set: QUESTION_SET_VERSION, model: JEV_MODEL,
    quotes_sha: textSha(ctx.quotes), overrides_sha: textSha(mine), basis_sha: textSha([basis.text, ctx.content.title, a.request?.state]),
    // Jev 的判定只取决于它收到的 state 与问题：两份请求整体进指纹（活动、平台集合、封面文件名、指令列表都在里面）
    requests_sha: textSha([a.request, b].map((r) => (r ? { state: r.state, questions: r.questions } : null))),
  };
  return { det, detItems, payload, instructions, basis, a, b, parts, fp: fingerprint(parts) };
}

const coverRows = (covers: CoverFact[]) => covers.map((c) => ({ usage: c.usage, ratio: c.pixel_ratio, slot: c.slot, path: c.path, sha256: c.fact.sha256 ?? null }));

async function checkPlatform(ctx: Ctx, entry: PlanEntry, named: GatePlatform[]): Promise<Detail> {
  const { det, detItems, payload, instructions, basis, a, b, parts, fp } = await identityFor(ctx, entry, named);
  const sem = await runSemantic({ contentId: ctx.content.id, dataDir: ctx.dataDir, fingerprint: fp, requests: [a.request, b].filter((x): x is NonNullable<typeof x> => x !== null), basis, instructions, caller: ctx.caller });
  const semItems = [...a.codeItems, ...sem.items, ...skippedInstructions(ctx, entry.platform)];
  if (!instructions.length) semItems.push({ check: "B 执行符合指令", result: "info", basis: "没有可核对的原话 / 规则（不算失败；agent 漏交原话就查不到）" });
  // 同一条问题只列一次（同检查、同规则、同字段、同依据）
  const seen = new Set<string>();
  const items = [...detItems, ...semItems].filter((i) => { const k = JSON.stringify([i.check, i.rule, i.field, i.basis, i.result]); return seen.has(k) ? false : (seen.add(k), true); });
  const result: PlatformResult = { platform: entry.platform, verdict: platformVerdict(items), check_id: newCheckId(entry.platform, fp), payload_hash: payload, fingerprint: fp, items, semantic: { cached: sem.cached, calls: sem.calls.length, failed: sem.failed } };
  await writeRecord(ctx, result, { fingerprint_parts: parts, basis_note: basis.note, covers: coverRows(det.covers), video_sha256: det.video?.sha256 ?? null, jev: { cached: sem.cached, calls: sem.calls satisfies CallRecord[] } });
  return { result, covers: det.covers, account: entry.account };
}

async function missingPlatform(ctx: Ctx, platform: GatePlatform): Promise<Detail> {
  const items = applyOverrides(platform, [{ check: "平台集合", result: "block", rule: "platform_missing", overridable: true, field: "platforms", basis: `原话 / 网页指令点名了${platformLabel(platform)}，计划里没有这个平台` }], ctx.overrides);
  const r: PlatformResult = { platform, verdict: platformVerdict(items), check_id: newCheckId(platform, "missing0"), payload_hash: null, fingerprint: null, items, semantic: { cached: false, calls: 0, failed: [] } };
  await writeRecord(ctx, r, {});
  return { result: r, covers: [], account: null };
}

function namedPlatforms(ctx: Ctx): GatePlatform[] {
  return platformsNamedIn([...ctx.quotes, ctx.instruction?.text ?? ""].join("\n"));
}

function tableOf(ctx: Ctx, details: Detail[]): SummaryRow[] {
  const rows = details.flatMap((d) => summaryRows({ platform: d.result.platform, account: d.account, verdict: d.result.verdict, covers: d.covers, items: d.result.items }));
  for (const p of ctx.plan.problems.filter((x) => !x.platform || !details.some((d) => d.result.platform === x.platform))) {
    rows.push({ 平台: p.platform ?? "计划", 账号: "—", 封面文件: "—", 比例: "—", 用途槽: "—", 是否符合: "被拦（不得提交）", 例外: "—", 其他提醒: `拦：${p.field}：${p.detail}` });
  }
  return rows;
}

export interface CheckedPlatform {
  check_id: string; platform: string; checked_at: string; verdict: Verdict; entry: PlanEntry;
  covers: Array<{ usage: string; ratio: string; slot?: string; path: string; sha256: string | null }>;
  overrides: Override[];
  /** 检查过的成片（绝对路径）：出包时必须就是它 */
  video_path: string | null;
}

type Rec = Record<string, unknown> & { platform?: string; verdict?: Verdict; payload_hash?: string; fingerprint?: string; checked_at?: string; covers?: CheckedPlatform["covers"];
  plan_problems?: unknown[]; inputs?: { plan_source?: string; plan_snapshot?: Record<string, unknown>; founder_quotes?: string[]; overrides?: Override[]; instruction_id?: string | null } };

/** 按留档的输入重建检查上下文：inline 计划用留档快照，文件计划重读文件 */
function rebuild(contentId: string, record: Rec, dataDir?: string, fresh = false) {
  const inputs = record.inputs ?? {};
  const plan = inputs.plan_source === "inline" ? inputs.plan_snapshot ?? null : inputs.plan_source || "06-publish/publish-plan.json";
  if (plan === null) return Promise.resolve({ ok: false as const, code: "check_stale", error: "这次检查用的是直接传入的计划，但没留快照：重跑 check" });
  return buildCtx({ _dataDir: dataDir, content_id: contentId, plan, founder_quotes: inputs.founder_quotes ?? [], overrides: inputs.overrides ?? [], ...(inputs.instruction_id ? { instruction_id: inputs.instruction_id } : {}) }, {}, fresh);
}

/**
 * 出包前核一次检查（spec §11）：检查记录在、属于这条稿、没被拦（被拦的项都有原话例外），
 * 并且按当时的输入重算 payload 哈希与指纹仍一致（计划、文件、登记、偏好、原话任何一样变了都算过期）。
 */
export async function verifyCheck(contentId: string, checkId: string, dataDir?: string): Promise<{ ok: true; checked: CheckedPlatform } | Fail> {
  const record = await readCheckRecord(contentId, checkId, dataDir) as Rec | null;
  if (!record || record.content_id !== contentId) return { ok: false, code: "check_missing", error: `找不到这次检查（${checkId}）：先跑 autocrew_publish check` };
  const who = platformLabel(record.platform ?? "");
  if (record.verdict === "block") return { ok: false, code: "check_blocked", error: `${who}上次检查被拦了（${checkId}）：改好计划重跑 check，或创始人明确破例时带 overrides 重跑` };
  if (record.plan_problems?.length) return { ok: false, code: "check_blocked", error: `这次检查时计划本身有问题（${checkId}）：改好计划重跑 check` };
  const ctx = await rebuild(contentId, record, dataDir, true);
  if ("ok" in ctx) return ctx;
  const entry = ctx.plan.entries.find((e) => e.platform === record.platform);
  if (!entry) return { ok: false, code: "check_stale", error: `发布计划里已经没有${who}了：重跑 check` };
  if (planLevelProblems(ctx).length) return { ok: false, code: "check_blocked", error: "发布计划现在有归不到平台的问题：改好计划重跑 check" };
  const now = await identityFor(ctx, entry, namedPlatforms(ctx));
  if (now.payload !== record.payload_hash || now.fp !== record.fingerprint) {
    return { ok: false, code: "check_stale", error: `${who}的计划、文件或依据在检查之后变了（${checkId} 已过期）：重跑 check` };
  }
  // 指纹不覆盖所有确定性项（封面字、重复平台条目…）：按现在的输入重判，有未例外的拦截就不出包
  if (platformVerdict(now.detItems) === "block") return { ok: false, code: "check_blocked", error: `${who}按现在的计划重判被拦了（${checkId}）：重跑 check 看原因` };
  // 返回的封面就是这次重新核过的文件（路径 + 字节），不是留档里当时的路径
  const covers = coverRows(now.det.covers) as CheckedPlatform["covers"];
  return { ok: true, checked: { check_id: checkId, platform: entry.platform, checked_at: record.checked_at ?? "", verdict: record.verdict ?? "pass", entry, covers, overrides: record.inputs?.overrides ?? [], video_path: now.det.video?.ok ? now.det.video.abs : null } };
}

/**
 * 这次检查的输入现在还一样吗（review-inbox §7-6，Codex 审 2a-1 r5 P1）：按留档输入重建、重算 payload 与指纹，不看结论。
 * 破例只能作用在创始人看到的那份上；计划改过就要先按新计划重新检查。fp 进「发之前再看一眼」条目的代次。
 */
export async function checkInputsNow(contentId: string, checkId: string, dataDir?: string, opts: { fresh?: boolean } = {}): Promise<{ same: boolean; fp: string }> {
  const record = await readCheckRecord(contentId, checkId, dataDir) as Rec | null;
  if (!record) return { same: false, fp: "missing" };
  const ctx = await rebuild(contentId, record, dataDir, opts.fresh === true).catch(() => ({ ok: false as const }));
  if ("ok" in ctx) return { same: false, fp: "unreadable" };
  const entry = ctx.plan.entries.find((e) => e.platform === record.platform);
  if (!entry) return { same: !record.payload_hash, fp: "no-entry" };
  const now = await identityFor(ctx, entry, namedPlatforms(ctx));
  return { same: now.payload === record.payload_hash && now.fp === record.fingerprint, fp: `${now.payload ?? ""}:${now.fp}` };
}

/**
 * 对话里给创始人看的那份（proactive-chat-review Addendum 2）：检查当时的计划条目原样、检查过的封面、成片绝对路径。
 * 读路径（走缓存）；真要定「没问题」时由 verifyCheck 现算。读不到 → null（调用方说清楚）。
 */
export async function checkView(contentId: string, checkId: string, dataDir?: string): Promise<{ entry: PlanEntry; covers: CheckedPlatform["covers"]; video_path: string | null } | null> {
  const record = await readCheckRecord(contentId, checkId, dataDir) as Rec | null;
  if (!record) return null;
  const ctx = await rebuild(contentId, record, dataDir).catch(() => ({ ok: false as const }));
  if ("ok" in ctx) return null;
  const entry = ctx.plan.entries.find((e) => e.platform === record.platform);
  if (!entry) return null;
  const video = entry.video_path ?? ctx.plan.final_video_path;
  const abs = video ? resolveInProject(video, ctx.root) : null;
  const covers = (record.covers ?? []).map((c) => ({ ...c, path: path.isAbsolute(c.path) ? c.path : path.join(ctx.root, c.path) }));
  return { entry, covers, video_path: abs && "abs" in abs ? abs.abs : null };
}

/**
 * 这次检查的发布包里有文件一分钟内还在变吗（现算时前后元数据对不上）。读不了 / 不见了的不算「还在写」，
 * 交给调用方原来的核验结论去说；这里绝不抛。
 */
export async function checkFilesUnsettled(contentId: string, checkId: string, dataDir?: string): Promise<boolean> {
  const view = await checkView(contentId, checkId, dataDir).catch(() => null);
  const files = [view?.video_path, ...(view?.covers ?? []).map((c) => c.path)].filter((x): x is string => Boolean(x));
  for (const f of files) {
    const r = await commitSha(f).catch(() => null);
    if (r && !r.ok && r.reason === STILL_SETTLING) return true;
  }
  return false;
}

/** 重跑和原检查只该差在破例本身：这几项之外（计划 payload、登记、偏好、指令、依据、原话…）必须一样 */
const OVERRIDE_PARTS = new Set(["overrides_sha", "requests_sha"]);

/**
 * 破例重跑出的检查，看的还是原检查那份输入吗（防 ABA：先读 A、重跑读到 B、落定前又改回 A）。
 * 比两份留档：payload 哈希相同，指纹各部分除破例相关的之外都相同。读不到 → false。
 */
export async function rerunMatchesOriginal(contentId: string, originalId: string, rerunId: string, dataDir?: string): Promise<boolean> {
  const [a, b] = await Promise.all([readCheckRecord(contentId, originalId, dataDir), readCheckRecord(contentId, rerunId, dataDir)]) as Array<Rec | null>;
  const pa = a?.fingerprint_parts as Record<string, unknown> | undefined, pb = b?.fingerprint_parts as Record<string, unknown> | undefined;
  if (!a || !b || !pa || !pb || a.payload_hash !== b.payload_hash) return false;
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)].filter((k) => !OVERRIDE_PARTS.has(k)));
  return [...keys].every((k) => JSON.stringify(pa[k]) === JSON.stringify(pb[k]));
}

/** 每个被拦平台还拦着哪几条规则（能不能例外）：next_action 指名，不让 agent 猜缺哪条 */
function blockedDetail(results: PlatformResult[], planBlocked: boolean): string {
  const parts = results.filter((r) => r.verdict === "block").map((r) => {
    const rules = [...new Set(r.items.filter((i) => i.result === "block").map((i) => `${i.rule ?? i.check}${i.overridable ? "" : "（不能例外）"}`))];
    return `${platformLabel(r.platform)}：${rules.join("、")}`;
  });
  return [...parts, ...(planBlocked ? ["计划本身：形状问题（不能例外）"] : [])].join("；");
}

/**
 * 发布计划里某平台条目（实际提交的那份）的 payload 哈希：发布回执据此认「检查的就是发出去的这份」（闸门 §11，创始人 09-29）。
 * 计划读不到 / 没这个平台 → null（= 没法证明检查过发出去的内容）。
 */
export async function entryPayloadHash(contentId: string, platform: string, dataDir?: string): Promise<string | null> {
  const ctx = await buildCtx({ _dataDir: dataDir, content_id: contentId, plan: "06-publish/publish-plan.json" }, {}).catch(() => null);
  if (!ctx || "ok" in ctx) return null;
  const entry = ctx.plan.entries.find((e) => e.platform === platform);
  if (!entry) return null;
  const det = await deterministicChecks({
    contentId, siblings: ctx.content.siblings ?? [], projectRoot: ctx.root, entry, videoPath: entry.video_path ?? ctx.plan.final_video_path,
    allowedRatios: effectiveCoverRatios(entry.platform, ctx.prefs.coverRatios), cropChecks: COVER_CROP_CHECKS[entry.platform] ?? [], registration: ctx.registration,
  });
  return payloadHash(entry, contentId, det.covers, det.video?.sha256 ?? null);
}

export async function executePublishCheck(params: Record<string, unknown>, deps: CheckDeps = {}): Promise<Record<string, unknown>> {
  const ctx = await buildCtx(params, deps, true);
  if ("ok" in ctx) return ctx;
  const named = namedPlatforms(ctx);
  const details: Detail[] = [];
  for (const entry of ctx.plan.entries) details.push(await checkPlatform(ctx, entry, named));
  for (const p of named.filter((x) => !ctx.plan.entries.some((e) => e.platform === x))) details.push(await missingPlatform(ctx, p));
  const rows = tableOf(ctx, details);
  const results = details.map((d) => d.result);
  const failed = [...new Set(results.flatMap((r) => r.semantic.failed))];
  // 计划级形状问题（没有平台、条目不是对象、认不出的平台）进结构化结果，不只进 Markdown
  const planProblems = ctx.plan.problems.filter((x) => !x.platform || !results.some((r) => r.platform === x.platform));
  if (!results.length) return { ok: false, code: "plan_invalid", error: `发布计划没法检查：${planProblems.map((p) => `${p.field}：${p.detail}`).join("；") || "没有平台"}`, plan_problems: planProblems };
  const blocked = [...results.filter((r) => r.verdict === "block").map((r) => r.platform), ...(planProblems.length ? ["plan"] : [])];
  return {
    ok: true, content_id: ctx.content.id, plan_source: ctx.planSource,
    platforms: results, plan_problems: planProblems,
    summary_table: summaryMarkdown(rows), summary_rows: rows,
    semantic: failed.length ? { status: "not_run", reasons: failed } : { status: "ok" },
    blocked_platforms: blocked,
    next_action: blocked.length
      ? `被拦的平台不得提交（${blockedDetail(results, planProblems.length > 0)}）：改计划后重跑 check；创始人明确要破例时，对还拦着的规则带 overrides[{platform, rule, founder_quote}] 重跑（没法例外的只能改计划）`
      : "把 summary_table 原样贴进给创始人的一次确认汇总；计划改了就重跑 check；最终点击前逐字段读回页面与发布包比对",
  };
}
