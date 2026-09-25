import { loadHostEvidence } from "../modules/research/host-evidence-store.js";
import { inheritCreativeTask } from "../modules/writing/creative-task.js";
/**
 * 发包（P3 spec §5.1，2026-09-06 实机验收后改成异步）——`pack` 与 `pack_status` 的实现。
 *
 * 为什么不能同步发包：备料（材料收集 + 定向补证）要跑**几分钟**，而 MCP 宿主把工具调用
 * 卡在 60 秒（TS SDK 默认值；Codex 是 `tool_timeout_sec`）。实机上发生的事是：客户端超时
 * 放弃 → 服务端照跑不误 → 几分钟后用一个**新 pack_id** 覆盖了 `writing-pack.json` →
 * 宿主后来的 submit 全部打在另一个包上，而且没有任何一方报错。所以这一版把发包切成两段：
 *
 *   `pack` 立刻回 `{status:"preparing", content_id, pack_id}`（只跑立意闸口 + 建占位稿 + 领号）
 *   后台备料 →（成功）整份包原子落盘 `state:"ready"` ／（失败）`state:"failed"` + 人话原因
 *   `pack_status` 轮询，ready 之后回的就是老版同步 `pack` 的那份完整回执
 *
 * 两条纪律让它不再互相覆盖：
 * - **同一篇稿同时只有一次备料**：模块级 `preparing` 表按 content_id 挡重入，
 *   `pack` 再来一次拿到的是**同一个** pack_id，绝不起第二条后台任务；
 * - **落盘前认号**：后台任务写回之前先读盘对 `packId`，号被 `force` 换掉了就把自己的结果丢掉。
 *   这正是实机那条 bug 的堵口——迟到的备料不许覆盖现行的包。
 */
