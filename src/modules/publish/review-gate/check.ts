/**
 * `autocrew_publish action=check`（发布前把关 spec §2）：平台集合与归属 → 确定性检查 → Jev A → Jev B → 按平台汇总。
 *
 * 只写检查留档（`06-publish/checks/`）与 Jev 缓存，不改任何业务状态；不调旧预检执行器（它会推进状态）。
 * 每平台单独判（E1），一个被拦不影响其他。
 *
 * §11 集成：`verifyCheck` 供 `ego_lite_prepare` 按平台出包前核检查仍有效（ego-lite.prepareCheckedPublish）；
 * 发布回执引用 check_id、「发布前未把关」与「发布前例外」在本体发布槽里做（production/publish-check-link.ts）。
 */
import { getContent, getDataDir, type Content } from "../../../storage/local-store.js";
import { contentRoot } from "../../../storage/content-project.js";
import { registeredPackage } from "../../production/publish-gate.js";
import { COVER_CROP_CHECKS, effectiveCoverRatios } from "../../cover/platform-ratios.js";
import { applyOverrides, deterministicChecks, type CoverFact, type RegistrationState } from "./deterministic.js";
import { makeJevCaller, JEV_MODEL, type JevCaller } from "./jev-client.js";
import { fingerprint, payloadHash, QUESTION_SET_VERSION, textSha } from "./identity.js";
import { readInstruction, splitInstruction, type StoredInstruction } from "./instructions.js";
import { readOverrides, readQuotes } from "./inputs.js";
import { loadPlan, missingAsNull, parsePlan, type ParsedPlan, type PlanEntry } from "./plan.js";
import { platformLabel, platformsNamedIn, type GatePlatform } from "./platforms.js";
import { prefsVersion, readPublishPrefs, type PublishPrefs } from "./preferences.js";
import { buildA, buildB, type BEntryView, type Instruction } from "./semantic.js";
import { runSemantic, type CallRecord } from "./semantic-run.js";
import { loadBasis, type Basis } from "./subtitles.js";
import { newCheckId, readCheckRecord, writeCheckRecord } from "./check-store.js";
import { summaryMarkdown, summaryRows } from "./summary.js";
import { platformVerdict, type CheckItem, type Override, type SummaryRow, type Verdict } from "./types.js";

export interface CheckDeps { jev?: JevCaller }

interface Ctx {
  content: Content; dataDir: string; root: string; quotes: string[]; overrides: Override[];
  instruction: StoredInstruction | null; plan: ParsedPlan; planSource: string; planRaw: Record<string, unknown>; prefs: PublishPrefs;
  registration: RegistrationState; basis: () => Promise<Basis>; caller: JevCaller;
}

interface Detail { result: PlatformResult; covers: CoverFact[]; account: string | null }

export interface PlatformResult {
  platform: string; verdict: Verdict; check_id: string; payload_hash: string | null; fingerprint: string | null;
  items: CheckItem[]; semantic: { cached: boolean; calls: number; failed: string[] };
}

type Fail = { ok: false; code: string; error: string };

async function registrationState(content: Content, dataDir: string): Promise<RegistrationState> {
  const g = await registeredPackage(content, dataDir);
  if (!g) return { kind: "none", reason: "这条没按内容本体登记（旧流程或非视频稿），没有登记记录可比" };
  if (!g.ok) return { kind: "blocked", error: g.error };
  return { kind: "ok", registration: g.files.registration, srt: g.files.srt };
}

async function buildCtx(params: Record<string, unknown>, deps: CheckDeps): Promise<Ctx | Fail> {
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
  const registration = await registrationState(content, dataDir);
  let basis: Promise<Basis> | null = null;
  return {
    content, dataDir, root, quotes: quotes.value, overrides: overrides.value, instruction, plan: parsePlan(loaded.plan), planSource: loaded.source, planRaw: loaded.plan,
    prefs: await readPublishPrefs(dataDir), registration, caller: deps.jev ?? makeJevCaller(),
    basis: () => (basis ??= loadBasis(registration.kind === "ok" ? registration.srt : null, content.body ?? "")),
  };
}

function instructionList(ctx: Ctx, platform: string): Instruction[] {
  const list: Instruction[] = [];
  for (const q of ctx.quotes) list.push({ n: list.length + 1, source: "原话", text: q });
  for (const s of ctx.instruction ? splitInstruction(ctx.instruction.text) : []) list.push({ n: list.length + 1, source: "网页指令", text: s });
  for (const r of ctx.prefs.publishRules.filter((x) => !x.platform || x.platform === platform)) list.push({ n: list.length + 1, source: "发布规则", text: r.text });
  return list;
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
    check_id: r.check_id, content_id: ctx.content.id, platform: r.platform, checked_at: new Date().toISOString(),
    inputs: { plan_source: ctx.planSource, ...(ctx.planSource === "inline" ? { plan_snapshot: ctx.planRaw } : {}), founder_quotes: ctx.quotes, instruction_id: ctx.instruction?.id ?? null, overrides: ctx.overrides.filter((o) => o.platform === r.platform), publish_rules: ctx.prefs.publishRules.filter((x) => !x.platform || x.platform === r.platform) },
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
    allowedRatios: effectiveCoverRatios(entry.platform, ctx.prefs.coverRatios), cropChecks: COVER_CROP_CHECKS[entry.platform] ?? [], registration: ctx.registration,
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
  const semItems = [...a.codeItems, ...sem.items];
  if (!instructions.length) semItems.push({ check: "B 执行符合指令", result: "info", basis: "没有可核对的原话 / 规则（不算失败；agent 漏交原话就查不到）" });
  const items = [...detItems, ...semItems];
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
function rebuild(contentId: string, record: Rec, dataDir?: string) {
  const inputs = record.inputs ?? {};
  const plan = inputs.plan_source === "inline" ? inputs.plan_snapshot ?? null : inputs.plan_source || "06-publish/publish-plan.json";
  if (plan === null) return Promise.resolve({ ok: false as const, code: "check_stale", error: "这次检查用的是直接传入的计划，但没留快照：重跑 check" });
  return buildCtx({ _dataDir: dataDir, content_id: contentId, plan, founder_quotes: inputs.founder_quotes ?? [], overrides: inputs.overrides ?? [], ...(inputs.instruction_id ? { instruction_id: inputs.instruction_id } : {}) }, {});
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
  const ctx = await rebuild(contentId, record, dataDir);
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

export async function executePublishCheck(params: Record<string, unknown>, deps: CheckDeps = {}): Promise<Record<string, unknown>> {
  const ctx = await buildCtx(params, deps);
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
      ? `被拦的平台（${blocked.map((p) => (p === "plan" ? "计划本身" : platformLabel(p))).join("、")}）不得提交：改计划后重跑 check；创始人明确要破例时带 overrides[{platform, rule, founder_quote}] 重跑`
      : "把 summary_table 原样贴进给创始人的一次确认汇总；计划改了就重跑 check；最终点击前逐字段读回页面与发布包比对",
  };
}
