import { getConfigDir } from "../storage/storage-roots.js";
import { historyGuard } from "./history-guard.js";
import { inspectHostResearchTask } from "../modules/research/host-research-store.js";
import { executeScout } from "./scout.js";
import { createCreativeTask } from "../modules/writing/creative-task.js";
/**
 * MCP creation entry: prepare material and direction before the host writes.
 * Existing research jobs and brief snapshots are reused, with visible gaps and
 * explicit retry after failure. Recommendations never mutate the creator's choice.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";

import { loadEngineConfig, ENGINE_DEFAULTS } from "../engine/config.js";
import {
  findAngleCard,
  parseAngleCard,
} from "../modules/research/angle-cards.js";
import { resolveEffectiveBrief } from "../modules/research/brief-snapshot.js";
import { createDeepResearchRunJob } from "../modules/research/deep-research.js";
import { getJob, topicHashOf, type ResearchJobKind } from "../modules/research/research-job-store.js";
import { createResearchRunner, type ResearchRunner } from "../modules/research/research-runner.js";
import { SEARCH_NOT_CONFIGURED, searchAvailable } from "../modules/research/search-provider.js";
import { CLIPBOARD_PLATFORMS, type ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";
import { startGenerateScript, type ScriptRequest } from "../modules/writing/generate-script.js";
import { ANGLE_GATE_COPY, recordFounderAngle } from "../modules/research/angle-gate.js";
import { getContent, getDataDir, getTopic, saveTopic, updateTopic } from "../storage/local-store.js";
import { angleOptionsView, draftingNote, draftOwnerView, draftView, jobView } from "./workflow-views.js";
import { inspectWritingReadiness, writingReadinessFailure, type WritingReadinessRequest, newDraftGate } from "./writing-readiness.js";
// 健康视图是桌面与 dsh 共用的那一个（spec §4.1「同一个视图函数」）——doctor 不另写一份
import { buildEngineHealth, probeAllProviders } from "../desktop/engine-health.js";
import { storageFailure } from "../storage/storage-error.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

const ACTIONS = ["prepare", "research", "status", "select_angle", "write", "draft", "doctor"] as const;
type WorkflowAction = (typeof ACTIONS)[number];

export const workflowSchema = Type.Object({
  action: Type.Unsafe<WorkflowAction>({
    type: "string",
    enum: [...ACTIONS],
    description: "prepare | research | status | select_angle | write | draft | doctor",
  }),
  topic_id: Type.Optional(Type.String({ description: "选题 id（prepare / research / status / select_angle / write 必填；先查询或创建选题，避免重复）" })),
  kind: Type.Optional(
    Type.Unsafe<ResearchJobKind>({
      type: "string",
      enum: ["full", "angles"],
      description: "research 的任务类型：full = 四视角深调研（默认，需要搜索 key）；angles = 在现有简报上只重跑立意",
    }),
  ),
  inspiration: Type.Optional(Type.String({ description: "prepare：只有一句灵感、还没有选题时传它，自动建选题并开选题会" })),
  angle_id: Type.Optional(Type.String({ description: "select_angle：创始人选中的立意卡 id，如 angle-2" })),
  founder_words: Type.Optional(Type.String({ description: "select_angle 必填：创始人选卡或给自定角度时的原话，照抄不转述" })),
  card: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "select_angle：创始人改写过的整张卡（原样回传 status 给的那张再改文字）。不给 = 按原卡点选。id / 证据引用 / 锚点指纹不可改，score 由服务端重算。",
      },
    ),
  ),
  brief_revision: Type.Optional(
    Type.Integer({
      description:
        "select_angle 必填：你读到这批候选时的 brief.revision（needs_angle 的 next_action 里就有）。缺省或与当前简报对不上都会被拒，防止选到已被重跑换掉的卡。",
    }),
  ),
  platform: Type.Optional(
    Type.String({ description: `prepare / write：目标平台。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}` }),
  ),
  direction: Type.Optional(
    Type.String({ description: "创始人自定角度：先用 select_angle{direction, founder_words} 记下，之后 prepare/pack 带同一句；没记过的 direction 会被拒" }),
  ),
  requirements: Type.Optional(
    Type.String({ description: "prepare / write：创作者本次完整写作要求，原样保留受众、提纲、必写/禁写、篇幅、口吻与修改反馈；补充选中立意，不绕过选卡。" }),
  ),
  research_mode: Type.Optional(Type.Unsafe<"auto" | "provided">({
    type: "string", enum: ["auto", "provided"],
    description: "默认 auto；provided = 创作者自带材料（放 research），仍要出立意卡、由创始人定。跳过调研/选卡的通道已关闭。",
  })),
  research: Type.Optional(Type.String({ description: "research_mode=provided 时必填的已有材料、来源与摘录；不能伪称 AutoCrew 已调研。" })),
  execution: Type.Optional(Type.Union([Type.Literal("host"), Type.Literal("engine")], { description: "默认host：研究分析/立意交当前宿主完成，无后台模型调用；仅用户明确选择后台模式时engine，模型API与搜索服务使用独立额度。" })),
  content_id: Type.Optional(Type.String({ description: "draft：稿件 id（write 返回的 contentId）" })),
  probe: Type.Optional(
    Type.Boolean({
      description:
        "doctor：true = 真去每个模型端点发一次极小调用，回每条线的通/坏与耗时（几秒到几十秒）。默认 false，只看配置不出网。",
    }),
  ),
});

export const WORKFLOW_DESCRIPTION = [
  "AutoCrew 创作统一入口 = 选题会：prepare{topic_id 或 inspiration,platform,requirements} → 多路调研出 3–4 张立意卡 → 创始人定 → 才能开写。完整保留原始要求，不直接 write/generate。",
  "prepare 检查材料和立意：默认返回awaiting_host_research和scout任务，由当前宿主分析与提交，不启动后台模型，不轮询等后台；只有显式execution=engine才启动后台调研。",
  "needs_angle：展示各卡的主张、证据、缺口、观众收获和数据依据，让创始人选；不代选。select_angle{angle_id,brief_revision,founder_words（原话）,card?} 保存；创始人自己给角度用 select_angle{direction,founder_words}。ready_to_write 时 next_action 就是 writer pack。",
  "ready_to_write：调用 next_action 指向的 autocrew_writer pack，当前宿主结合已有对话与原始要求写稿并提交；AutoCrew 提供材料、检查和编辑帮助。",
  "创作者自带材料用 research_mode=provided 交 research，仍需出卡并由创始人定；没有跳过通道。",
  "research{topic_id,kind} 默认领取scout宿主任务；只有用户明确指定execution=engine才启动后台研究。宿主可自带搜索并将URL交scout read_page核验，scout search使用独立搜索服务额度。status只读状态。prepare 不替用户选卡，也不暗中代写。",
  "write{...,execution:'engine'} 仅供用户明确要求后台模型代写；draft{content_id} 查看实际写作、审稿、证据阻塞状态。",
  "doctor{probe?} 检查配置；probe:true 会实际访问端点。不能把配置检查当成真实调用成功。",
].join("\n");

// ─── Result types ─────────────────────────────────────────────────────────────

type WorkflowOk = { ok: true } & Record<string, unknown>;
type WorkflowFail = { ok: false; error: string } & Record<string, unknown>;
export type WorkflowResult = WorkflowOk | WorkflowFail;

const NO_BRIEF = "这条选题还没有可用简报——先跑一轮深调研";

function fail(error: string, extra: Record<string, unknown> = {}): WorkflowFail {
  return { ok: false, error, ...extra };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ─── Deps（测试注入口；生产全走默认实现） ──────────────────────────────────────

export interface WorkflowDeps {
  /** 替掉真 runner（默认串行 runner + 真四视角管线） */
  createRunnerImpl?: (dataDir: string) => ResearchRunner;
  /** 替掉后台写稿（默认 startGenerateScript） */
  startGenerateScriptImpl?: (req: ScriptRequest, dataDir?: string) => Promise<{ contentId: string }>;
  searchAvailableImpl?: (dataDir: string) => Promise<boolean>;
  /** 非致命故障的可见出口（默认 console.warn） */
  onWarn?: (message: string) => void;
}