import { createHash } from "node:crypto";
import { writeTextAtomic } from "../storage/json-atomic.js";
import { getContent, getTopic, listContents, transitionStatus, updateContent, type Content } from "../storage/local-store.js";
import { CLIPBOARD_PLATFORMS, type ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";
import {
  buildWritingContext,
  contentAttributionOf,
  createPlaceholder,
  type ScriptRequest,
  type WritingContext,
} from "../modules/writing/generate-script.js";
import { renderWritingFeedback } from "../modules/writing/writing-feedback.js";
import { externalBlock, sanitizeExternal } from "../modules/research/research-prompt-kit.js";
import { DEFAULT_REPAIR_ROUNDS } from "../modules/writing/script-payload.js";
import { loadProfile, rulesForPlatform } from "../modules/profile/creator-profile.js";
import { cleanErrorMessage } from "../desktop/error-clean.js";
import type { runLoop } from "../engine/loop.js";
import { inspectWritingReadiness, writingContinueParams, writingReadinessFailure, type WritingReadiness } from "./writing-readiness.js";
import { describeWriterFailure } from "./writer-failure.js";
import {
  isReadyPack,
  packBudget,
  packPath,
  readPack,
  renderPack,
  serializeWriterCall,
  writePack,
  PACK_MD,
  writerProgress,
  type PackState,
  type ReadyPack,
  type WritingPackFile,
} from "./writer-pack.js";

export interface PackDeps {
  /** 测试注入（默认 listContents）：复用判定要读全量稿件 */
  listContentsImpl?: () => Promise<Content[]>;
  /** 测试注入的 loop 替身：定向补证在备料里跑，生产不传 */
  runLoopImpl?: typeof runLoop;
  /** 测试注入的备料替身：让「还在准备中」这个中间态可被确定地观测，生产不传 */
  buildContextImpl?: typeof buildWritingContext;
  onWarn?: (message: string) => void;
}

type Fail = { ok: false; error: string } & Record<string, unknown>;

/** 领号回执（备料还在跑） */
export interface PackPreparingResult extends Record<string, unknown> {
  ok: true;
  status: "preparing";
  content_id: string;
  pack_id: string;
  note: string;
}

/** 备料完成的完整回执——**与改异步之前那份同步 `pack` 的返回体逐字段相同** */
export interface PackReadyResult extends Record<string, unknown> {
  ok: true;
  status: "ready";
  content_id: string;
  pack_id: string;
  pack_md: string;
  budget: ReturnType<typeof packBudget>;
  note: string;
}

const POLL_NOTE = "正在装配本地写作材料：用 pack_status{content_id} 查看，status=ready 之后再动笔；宿主模式不会启动后台模型。";
const FIRST_NOTE = "写完用 submit 交回来；数字要能指到证据编号，缺证据先 find_evidence。";
const REISSUE_NOTE = "这条选题上原来那份包已作废（同一篇稿换了新 pack_id），旧包的提交会被拒。";

/**
 * 在跑的备料：key 是 content_id，值是**不会 reject** 的后台任务。
 * 它同时是「别起第二条」的锁与测试的等待点（`packPreparation`）。
 */
const preparing = new Map<string, Promise<void>>();

/** 测试与桌面端等一次备料落地用（生产链路一律轮询 `pack_status`，不 await 它） */
export function packPreparation(contentId: string): Promise<void> | undefined {
  return preparing.get(contentId);
}

function newPackId(): string {
  return `wp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function elapsedSeconds(iso: string): number {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

function readyResult(contentId: string, pack: ReadyPack): PackReadyResult {
  return {
    ok: true,
    status: "ready",
    content_id: contentId,
    pack_id: pack.packId,
    pack_md: renderPack(contentId, pack),
    budget: packBudget(pack),
    note: pack.note ?? FIRST_NOTE,
    ...writerProgress(pack),
  };
}

/** The same frozen facts must survive repeated pack calls and process restarts. */
function preparationProgress(contentId: string, pack: WritingPackFile): Record<string, unknown> {
  return {
    preparation: pack.request?.readiness ?? {
      status: "unknown",
      note: "旧写作包未记录领包时的研究与立意状态，不能追认为已完成。",
    },
    writing_source: { kind: "host", host: pack.host },
    next_action: { tool: "autocrew_writer", params: { action: "pack_status", content_id: contentId } },
    poll_after_seconds: 30,
  };
}

// ─── pack ─────────────────────────────────────────────────────────────────────

/**
 * 复用哪一篇稿：同一选题上**还没交稿**的占位稿原地续用（§5.2），
 * 不新建第二张卡——领两次包留两张僵尸卡正是重试链的老毛病。
 */
async function reusablePlaceholder(
  topicId: string,
  platform: string,
  listContentsImpl: () => Promise<Content[]>,
): Promise<Content | null> {
  const all = await listContentsImpl();
  const hit = all.find(
    (c) =>
      c.topicId === topicId &&
      c.platform === platform &&
      c.status === "drafting" &&
      Boolean(c.pack) &&
      !c.pack?.submittedAt,
  );
  return hit ?? null;
}

export interface PackParams {
  modelExecution?: "host" | "engine";
  /** Explicit draft revision target; never guess among multiple submitted drafts. */
  contentId?: string;
  topicId: string;
  platform: string;
  direction?: string;
  requirements?: string;
  skipReason?: string;
  /** 宿主自己查来的材料（原样注入 research 槽，并登记成 `user-research` 一条未核验账目） */
  research?: string;
  researchMode?: "auto" | "provided" | "skip";
  researchReason?: string;
  host: string;
  /** 作废手上这份包、重跑一次备料（宿主明说要重来时才给 true） */
  force: boolean;
}

/** 固定字段顺序，空串与未设置等价；不把宿主或 force 这种调用参数当写作要求。 */
function requestKey(req: ScriptRequest, topicDescription: string): string {
  return JSON.stringify([
    req.topic.trim(), req.platform, req.topicId ?? "", topicDescription.trim(),
    req.direction?.trim() ?? "", req.requirements?.trim() ?? "",
    req.angleSkipReason?.trim() ?? "", req.research?.trim() ?? "",
    req.packId ?? "", req.usePatterns ?? true, req.researchMode ?? "auto", req.researchReason?.trim() ?? "", req.modelExecution ?? "engine",
  ]);
}

/** 规划快照按值比较，JSON 对象键顺序变化不应触发重新备料；数组顺序仍有意义。 */
function planningFingerprint(selectedAngle: unknown, profile: unknown, content?: Content | null): string {
  const feedbackState = content?.writingFeedback?.length ? { writingFeedback: content.writingFeedback, sourceDraft: { title: content.title, body: content.body } } : {};
  const stable = JSON.stringify({ selectedAngle: selectedAngle ?? null, profile, ...feedbackState }, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value,
  );
  return createHash("sha256").update(stable).digest("hex");
}

export async function startPack(
  params: PackParams,
  dataDir: string,
  deps: PackDeps,
): Promise<PackPreparingResult | PackReadyResult | Fail> {
  const warn = deps.onWarn ?? ((m: string) => console.warn(`[writer] ${m}`));
  if (!(CLIPBOARD_PLATFORMS as readonly string[]).includes(params.platform)) {
    return { ok: false, error: `无效 platform「${params.platform}」。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}` };
  }
  const topic = await getTopic(params.topicId, dataDir);
  if (!topic) return { ok: false, error: `选题不存在：${params.topicId}` };
  const existing = params.contentId ? await getContent(params.contentId, dataDir) : await reusablePlaceholder(
    params.topicId,
    params.platform,
    deps.listContentsImpl ?? (() => listContents(dataDir)),
  );
  if (params.contentId) {
    if (!existing) return { ok: false, error: `稿件不存在：${params.contentId}` };
    if (existing.topicId !== params.topicId || existing.platform !== params.platform) return { ok: false, error: "content_id 必须属于本次 topic_id 和 platform，不能把另一篇稿件重领为本稿。" };
    if (!["drafting", "revision", "draft_ready"].includes(existing.status)) return { ok: false, error: `本稿现在是 ${existing.status}，不能重开写作包；请先按稿件流程回到可修改阶段。` };
    if ((existing.status === "draft_ready" || existing.pack?.submittedAt) && !params.force) return { ok: false, code: "pack_request_changed", error: "这是已交稿的草稿；修改时显式带 content_id 和 force:true 重领包，正文在新稿提交前保留。" };
  }
  const fingerprint = planningFingerprint(topic.selectedAngle, await loadProfile(dataDir), existing);
  const current = existing ? await readPack(existing.id, dataDir) : null;
  const previous = current?.request?.req ?? current?.context?.req ?? existing?.genRequest;
  let req: ScriptRequest = {
    ...previous,
    modelExecution: params.modelExecution ?? "host",
    topic: topic.title,
    topicDescription: topic.description,
    platform: params.platform as ClipboardPlatform,
    topicId: params.topicId,
    // 未重提 = 继承；显式空串 = 清掉。不能把轮询重领误当成删除原来的规划和材料。
    ...(params.direction !== undefined ? { direction: params.direction } : {}),
    ...(params.requirements !== undefined ? { requirements: params.requirements } : {}),
    ...(params.skipReason !== undefined ? { angleSkipReason: params.skipReason.trim() ? params.skipReason : undefined } : {}),
    ...(params.research !== undefined ? { research: params.research.trim() ? params.research : undefined } : {}),
    ...(params.researchMode !== undefined ? { researchMode: params.researchMode } : {}),
    ...(params.researchReason !== undefined ? { researchReason: params.researchReason.trim() ? params.researchReason : undefined } : {}),
  };
  const topicDescription = topic.description ?? "";
  // 旧包没存选题描述，无法反推历史值；其余已保存请求仍可比对，新包从领号起完整冻结。
  const previousDescription = current?.request?.topicDescription ?? previous?.topicDescription ?? topicDescription;
  const requestChanged = previous && requestKey(previous, previousDescription) !== requestKey(req, topicDescription);
  // 旧包没存指纹，不能把当前规划假装成旧包实际用过的快照；仅新包可可靠检查规划变更。
  const planningChanged = current?.request?.planningFingerprint && current.request.planningFingerprint !== fingerprint;
  if (!params.force && current && (requestChanged || planningChanged)) {
    return {
      ok: false,
      code: "pack_request_changed",
      error: "本次写作要求、材料、选题描述、已选立意、修改反馈或创作者档案与现有写作包不同，旧包没有应用这些变化。请带更新后的要求和 force:true 重新 pack，再按新包写作。若改用已选立意卡，显式传 direction:\"\" 清除旧手写角度。",
      content_id: existing!.id,
      pack_id: current.packId,
    };
  }
  // 立意闸口与内部写作同一份（§5.1）：有候选卡却没选，宿主也得回去问创始人。
  // 它必须留在同步段——这是拒单，不是「先答应下来再后台失败」。
  const readiness = await inspectWritingReadiness(params.topicId, req, dataDir, warn);
  if (!readiness.ready) return writingReadinessFailure(readiness);
  // Persist the same original task as research, even when the host only supplies topic/platform.
  req = inheritCreativeTask(req, readiness.creativeTask);
  const frozenReadiness = current?.request?.readiness ?? current?.context?.readiness;
  const previousBriefHash = isReadyPack(current) ? current.briefHash : frozenReadiness ? frozenReadiness.research.briefHash ?? "" : undefined;
  if (!params.force && current && previousBriefHash !== undefined && previousBriefHash !== (readiness.research.briefHash ?? "")) {
    return {
      ok: false, code: "pack_request_changed", content_id: existing!.id, pack_id: current.packId,
      error: "调研简报已更新，现有写作包仍使用旧材料；请保留完整要求并用 force:true 重新 pack。",
      preparation: readiness,
      next_action: { tool: "autocrew_writer", params: { ...readiness.continue_params, action: "pack", force: true } },
    };
  }

  const contentId = existing?.id ?? (await createPlaceholder(req, dataDir));
  const inFlight = preparing.has(contentId);

  if (!params.force) {
    // 已经备好了就原样还给他（不重跑：备料花的是真钱）
    if (isReadyPack(current)) return readyResult(contentId, current);
    // 还在跑：同一个号回第二遍，绝不起第二条后台任务
    if (current?.state === "preparing" && inFlight) {
      return { ok: true, status: "preparing", content_id: contentId, pack_id: current.packId, note: POLL_NOTE, ...preparationProgress(contentId, current) };
    }
  }
  // 落到这里的三种情形都该重跑：force、没有包、以及「盘上写着 preparing 但没有任务在跑」
  // （进程重启留下的孤儿，不重跑它就永远 ready 不了）。
  return startPreparation({ contentId, req, readiness, topicDescription, planningFingerprint: fingerprint, host: params.host, reissued: Boolean(current) }, dataDir, deps);
}

async function startPreparation(
  args: { contentId: string; req: ScriptRequest; readiness: WritingReadiness; topicDescription: string; planningFingerprint: string; host: string; reissued: boolean },
  dataDir: string,
  deps: PackDeps,
): Promise<PackPreparingResult> {
  const { contentId, host } = args;
  const packId = newPackId();
  const issuedAt = new Date().toISOString();
  const note = args.reissued ? REISSUE_NOTE : FIRST_NOTE;
  const placeholder: WritingPackFile = {
    packId,
    request: { req: args.req, topicDescription: args.topicDescription, planningFingerprint: args.planningFingerprint, readiness: args.readiness },
    issuedAt,
    state: "preparing",
    note,
    host,
    briefHash: "",
    angleId: "",
    ledger: { entries: [], lookups: [], budget: { max: 0, used: 0 } },
    ledgerBudget: { max: 0, used: 0 },
    repair: { max: DEFAULT_REPAIR_ROUNDS, used: 0 },
    reviewRounds: 0,
    attempts: {},
  };
  // 先落号再开工：宿主拿到的 pack_id 从这一刻起就是这篇稿的 fencing token。
  // 落号要排队——插在一次补证的读-改-写中间，等于把作废的旧包又写回去（见 `serializeWriterCall`）
  await serializeWriterCall(contentId, async () => {
    const target = await getContent(contentId, dataDir);
    if (!target || !["drafting", "revision", "draft_ready"].includes(target.status)) throw new Error("稿件阶段已变化，未重开写作包；请重新读取稿件状态。");
    if (target.status === "draft_ready") {
      const reopened = await transitionStatus(contentId, "drafting", { expectedStatus: "draft_ready", host }, dataDir);
      if (!reopened.ok) throw new Error(reopened.error ?? "稿件未能回到修改阶段");
    }
    await writePack(contentId, placeholder, dataDir);
    await updateContent(
      contentId,
      {
        writtenBy: { kind: "host", host },
        genRequest: args.req,
        pack: { packId, issuedAt, host },
        lastError: null,
        _versionNote: args.reissued ? `重新发写作包给 ${host}（旧包作废）` : `写作包发给 ${host}`,
      },
      dataDir,
    );
  });

  const work = prepare({ contentId, packId, req: args.req, readiness: args.readiness, host, note }, dataDir, deps);
  const task: Promise<void> = work.finally(() => {
    if (preparing.get(contentId) === task) preparing.delete(contentId);
  });
  preparing.set(contentId, task);
  return {
    ok: true,
    status: "preparing",
    content_id: contentId,
    pack_id: packId,
    note: args.reissued ? `${REISSUE_NOTE}${POLL_NOTE}` : POLL_NOTE,
    ...preparationProgress(contentId, placeholder),
  };
}

// ─── 后台备料 ─────────────────────────────────────────────────────────────────

interface PrepareArgs {
  readiness: WritingReadiness;
  contentId: string;
  packId: string;
  req: ScriptRequest;
  host: string;
  note: string;
}

/** 后台任务**永不 reject**：失败也是一个要落盘的状态，不是掉在地上的 rejection */
async function prepare(args: PrepareArgs, dataDir: string, deps: PackDeps): Promise<void> {
  const warn = deps.onWarn ?? ((m: string) => console.warn(`[writer] ${m}`));
  try {
    const build = deps.buildContextImpl ?? buildWritingContext;
    // 材料收集 + 定向补证（各自的墙钟在里面）+ 提示词装配——与内部写手**同一个函数**
    const source = await getContent(args.contentId, dataDir);
    const built = await build(args.req, dataDir, warn, deps.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : undefined);
    if (args.req.modelExecution === "host") {
      const evidence = await loadHostEvidence(args.contentId, dataDir);
      for (const entry of evidence) built.inputs.ledger.add(entry);

    }
    const feedback = renderWritingFeedback(source?.writingFeedback);
    if (feedback) {
      const draft = source?.body ? ["【本稿当前版本（修改基底；其中的陈述仍需依据材料核查）】", externalBlock([sanitizeExternal(source.title, source.title.length), sanitizeExternal(source.body, source.body.length)])].join("\n") : "";
      built.prompts.user += `\n\n${draft}\n\n${feedback}`;
      built.inputs.writingContract += `\n\n${feedback}`;
    }
    await finishReady(args, built, dataDir);
  } catch (err) {
    await finishFailed(args, err, dataDir).catch((e) => warn(`写作包失败状态没写回：${cleanErrorMessage(e)}`));
  }
}

/**
 * 号还是我的吗？`force` 重发之后旧任务的结果**必须丢掉**——
 * 覆盖现行的包正是这次要修的那条实机 bug。
 */
async function stillMine(contentId: string, packId: string, dataDir: string): Promise<WritingPackFile | null> {
  const current = await readPack(contentId, dataDir);
  return current?.packId === packId ? current : null;
}

function readyPackOf(args: PrepareArgs, base: WritingPackFile, built: WritingContext): ReadyPack {
  const { inputs, prompts, gate } = built;
  const snapshot = inputs.ledger.snapshot();
  const platform = args.req.platform;
  return {
    ...base,
    state: "ready",
    note: args.note,
    briefHash: inputs.attribution.usedBriefHash ?? "",
    angleId: inputs.attribution.usedAngle?.id ?? "",
    ledger: snapshot,
    ledgerBudget: { max: snapshot.budget.max, used: snapshot.budget.used },
    // 修复轮上限与内部写手同源：包有 gate 就用它的，没有 gate 也照给缺省（抖音包没 gate，但硬门照拦）
    repair: { max: gate?.maxRepairRounds ?? DEFAULT_REPAIR_ROUNDS, used: base.repair.used },
    context: {
      readiness: args.readiness,
      req: args.req,
      writingContract: inputs.writingContract,
      platform,
      trackPackId: inputs.pack.id,
      prompts,
      researchSlot: inputs.snapshot.text,
      ...(inputs.angle ? { angleCard: inputs.angle.card } : {}),
      voiceSamples: inputs.profile?.voiceSamples ?? [],
      canFindEvidence: args.req.modelExecution === "host" || Boolean(inputs.researcher),
      rulesApplied: inputs.profile ? rulesForPlatform(inputs.profile, platform).length : 0,
      wroteWithoutBrief: !inputs.attribution.usedBriefHash,
      wroteWithoutAngle: inputs.wroteWithoutAngle,
      ...(inputs.evidenceNote ? { evidenceNote: inputs.evidenceNote } : {}),
    },
  };
}

/** 认号 + 写回是一个不可分的动作，所以整段进队列（同 `find_evidence` 那条队） */
function finishReady(args: PrepareArgs, built: WritingContext, dataDir: string): Promise<void> {
  return serializeWriterCall(args.contentId, async () => {
    const base = await stillMine(args.contentId, args.packId, dataDir);
    if (!base) return;
    // Preparation is asynchronous. Never label a pack with a readiness snapshot
    // from one brief while its actual prompts/ledger came from another.
    const actual = built.inputs.attribution;
    if ((args.readiness.research.briefHash ?? "") !== (actual.usedBriefHash ?? "") ||
        (args.readiness.angle.selectedAngleHash ?? "") !== (actual.usedAngle?.hash ?? "")) {
      throw new Error("写作包准备期间调研或立意已变化，准备状态与实际材料不一致；请带原始要求和 force:true 重新 pack。");
    }
    const latest = await inspectWritingReadiness(args.req.topicId!, args.req, dataDir);
    const topic = await getTopic(args.req.topicId!, dataDir);
    const fingerprint = planningFingerprint(topic?.selectedAngle, await loadProfile(dataDir), await getContent(args.contentId, dataDir));
    if (!latest.ready || latest.research.briefHash !== args.readiness.research.briefHash ||
        latest.angle.selectedAngleHash !== args.readiness.angle.selectedAngleHash ||
        !topic || topic.title !== args.req.topic || topic.description !== args.req.topicDescription ||
        (base.request?.planningFingerprint && base.request.planningFingerprint !== fingerprint)) {
      throw new Error("写作包准备期间调研、选题或创作者规划已更新，旧准备结果已停止；请带完整要求和 force:true 重新 pack。");
    }
    const pack = readyPackOf(args, base, built);
    await writePack(args.contentId, pack, dataDir);
    await writeTextAtomic(packPath(args.contentId, dataDir, PACK_MD), renderPack(args.contentId, pack));
    // 归因（账本、简报版本、角度、语料）在备料落地这一刻就进稿件：补证已经花过钱了，
    // 宿主一直不交稿也要查得到「这稿当时手上有哪些证据」
    await updateContent(
      args.contentId,
      {
        ...contentAttributionOf(built.inputs),
        lastError: null,
        _versionNote: `写作包备料完成（${args.host}）`,
      },
      dataDir,
    );
  });
}

async function finishFailed(args: PrepareArgs, err: unknown, dataDir: string): Promise<void> {
  const reason = await describeWriterFailure(err, "scout", dataDir, cleanErrorMessage(err));
  await serializeWriterCall(args.contentId, async () => {
    const base = await stillMine(args.contentId, args.packId, dataDir);
    if (!base) return;
    await writePack(args.contentId, { ...base, state: "failed", error: reason }, dataDir);
    // 稿件上也留一句：没有这一句，创始人在工作台只看到一张不动的「写作中」卡
    await updateContent(args.contentId, { lastError: `写作包准备失败：${reason}` }, dataDir);
  });
}

// ─── pack_status ──────────────────────────────────────────────────────────────

export interface PackStatusResult extends Record<string, unknown> {
  ok: true;
  status: PackState;
  pack_id: string;
  started_at: string;
  elapsed_s: number;
}

/**
 * 轮询口。`ready` 时回的**就是**备料完成的那份完整回执（宿主不必再 pack 一次）；
 * `failed` 仍然 `ok:true`——查状态这件事成功了，坏消息在 `status` 与 `error` 里，
 * 而且 submit/find_evidence 那头还有一道硬拦，漏看不会写出一篇没材料的稿。
 */
export async function packStatus(contentId: string, dataDir: string): Promise<PackStatusResult | Fail> {
  const pack = await readPack(contentId, dataDir);
  if (!pack) return { ok: false, error: `这篇没有写作包（${contentId}）——先 pack 一次` };
  const base = {
    ok: true as const,
    status: pack.state,
    pack_id: pack.packId,
    started_at: pack.issuedAt,
    elapsed_s: elapsedSeconds(pack.issuedAt),
  };
  if (isReadyPack(pack)) return { ...base, ...readyResult(contentId, pack), status: "ready" as const };
  if (pack.state === "failed") {
    const req = pack.request?.req;
    return {
      ...base,
      ...preparationProgress(contentId, pack),
      error: pack.error ?? "未记原因",
      note: "这份包没备成，别动笔——pack{force:true} 重来一次；连着失败就先跑 autocrew_workflow doctor 看线路。",
      ...(req?.topicId ? { next_action: { tool: "autocrew_writer", params: { ...writingContinueParams(req.topicId, req), action: "pack", force: true } } } : {}),
    };
  }
  return { ...base, ...preparationProgress(contentId, pack), note: POLL_NOTE };
}