// ─── Runner registry：一个 dataDir 一个单例 ────────────────────────────────────

interface RunnerEntry {
  runner: ResearchRunner;
  /** 首次使用时的启动回收；失败只 warn（补扫炸了也照样能投递，同 research-runtime） */
  ready: Promise<void>;
}

const runners = new Map<string, RunnerEntry>();

function defaultCreateRunner(dataDir: string, warn: (m: string) => void): ResearchRunner {
  return createResearchRunner({
    dataDir,
    runJob: createDeepResearchRunJob({ dataDir, onWarn: warn }),
    onError: (err, ctx) => warn(`runner ${ctx.phase} 失败（${ctx.topicId ?? "-"}）：${errText(err)}`),
  });
}

function runnerFor(dataDir: string, deps: WorkflowDeps, warn: (m: string) => void): RunnerEntry {
  const existing = runners.get(dataDir);
  if (existing) return existing;
  const runner = deps.createRunnerImpl
    ? deps.createRunnerImpl(dataDir)
    : defaultCreateRunner(dataDir, warn);
  const ready = runner
    .reclaimStaleJobs()
    .then((reclaimed) => {
      if (reclaimed.length > 0) warn(`回收 ${reclaimed.length} 条中断的调研任务，已重新排队`);
    })
    .catch((err) => warn(`启动回收失败（${dataDir}）：${errText(err)}`));
  const entry: RunnerEntry = { runner, ready };
  runners.set(dataDir, entry);
  return entry;
}

/** 测试与优雅停机：停掉所有 runner，下次调用重建（在途的 runJob 不打断） */
export function resetWorkflowRunners(): void {
  for (const { runner } of runners.values()) runner.stop();
  runners.clear();
}

// ─── research ─────────────────────────────────────────────────────────────────

async function doResearch(
  params: Record<string, unknown>,
  dataDir: string,
  deps: WorkflowDeps,
  warn: (m: string) => void,
): Promise<WorkflowResult> {
  const topicId = str(params.topic_id);
  if (!topicId) return fail("topic_id 必填");
  const rawKind = str(params.kind) || "full";
  if (rawKind !== "full" && rawKind !== "angles") return fail(`未知 kind：${rawKind}。有效值：full | angles`);
  const kind: ResearchJobKind = rawKind;
  if (params.execution !== "engine") {
    if (kind === "angles") return fail("宿主模式暂不支持仅重跑立意。可用scout force prepare重做完整调研与立意；只有用户明确要求后台执行时才用execution=engine。", { code: "host_angles_handoff", next_action: { tool: "autocrew_scout", params: { action: "prepare", topic_id: topicId, force: true } } });
    return executeScout(scoutPrepareParams(params, dataDir)) as Promise<WorkflowResult>;
  }

  // 搜索 key 门只管 full（angles 不出网）——口径同 research-runtime.postJob
  if (kind === "full" && !(await (deps.searchAvailableImpl ?? searchAvailable)(dataDir))) {
    return fail(SEARCH_NOT_CONFIGURED);
  }
  // angles 是「在当前生效简报上重跑立意」：没有简报就没有它的起点，早拒好过排一个注定失败的 job
  if (kind === "angles" && !(await resolveEffectiveBrief(topicId, dataDir, warn))) {
    return fail(NO_BRIEF);
  }

  const { runner, ready } = runnerFor(dataDir, deps, warn);
  await ready;
  const [priorJob, priorBrief] = await Promise.all([getJob(topicId, dataDir), resolveEffectiveBrief(topicId, dataDir, warn)]);
  const task = createCreativeTask(readinessRequest(params), kind === "angles" ? priorBrief?.brief.creativeTask : priorJob?.creativeTask ?? priorBrief?.brief.creativeTask);
  const res = await runner.trigger(topicId, kind, task);
  if (!res.accepted) return fail(res.reason, res.inFlight ? { inFlight: true } : {});
  return {
    ok: true,
    job: jobView(res.job),
    deduped: res.deduped,
    note: `${kind === "angles" ? "重新立意" : "深调研"}已在后台开始（通常 5–15 分钟）。用 status{topic_id} 轮询到 job.terminal=true，不要编造结果。`,
  };
}

// ─── prepare ──────────────────────────────────────────────────────────────────

function scoutPrepareParams(params: Record<string, unknown>, dataDir: string): Record<string, unknown> {
  return { action: "prepare", topic_id: params.topic_id, _host: params._host, _dataDir: dataDir,
    ...Object.fromEntries(["platform", "direction", "requirements", "force"].filter(key => params[key] !== undefined).map(key => [key, params[key]])) };
}

function readinessRequest(params: Record<string, unknown>): WritingReadinessRequest {
  return {
    ...(typeof params.platform === "string" ? { platform: params.platform } : {}),
    ...(typeof params.direction === "string" ? { direction: params.direction } : {}),
    // Keep the creator's wording intact across the prepare / pack handoff.
    ...(typeof params.requirements === "string" ? { requirements: params.requirements } : {}),
    ...(typeof params.skip_reason === "string" ? { angleSkipReason: params.skip_reason } : {}),
    ...(typeof params.research === "string" ? { research: params.research } : {}),
    researchMode: (str(params.research_mode) || "auto") as WritingReadinessRequest["researchMode"],
    ...(typeof params.research_reason === "string" ? { researchReason: params.research_reason } : {}),
  };
}

async function doPrepare(
  params: Record<string, unknown>, dataDir: string, deps: WorkflowDeps, warn: (m: string) => void,
): Promise<WorkflowResult> {
  // 只有一句灵感：先建选题，再开这条的选题会（prepare 本身就是选题会的入口，不在这里拦）
  const inspiration = str(params.inspiration);
  let topicId = str(params.topic_id);
  if (!topicId && inspiration) {
    const created = await saveTopic({ title: Array.from(inspiration).slice(0, 40).join(""), description: inspiration, tags: [], source: "inspiration" }, dataDir);
    topicId = created.id;
    params = { ...params, topic_id: topicId };
  }
  if (!topicId) return fail("topic_id 必填；先查询或创建选题（或只给一句 inspiration），再准备创作。");
  // 跳过调研 / 跳过选卡的通道已关闭（选题会规则 6）：在派任何调研之前就明说
  if (str(params.skip_reason) || params.research_mode === "skip" || str(params.research_reason)) return fail(ANGLE_GATE_COPY.skipRemoved, { code: "skip_removed" });
  const readiness = await inspectWritingReadiness(topicId, readinessRequest(params), dataDir, warn);
  // 自带材料（provided）也要开选题会：还没有立意卡、也没有创始人自定角度时，同样派宿主调研出卡
  const providedNeedsCards = readiness.research.mode === "provided" && readiness.status === "needs_angle"
    && readiness.angle.cards.length === 0 && readiness.angle.status === "missing" && !str(params.direction);
  if (params.execution !== "engine" && ((readiness.research.mode === "auto" && !["ready_to_write", "needs_angle"].includes(readiness.status)) || providedNeedsCards)) {
    const task = await executeScout(scoutPrepareParams({ ...readiness.continue_params, _host: params._host }, dataDir));
    if (task.ok === false) return { ...task, ok: false, error: String(task.error ?? "宿主调研任务准备失败"), status: "needs_attention", preparation: readiness };
    return { ok: true, status: "awaiting_host_research", topic_id: topicId, preparation: readiness, creative_task: task.creative_task,
      ...(providedNeedsCards ? { provided_material_note: "创作者自带的材料：能抓的网址用 scout read_page + cite 核验；只有原话的用 claim_offline 登记成未核验陈述，再照常出卡。" } : {}),
      research_task: task, executed_by: { kind: "host", host: params._host ?? "local-user" }, model_api_calls: 0,
      // 本阶段任务包已在 research_task.pack：下一步直接是按它提交，不必再领一次 scout pack（P6 §3.7）
      next_action: (task.pack as { submit?: unknown } | undefined)?.submit ?? { tool: "autocrew_scout", params: { action: "pack", topic_id: topicId, task_id: task.task_id } },
      note: "已准备当前宿主的调研/立意任务，本阶段任务包就在 research_task.pack；后台没有模型在运行。照它完成来源读取与分析，按 next_action 提交，不要轮询等待或直接裸写。" };
  }
  if (readiness.status !== "not_started") {
    return { ok: true, ...readiness, ...(readiness.status === "researching" ? { poll_after_seconds: 30 } : {}) };
  }
  const started = await doResearch({ ...readiness.continue_params, topic_id: topicId, kind: "full", execution: "engine" }, dataDir, deps, warn);
  if (!started.ok) {
    if (started.inFlight) {
      return { ok: true, ...readiness, status: "researching", research: { ...readiness.research, status: "running" }, poll_after_seconds: 30, note: "调研正在进行；请说明进度，并按间隔继续 prepare。" };
    }
    return { ok: false, ...readiness, status: "needs_attention", error: started.error, note: `尚未完成调研：${started.error}`, next_action: { tool: "autocrew_workflow", params: { ...readiness.continue_params, action: "research", kind: "full" } } };
  }
  return {
    ok: true, ...readiness, status: "researching", poll_after_seconds: 30,
    research: { ...readiness.research, status: "running", job: started.job },
    note: "已启动调研，尚未完成；先告知创作者正在查什么和准备立意，按间隔继续 prepare，不能直接写成稿。",
  };
}

// ─── status ───────────────────────────────────────────────────────────────────

async function doStatus(
  params: Record<string, unknown>,
  dataDir: string,
  warn: (m: string) => void,
): Promise<WorkflowResult> {
  const topicId = str(params.topic_id);
  if (!topicId) return fail("topic_id 必填");
  const topic = await getTopic(topicId, dataDir);
  if (!topic) return fail(`选题不存在：${topicId}`);

  const job = await getJob(topicId, dataDir);
  const snap = await resolveEffectiveBrief(topicId, dataDir, warn);
  const options = snap ? angleOptionsView(snap.brief) : { cards: [] };
  const readiness = await inspectWritingReadiness(topicId, readinessRequest(params), dataDir, warn);

  const hostTask = job?.executedBy?.kind === "host" ? await inspectHostResearchTask(topicId, dataDir) : null;
  const waitingForHost = hostTask && hostTask.status !== "ready";
  return {
    ok: true,
    topicId,
    title: topic.title,
    readiness,
    next_action: waitingForHost ? { tool: "autocrew_scout", params: { action: "pack", topic_id: topicId, task_id: hostTask.taskId } } : readiness.next_action,
    ...(waitingForHost ? { status: "awaiting_host_research", research_task: { task_id: hostTask.taskId, status: hostTask.status, executed_by: { kind: "host", host: hostTask.host } }, note: "正在等待宿主继续调研；后台没有模型运行，领取scout任务继续，不要轮询空等。" } : readiness.status === "researching" ? { poll_after_seconds: 30 } : {}),
    job: job ? jobView(job) : null,
    ...(snap
      ? {
          brief: {
            revision: snap.revision,
            summary: snap.brief.summary,
            tensions: snap.brief.tensions,
            gaps: snap.brief.gaps,
            ...options,
            note: "score 只用于排序，不是推荐依据。推荐依据证据完整性，并列出缺口；由创作者选择。",
          },
        }
      : {}),
    ...(topic.selectedAngle
      ? { selectedAngle: { angleId: topic.selectedAngle.angleId, briefRevision: topic.selectedAngle.briefRevision } }
      : {}),
  };
}

// ─── select_angle ─────────────────────────────────────────────────────────────

async function doSelectAngle(
  params: Record<string, unknown>,
  dataDir: string,
  warn: (m: string) => void,
): Promise<WorkflowResult> {
  const topicId = str(params.topic_id);
  const angleId = str(params.angle_id);
  const founderWords = str(params.founder_words);
  const direction = str(params.direction);
  if (!topicId || (!angleId && !direction)) return fail("topic_id 必填，并给 angle_id（选卡）或 direction（创始人自定角度）");
  if (!founderWords) return fail(ANGLE_GATE_COPY.needFounderWords, { code: "founder_words_required" });
  const topic = await getTopic(topicId, dataDir);
  if (!topic) return fail(`选题不存在：${topicId}`);
  if (!angleId) {
    // 创始人自己给的角度：记成创始人自定角度（带原话），之后 prepare/pack 带同一句 direction
    const saved = await recordFounderAngle(topic, direction, founderWords, dataDir);
    if (!saved) return fail(`选题不存在：${topicId}`);
    return { ok: true, topic: saved, founder_angle: saved.founderAngle, ...(await inspectWritingReadiness(topicId, readinessRequest({ ...params, direction }), dataDir, warn)) };
  }

  // 唯一「当前有效简报」入口（P1 §3.0）：认台账指针，不认磁盘最大版
  const snap = await resolveEffectiveBrief(topicId, dataDir, warn);
  if (!snap) return fail(NO_BRIEF);
  if (snap.brief.topicHash !== topicHashOf(topic.title, topic.description)) {
    return fail("选题已变化，旧立意候选已过期；请先 prepare 刷新调研。");
  }
  const claimed = params.brief_revision;
  if (claimed === undefined) {
    return fail(`brief_revision 必填：带上你读到这批候选时的版本（当前 v${snap.revision}），不按当前简报静默落选。`, {
      code: "brief_revision_required", current_brief_revision: snap.revision, angles: (snap.brief.angleCards ?? []).map((c) => c.id),
    });
  }
  if (claimed !== snap.revision) {
    return fail(`角度候选已更新（当前 v${snap.revision}，你手上是 v${String(claimed)}）——重新 status 一次再选`);
  }
  const original = findAngleCard(snap.brief, angleId);
  if (!original) return fail(`角度 ${angleId} 不在简报 v${snap.revision} 里`);

  // 没给 card = 点选原卡；给了 = 改写版（改写才是创始人观点进管线的口子，客户端 score 一律丢弃重算）
  const card = params.card === undefined ? original : parseAngleCard(params.card, snap.brief, angleId);
  if (typeof card === "string") return fail(card);
  const updated = await updateTopic(
    topicId,
    { selectedAngle: { briefRevision: snap.revision, angleId, card, selectedAt: new Date().toISOString(), chosenBy: "founder", founderWords } },
    dataDir,
  );
  if (!updated) return fail(`选题不存在：${topicId}`);
  // 选完直接给下一步（P6 §3.7）：与再调一次 prepare 同一份就绪检查，ready_to_write 时 next_action 就是 writer pack
  return { ok: true, topic: updated, ...(await inspectWritingReadiness(topicId, readinessRequest(params), dataDir, warn)) };
}

// ─── write ────────────────────────────────────────────────────────────────────

/** Shared preparation gate; direction never silently bypasses research. */
export async function angleGate(
  topicId: string,
  req: ScriptRequest,
  dataDir: string,
  warn: (m: string) => void,
): Promise<WorkflowFail | null> {
  const readiness = await inspectWritingReadiness(topicId, req, dataDir, warn);
  if (readiness.ready) return null;
  return writingReadinessFailure(readiness);
}

async function doWrite(
  params: Record<string, unknown>,
  dataDir: string,
  deps: WorkflowDeps,
  warn: (m: string) => void,
): Promise<WorkflowResult> {
  const topicId = str(params.topic_id);
  if (!topicId) return fail("topic_id 必填");
  if (params._host && params.execution !== "engine") {
    return fail("MCP 默认由当前宿主写稿；请先 prepare 备好材料与立意，再领取 writer pack。只有用户明确要求后台代写时才传 execution=engine。", {
      code: "host_writer_preferred",
      next_action: { tool: "autocrew_workflow", params: { topic_id: topicId, ...Object.fromEntries(Object.entries(params).filter(([key]) => ["platform", "requirements", "direction", "skip_reason", "research", "research_mode", "research_reason"].includes(key))), action: "prepare" } },
    });
  }
  const platform = str(params.platform);
  if (!platform) return fail(`platform 必填。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}`);
  if (!(CLIPBOARD_PLATFORMS as readonly string[]).includes(platform)) {
    return fail(`无效 platform「${platform}」。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}`);
  }
  const topic = await getTopic(topicId, dataDir);
  if (!topic) return fail(`选题不存在：${topicId}`);

  const direction = typeof params.direction === "string" ? params.direction : "";
  const requirements = typeof params.requirements === "string" ? params.requirements : "";
  const skipReason = str(params.skip_reason);
  const req: ScriptRequest = {
    ...readinessRequest(params),
    topic: topic.title,
    topicDescription: topic.description,
    platform: platform as ClipboardPlatform,
    topicId,
    ...(direction ? { direction } : {}),
    ...(requirements ? { requirements } : {}),
    ...(skipReason ? { angleSkipReason: skipReason } : {}),
  };

  const refused = await newDraftGate(topicId, req, dataDir, warn);
  if (refused) return refused as WorkflowResult;
  const gated = await angleGate(topicId, req, dataDir, warn);
  if (gated) return gated;

  const start = deps.startGenerateScriptImpl ?? startGenerateScript;
  const started = await start(req, dataDir);
  return {
    ok: true,
    contentId: started.contentId,
    started: true,
    note: "写作已在后台开始（通常 15–30 分钟）。用 draft{content_id} 轮询，status=drafting 就是还在写——不要编造成稿内容。",
  };
}

// ─── draft ────────────────────────────────────────────────────────────────────

async function doDraft(params: Record<string, unknown>, dataDir: string): Promise<WorkflowResult> {
  const contentId = str(params.content_id);
  if (!contentId) return fail("content_id 必填");
  const content = await getContent(contentId, dataDir);
  if (!content) return fail(`稿件不存在：${contentId}`);
  if (content.status === "drafting") {
    // 「谁欠这一稿」不能只有一种说法（P3 §5.3）：包发出去了没回稿，说成「还在后台写」
    // 就是让人对着一张永远不动的卡等一个不存在的后台任务
    return { ok: true, contentId, status: "drafting", note: draftingNote(content), ...draftOwnerView(content) };
  }
  return { ok: true, ...draftView(content) };
}

// ─── doctor ───────────────────────────────────────────────────────────────────

/** engine.json 缺席 + 环境变量有 key 时的处置：默认只给建议，`AUTOCREW_SEED_ENGINE=1` 才落盘 */
async function engineSeed(dataDir: string, hints: string[]): Promise<Record<string, unknown>> {
  const filePath = path.join(getConfigDir(dataDir), "engine.json");
  if (await fs.access(filePath).then(() => true, () => false)) return {};
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return {};
  // v2 形状（一张端点表 + main 指针）；v1 的老文件仍然读得动，但新写的一律是 v2
  const minimal = {
    version: 2,
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek 官方",
        baseUrl: ENGINE_DEFAULTS.baseUrl,
        apiKey: "<你的 DEEPSEEK_API_KEY>",
        models: [ENGINE_DEFAULTS.strongModel, ENGINE_DEFAULTS.fastModel],
      },
    ],
    main: { provider: "deepseek", strong: ENGINE_DEFAULTS.strongModel, fast: ENGINE_DEFAULTS.fastModel },
  };
  if (process.env.AUTOCREW_SEED_ENGINE !== "1") {
    hints.push(
      `${filePath} 不存在，引擎现在靠环境变量 DEEPSEEK_API_KEY 顶着。建议手写一份：${JSON.stringify(minimal)}` +
        "（本工具不替你写；确实要它代写就设 AUTOCREW_SEED_ENGINE=1 再跑一次 doctor）",
    );
    return { engineSeedHint: filePath };
  }
  await fs.mkdir(dataDir, { recursive: true });
  const seeded = { ...minimal, providers: [{ ...minimal.providers[0], apiKey: key }] };
  await fs.writeFile(filePath, JSON.stringify(seeded, null, 2) + "\n", "utf-8");
  await fs.chmod(filePath, 0o600).catch(() => {}); // key 文件收权限，非 posix 环境失败不阻断
  hints.push(`已按 AUTOCREW_SEED_ENGINE=1 写入 ${filePath}（apiKey 取自环境变量，不回显）`);
  return { engineSeeded: filePath };
}

/**
 * `probe: true`（P2 spec §4.1）：真去每个端点发一次极小调用，返回与桌面 `engine:health`
 * **同一个视图函数**的输出——桌面与 dsh 看的是同一份事实，不分叉。
 * 默认不出网（dsh 契约不变）：doctor 是「配没配好」，不是「网通不通」。
 */
async function doctorHealth(dataDir: string, probe: boolean) {
  if (probe) await probeAllProviders(dataDir);
  return buildEngineHealth(dataDir);
}

async function doDoctor(dataDir: string, opts: { probe?: boolean } = {}): Promise<WorkflowResult> {
  const hints: string[] = [];
  let engine: Record<string, unknown> = { configured: false };
  try {
    const cfg = await loadEngineConfig(dataDir);
    engine = {
      configured: true,
      strongModel: cfg.strongModel,
      ...(cfg.assignments?.writer ? { writerRoute: cfg.assignments.writer.model } : {}),
    };
  } catch (err) {
    hints.push(errText(err));
  }
  const searchConfigured = await searchAvailable(dataDir);
  if (!searchConfigured) hints.push(SEARCH_NOT_CONFIGURED);
  const seed = await engineSeed(dataDir, hints);
  const health = await doctorHealth(dataDir, opts.probe === true);
  return { ok: true, engine, search: { configured: searchConfigured }, dataDir, hints, health, ...seed };
}

// ─── Entry ────────────────────────────────────────────────────────────────────

export async function executeWorkflow(
  params: Record<string, unknown>,
  deps: WorkflowDeps = {},
): Promise<WorkflowResult> {
  const dataDir = getDataDir((params._dataDir as string) || undefined);
  const warn = deps.onWarn ?? ((m: string) => console.warn(`[workflow] ${m}`));
  const action = str(params.action);
  const history = await historyGuard(params.content_id, dataDir);
  if (history) return history;
  try {
    switch (action) {
      case "prepare":
        return await doPrepare(params, dataDir, deps, warn);
      case "research":
        return await doResearch(params, dataDir, deps, warn);
      case "status":
        return await doStatus(params, dataDir, warn);
      case "select_angle":
        return await doSelectAngle(params, dataDir, warn);
      case "write":
        return await doWrite(params, dataDir, deps, warn);
      case "draft":
        return await doDraft(params, dataDir);
      case "doctor":
        return await doDoctor(dataDir, { probe: params.probe === true });
      default:
        return fail(`未知 action：${action || "(空)"}。支持：${ACTIONS.join(" | ")}`);
    }
  } catch (err) {
    // 意料之外的故障也照实说，绝不假装成功（dsh 桥靠 ok:false 才把这轮标成失败）
    const storage = storageFailure(err);
    if (storage) return storage;
    return fail(`${action || "workflow"} 执行失败：${errText(err)}`);
  }
}
