import { loadSeriesSnapshot } from "../modules/writing/series-memory.js";
import { techniqueCatalog } from "../modules/writing/technique-store.js";
/** Host-driven research desk: deterministic fetching, validation and storage, never an LLM call. */
import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getDataDir, getTopic } from "../storage/local-store.js";
import { createCreativeTask, creativeTaskHash, renderCreativeTask } from "../modules/writing/creative-task.js";
import { loadProfile } from "../modules/profile/creator-profile.js";
import {
  buildAngleSystemPrompt,
  buildAngleUserMessage,
  validateAngles,
  SUBMIT_SCHEMA as ANGLE_SCHEMA,
} from "../modules/research/angle-stage.js";
import {
  BRIEF_SCHEMA_VERSION,
  evidenceByRef,
  loadBrief,
  nextBriefRevision,
  saveBrief,
} from "../modules/research/brief-store.js";
import {
  buildSystemPrompt,
  buildPerspectiveUserMessage,
  submitSchema,
  validatePerspective,
} from "../modules/research/research-perspectives.js";
import {
  buildSynthesisUserMessage,
  validateBrief,
  SUBMIT_SCHEMA as SYNTHESIS_SCHEMA,
} from "../modules/research/research-synthesis.js";
import { collectOwnMaterial } from "../modules/research/own-material.js";
import {
  createResearchBroker,
  type ResearchBroker,
  type ResearchBrokerDeps,
} from "../modules/research/research-broker.js";
import {
  HostResearchError,
  withHostResearchLock,
  type HostResearchTask,
  type HostCitation,
  type HostOfflineClaim,
} from "../modules/research/host-research-store.js";
import {
  PERSPECTIVE_NAMES,
  getJob,
  topicHashOf,
  upsertJob,
  type PerspectiveName,
} from "../modules/research/research-job-store.js";
import type { LedgerEntry } from "../modules/research/evidence-ledger.js";
import { attachContentEvidence, routeContentEvidence } from "./scout-content-evidence.js";
import { holdTask, taskChangedError } from "./scout-task-guard.js";
import { DeferredPageRead, finishPageRead, renderPage, reservePageRead } from "./scout-read-page.js";
import { storageFailure } from "../storage/storage-error.js";
import {
  WHY_MAY_PERFORM_SCHEMA, buildAccountData, checkPerspectiveAccess, claimPerspective, failPerspective,
  missingForSynthesis, perspectiveState, perspectivesView, readWhyMayPerform, settlePerspective,
} from "./scout-parallel.js";

export const SCOUT_DESCRIPTION =
  "Host-driven research; all analysis uses the current conversation model, never a configured LLM API. prepare/pack freezes the complete task and returns task_id + role instructions. search is optional; use host search then read_page{url} when no search key is configured. cite accepts only exact quotes from server-fetched pages. claim_offline explicitly records an unverified user_claim with a reason, never a fallback that pretends research succeeded. Parallel: claim{perspective} issues a perspective_token per perspective so sub-agents work concurrently (same perspective twice: perspective_claimed; idle 30 min: timed_out, re-claimable); fail_perspective{reason} records a visible failure to re-run. The 5th route, account data, is built deterministically (account_data re-runs it). synthesize needs all 5; angles = 3-4 cards each with why_may_perform. Every research action after prepare requires topic_id/task_id; the one exception is claim_offline with content_id+pack_id and no task_id (provided/skip writing has no research task): it registers a number derived from the user's material as user_claim user-<n> in that draft's ledger, reason required. A manual_import draft in draft_ready has no pack: cite/claim_offline take content_id alone for it. Changed requirements never silently replace a task: prepare returns task_changed{diff, keep_current} until you confirm with confirm_task_change:true. Another host's in-flight task can be taken over only after 30 idle minutes (else task_owned); the displaced owner's late writes get lease_lost. Up to 4 read_page calls per topic may run concurrently (5th: task_busy + retry_after_seconds); quota is charged before fetching, so a failed fetch still uses its slot. cite/claim_offline can attach evidence to matching content_id/pack_id (plus claim_token when the draft is claimed, same host included, else claim_held); the per-content 12-item lifetime quota survives force reissues. Changed tasks reject old submissions.";
const text = Type.String();
const actions = [
  "prepare",
  "pack",
  "status",
  "search",
  "read_page",
  "cite",
  "claim_offline",
  "perspective",
  "synthesize",
  "angles",
  "claim",
  "fail_perspective",
  "account_data",
] as const;
export const scoutSchema = Type.Object(
  {
    action: Type.Union(actions.map((v) => Type.Literal(v))),
    topic_id: text,
    task_id: Type.Optional(Type.String({ description: "prepare 之后的研究动作必填；claim_offline 带 content_id+pack_id 往稿里登记推算数时不带" })),
    platform: Type.Optional(text),
    requirements: Type.Optional(text),
    direction: Type.Optional(text),
    force: Type.Optional(Type.Boolean()),
    confirm_task_change: Type.Optional(
      Type.Boolean({ description: "prepare：要求与当前任务不同时，确认按新要求新建任务（先向创作者说明 task_changed 的 diff）" }),
    ),
    perspective: Type.Optional(Type.Union(PERSPECTIVE_NAMES.map((v) => Type.Literal(v)))),
    query: Type.Optional(text),
    url: Type.Optional(text),
    source_id: Type.Optional(text),
    claim: Type.Optional(text),
    quote: Type.Optional(text),
    reason: Type.Optional(text),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "read_page：沿用next_offset；按消毒后的Unicode字符计数，避免拆断表情符号",
      }),
    ),
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    perspective_token: Type.Optional(Type.String({ description: "claim 发的视角令牌；子代理做这个视角的 search/read_page/cite/perspective/fail_perspective 都带上" })),
    content_id: Type.Optional(text),
    pack_id: Type.Optional(text),
    claim_token: Type.Optional(
      Type.String({
        description:
          "cite/claim_offline 带 content_id+pack_id 往稿里补证时：这篇有活认领就必须带（writer pack 回的令牌），同宿主的另一个会话也一样",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface ScoutDeps {
  brokerDeps?: Omit<ResearchBrokerDeps, "snapshot" | "dataDir" | "beforeNetwork">;
  collectOwnMaterialImpl?: typeof collectOwnMaterial;
}
const digest = (value: unknown) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify(value, (_key, v: unknown) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      ),
    )
    .digest("hex");
const str = (v: unknown) => (typeof v === "string" ? v : "");
const nonempty = (v: unknown, name: string) => {
  const s = str(v);
  if (!s.trim()) throw new HostResearchError("missing_argument", `${name} 必填`);
  return s;
};
/** 带 perspective 参数、受视角令牌约束的动作 */
const PERSPECTIVE_SCOPED = new Set(["search", "read_page", "perspective", "fail_perspective"]);
function perspectiveOf(value: unknown): PerspectiveName {
  if (!(PERSPECTIVE_NAMES as readonly unknown[]).includes(value))
    throw new HostResearchError("invalid_perspective", "perspective 必须是 audience/evidence/counter/benchmark");
  return value as PerspectiveName;
}

/** 下一阶段的提交入口：任务书已随回执的 pack 字段带回，不再让宿主为了拿任务书多跑一次 pack */
function nextStageTarget(task: HostResearchTask, missing: PerspectiveName[]) {
  // 并行：缺的视角各自 claim 发令牌派给子代理；只剩账号数据没齐就单独重跑它
  const open = missing.filter((n) => perspectiveState(task, n) !== "claimed");
  if (open[0]) return target(task, "claim", { perspective: open[0] });
  if (missing[0]) return target(task, "status");
  if (task.accountData?.status !== "ok") return target(task, "account_data");
  if (!task.brief) return target(task, "synthesize");
  return target(task, "angles");
}


function target(task: HostResearchTask, action: string, extra: Record<string, unknown> = {}) {
  return { tool: "autocrew_scout", params: { action, topic_id: task.topicId, task_id: task.taskId, ...extra } };
}
function view(task: HostResearchTask): Record<string, unknown> {
  const missing = PERSPECTIVE_NAMES.filter((name) => !task.perspectives[name]);
  return {
    ok: true,
    task_id: task.taskId,
    topic_id: task.topicId,
    status: task.status,
    executedBy: { kind: "host", host: task.host },
    creative_task: task.creativeTask,
    creative_task_hash: creativeTaskHash(task.creativeTask),
    brief_revision: task.briefRevision,
    perspectives: perspectivesView(task),
    sources: task.broker.sources.map(([, e]) => e.source),
    unverified_claims: task.offlineClaims,
    next_action:
      task.status === "ready"
        ? {
            tool: "autocrew_workflow",
            params: {
              action: "prepare",
              topic_id: task.topicId,
              ...Object.fromEntries(Object.entries(task.creativeTask).filter(([k]) => k !== "version")),
            },
          }
        : nextStageTarget(task, missing),
    note:
      task.status === "ready"
        ? "本轮研究由当前宿主分析，来源和引文由工具核验；未调用后台模型。未核验材料仍按 user_claim 标注。"
        : "等待当前宿主完成研究分析；此任务不会在后台自行调用模型。下一阶段的任务书在本回执的 pack 字段里（status 不带 pack，先调 pack 取），读完直接按 next_action 提交。",
  };
}
function brokerWithClaims(broker: ResearchBroker, task: HostResearchTask): ResearchBroker {
  return {
    ...broker,
    getSource: (id) =>
      broker.getSource(id) ??
      (task.offlineClaims.some((c) => c.id === id)
        ? { sourceId: id, kind: "user_claim", url: "", fetchedAt: task.createdAt }
        : null),
  };
}
async function promptPack(
  task: HostResearchTask,
  broker: ResearchBroker,
  perspective?: PerspectiveName,
  dataDir?: string,
): Promise<Record<string, unknown>> {
  const common = {
    topic: task.topic,
    creativeTask: task.creativeTask,
    profile: task.profile,
    ownMaterial: task.ownMaterial,
    broker,
  };
  const missing = PERSPECTIVE_NAMES.filter((name) => !task.perspectives[name]);
  if (perspective || missing.length) {
    const name = perspective ?? missing[0];
    return {
      stage: "perspective",
      perspective: name,
      system: `${buildSystemPrompt(name)}\n你是当前宿主，不要另开后台模型。scout.read_page 可直接读取宿主搜索得到的URL。u开头来源是明确未核验的用户陈述：可以作为待核查线索，不能放入evidence或说成已核验。来源不足如实记录gaps，不自动创建离线声明来冒充联网成功。合法提交仍需至少3条有来源的洞察；若完全无材料，保留失败与缺口，说明需要补资料或由用户明确选择provided/skip路径，不编洞察。`,
      user: buildPerspectiveUserMessage({ ...common, name }),
      offline_claims: task.offlineClaims,
      submit_schema: submitSchema(name),
      submit: target(task, "perspective", { perspective: name }),
    };
  }
  if (task.accountData?.status !== "ok")
    return {
      stage: "account_data",
      note: `账号数据视角${task.accountData ? `失败：${task.accountData.reason}` : "还没生成"}。调 account_data 重跑（确定性、不调模型）；五路齐了才能综合。`,
      submit: target(task, "account_data"),
    };
  if (!task.brief)
    return {
      stage: "synthesis",
      system:
        "综合已提交的四路视角，按统一创作任务书整理事实、分歧和缺口。此阶段仅合成材料，不必给angle_suggestions；angle_cards 下一阶段再交。evidence只能使用read_page逐字核验的来源；明确未核验的陈述仅列 offline_claim_ids，不得混入evidence。不要编造来源。",
      user: buildSynthesisUserMessage({
        ...common,
        perspectiveResults: PERSPECTIVE_NAMES.map((n) => task.perspectives[n]!),
      }),
      offline_claims: task.offlineClaims,
      submit_schema: {
        ...SYNTHESIS_SCHEMA,
        required: SYNTHESIS_SCHEMA.required.filter((k) => k !== "angle_cards" && k !== "angle_suggestions"),
        properties: {
          ...SYNTHESIS_SCHEMA.properties,
          offline_claim_ids: { type: "array", items: { type: "string" } },
          gaps: { type: "array", items: { type: "string" } },
        },
      },
      submit: target(task, "synthesize"),
    };
  const angleSchema = ANGLE_SCHEMA as { properties: { candidates: { items: { required?: string[]; properties?: Record<string, unknown> } } } };
  const cardSchema = angleSchema.properties.candidates.items;
  return {
    stage: task.status === "ready" ? "complete" : "angles",
    account_data: task.accountData?.summary ?? "",
    system: `${buildAngleSystemPrompt(task.profile, task.creativeTask)}\n选题会规则：出 3–4 张卡，每张写 why_may_perform——只引下面「账号数据」里的数字（带 n），没有可用数据就照写「无数据依据」，不凭印象。开头钩子里的事实必须来自已 cite 的原文。`,
    // 立意阶段就给系列快照和手法目录（spec §3 C）：换骨架要在生成候选卡时发生，只换写作包菜单不够
    user: buildAngleUserMessage({
      ...common, brief: task.brief,
      ...(dataDir ? { series: await loadSeriesSnapshot(task.creativeTask?.platform ?? "", { topicId: task.topicId }, dataDir), techniques: await techniqueCatalog(dataDir) } : {}),
    }),
    submit_schema: { ...ANGLE_SCHEMA, properties: { ...ANGLE_SCHEMA.properties, candidates: { ...angleSchema.properties.candidates, items: {
      ...cardSchema, required: [...(cardSchema.required ?? []), "why_may_perform"], properties: { ...cardSchema.properties, why_may_perform: WHY_MAY_PERFORM_SCHEMA },
    } } } },
    submit: target(task, "angles"),
  };
}
async function assertTopic(task: HostResearchTask, dir: string): Promise<void> {
  const topic = await getTopic(task.topicId, dir);
  if (!topic || topic.deletedAt || topicHashOf(topic.title, topic.description) !== task.topicHash)
    throw new HostResearchError("task_stale", "选题已变化或删除；旧研究结果未采纳，请按最新要求重新 prepare");
}
async function guardEngine(topicId: string, dir: string): Promise<void> {
  const job = await getJob(topicId, dir);
  if (job && ["queued", "running"].includes(job.status) && job.executedBy?.kind !== "host")
    throw new HostResearchError(
      "engine_research_in_flight",
      "后台引擎研究仍在进行，不能接管并伪造其完成；等该轮结束后再准备宿主研究",
    );
}
async function publish(
  task: HostResearchTask,
  save: (t: HostResearchTask) => Promise<void>,
  dir: string,
): Promise<void> {
  if (!task.brief) throw new HostResearchError("missing_synthesis", "先提交事实综合");
  await assertTopic(task, dir);
  await guardEngine(task.topicId, dir);
  if (!task.briefRevision) {
    task.briefRevision = await nextBriefRevision(task.topicId, dir);
    task.brief.revision = task.briefRevision;
    await save(task); // crash recovery reserves the exact immutable revision
  }
  const prior = await loadBrief(task.topicId, task.briefRevision, dir);
  if (prior && digest(prior) !== digest(task.brief))
    throw new HostResearchError("brief_revision_conflict", "简报版本已由另一任务占用，未覆盖；请重建本次任务");
  if (!prior) await saveBrief(task.topicId, task.brief, dir);
  await upsertJob(
    {
      topicId: task.topicId,
      status: "succeeded",
      startedAt: task.createdAt,
      settledAt: new Date().toISOString(),
      perspectives: PERSPECTIVE_NAMES.map((name) => ({ name, status: "succeeded" })),
      briefRevision: task.briefRevision,
      topicHash: task.topicHash,
      creativeTask: task.creativeTask,
      executedBy: { kind: "host", host: task.host },
    },
    dir,
  );
  task.status = "ready";
  await save(task);
}

/** 研究任务补证入稿：条目号按内容摘要定（`ev-H…`）；检查、写门与额度走稿件台账的同一入口 */
async function attachEvidence(
  task: HostResearchTask,
  evidence: HostCitation | HostOfflineClaim,
  args: Record<string, unknown>,
  dir: string,
): Promise<Record<string, unknown>> {
  const contentId = str(args.content_id),
    packId = str(args.pack_id);
  if (!contentId && !packId) return {};
  // 导入稿（§13.4-B）没有写作包，只带 content_id；是不是导入稿由台账入口核定
  if (!contentId) throw new HostResearchError("missing_pack", "补证入稿需要同时提供content_id和pack_id");
  const key = digest({
    source: evidence.source,
    quote: evidence.quote,
    claim: evidence.claim,
    sourceUrl: "sourceUrl" in evidence ? evidence.sourceUrl : "",
  });
  const entry: LedgerEntry = {
    id: `ev-H${key.slice(0, 20)}`,
    source: evidence.source,
    quote: evidence.quote,
    claim: evidence.claim,
    ...(evidence.source === "verified_quote" ? { sourceId: evidence.sourceId, sourceUrl: evidence.sourceUrl } : {}),
  };
  const target = { contentId, packId, topicId: task.topicId, host: task.host, claimToken: str(args.claim_token), dir };
  return attachContentEvidence(target, () => entry);
}

export async function executeScout(
  params: Record<string, unknown>,
  deps: ScoutDeps = {},
): Promise<Record<string, unknown>> {
  const args = Object.fromEntries(Object.entries(params).filter(([key]) => !key.startsWith("_")));
  if (!Value.Check(scoutSchema, args))
    return { ok: false, code: "invalid_arguments", error: "scout 参数不符合契约，请按工具 schema 调用" };
  const dir = getDataDir(str(params._dataDir) || undefined);
  const host = str(params._host) || "local-user";
  const topicId = str(args.topic_id),
    action = str(args.action);
  let viaToken = false;
  try {
    const outcome = await withHostResearchLock(topicId, dir, async (current, save): Promise<Record<string, unknown> | DeferredPageRead> => {
      if (args.task_id && args.task_id !== current?.taskId)
        throw new HostResearchError("stale_task", "task_id 已过期，迟到结果未采纳；请读取当前任务并沿用新任务号");
      if (action === "prepare" || action === "pack") {
        const topic = await getTopic(topicId, dir);
        if (!topic || topic.deletedAt) throw new HostResearchError("topic_missing", "选题不存在或已删除");
        await guardEngine(topicId, dir);
        const taskRequest = {
          ...(typeof args.platform === "string" ? { platform: args.platform } : {}),
          ...(typeof args.requirements === "string" ? { requirements: args.requirements } : {}),
          ...(typeof args.direction === "string" ? { direction: args.direction } : {}),
        };
        const creativeTask = createCreativeTask(taskRequest, current?.creativeTask);
        const topicHash = topicHashOf(topic.title, topic.description);
        const same =
          current &&
          current.topicHash === topicHash &&
          creativeTaskHash(current.creativeTask) === creativeTaskHash(creativeTask);
        // 在途任务：持有者闲置满 30 分钟才可接管（接管当场落盘）；要求变了先让宿主确认，不静默换任务
        if (current && current.status !== "ready" && (await holdTask(current, host, dir))) await save(current);
        const confirmed = args.force === true || args.confirm_task_change === true;
        if (current && !same && current.topicHash === topicHash && !confirmed) throw taskChangedError(current, creativeTask);
        let task = current;
        if (!same || args.force === true) {
          const now = new Date().toISOString();
          const broker = createResearchBroker({ ...deps.brokerDeps, dataDir: dir });
          task = {
            version: 1,
            taskId: `rt-${crypto.randomUUID()}`,
            host,
            topicId,
            topicHash,
            topic: { title: topic.title, description: topic.description },
            creativeTask,
            status: "researching",
            createdAt: now,
            updatedAt: now,
            broker: broker.snapshot(),
            profile: await loadProfile(dir),
            ownMaterial: await (deps.collectOwnMaterialImpl ?? collectOwnMaterial)(dir, {
              id: topicId,
              title: topic.title,
              description: [topic.description, renderCreativeTask(creativeTask)].join("\n"),
            }),
            perspectives: {},
            accountData: await buildAccountData(dir),
            citations: [],
            offlineClaims: [],
            submissionHashes: {},
          };
          await save(task);
          const oldJob = await getJob(topicId, dir);
          await upsertJob(
            {
              topicId,
              status: "running",
              startedAt: now,
              topicHash,
              creativeTask,
              executedBy: { kind: "host", host },
              perspectives: PERSPECTIVE_NAMES.map((name) => ({ name, status: "pending" })),
              ...(oldJob?.briefRevision ? { briefRevision: oldJob.briefRevision } : {}),
            },
            dir,
          );
        }
        if (!task) throw new HostResearchError("task_missing", "请先 prepare");
        const job = await getJob(topicId, dir);
        if (task.status !== "ready" && (!job || job.startedAt < task.createdAt)) {
          await upsertJob(
            {
              topicId,
              status: "running",
              startedAt: task.createdAt,
              topicHash: task.topicHash,
              creativeTask: task.creativeTask,
              executedBy: { kind: "host", host: task.host },
              perspectives: PERSPECTIVE_NAMES.map((name) => ({
                name,
                status: task!.perspectives[name] ? "succeeded" : "pending",
              })),
              ...(job?.briefRevision ? { briefRevision: job.briefRevision } : {}),
            },
            dir,
          );
        }
        const broker = createResearchBroker({ ...deps.brokerDeps, dataDir: dir, snapshot: task.broker });
        return {
          ...view(task),
          pack: await promptPack(task, broker, args.perspective ? perspectiveOf(args.perspective) : undefined, dir),
        };
      }
      // 没有研究任务时 claim_offline 可带稿件目标直接登记进稿件台账（provided/skip 写稿推算数的入口，§11）
      const routed = await routeContentEvidence(action, args, { topicId, host, dir });
      if (routed) return routed;
      if (!current || !args.task_id)
        throw new HostResearchError("task_required", "先 prepare 获取 task_id；后续每次调用须带 topic_id/task_id");
      const task = current;
      await assertTopic(task, dir);
      const suppliedTask = createCreativeTask(
        {
          ...(typeof args.platform === "string" ? { platform: args.platform } : {}),
          ...(typeof args.requirements === "string" ? { requirements: args.requirements } : {}),
          ...(typeof args.direction === "string" ? { direction: args.direction } : {}),
        },
        task.creativeTask,
      );
      // 本轮任务已冻结：带着新要求的研究动作不能把旧来源分析静默套到新任务上，回差异让宿主确认
      if (creativeTaskHash(suppliedTask) !== creativeTaskHash(task.creativeTask)) throw taskChangedError(task, suppliedTask);
      if (action === "status") return view(task);
      // 分视角认领：claim 谁都能领（这就是把视角派给并行子代理的口子）；带视角令牌的调用凭令牌授权，
      // 不再要求是整份任务的持有者；不带令牌的老路照旧走持有者检查
      const scoped = PERSPECTIVE_SCOPED.has(action) && args.perspective ? perspectiveOf(args.perspective) : undefined;
      if (action === "claim") {
        if (task.status !== "researching" || task.brief) throw new HostResearchError("stage_locked", "综合已开始，不能再领视角；要重做请 force prepare");
        const name = perspectiveOf(args.perspective);
        const token = claimPerspective(task, name, host);
        await save(task);
        const broker = createResearchBroker({ ...deps.brokerDeps, dataDir: dir, snapshot: task.broker });
        return { ...view(task), perspective: name, perspective_token: token, pack: await promptPack(task, broker, name, dir),
          note: "把 perspective_token 交给做这个视角的子代理：它的 search / read_page / cite / perspective 提交都带上令牌。做不下去就 fail_perspective 写明原因。" };
      }
      viaToken = checkPerspectiveAccess(task, scoped, str(args.perspective_token));
      if (!viaToken) await holdTask(task, host, dir);
      await guardEngine(topicId, dir);
      if (action === "fail_perspective") {
        failPerspective(task, perspectiveOf(args.perspective), nonempty(args.reason, "reason"), host);
        await save(task);
        return { ...view(task), note: "已记下这个视角失败的原因，回执里一直摆着；补上材料后重新 claim 这一个视角重跑即可，综合要五路齐。" };
      }
      if (action === "account_data") {
        if (task.brief) throw new HostResearchError("stage_locked", "综合已完成，账号数据已用于本轮；要刷新请 force prepare");
        task.accountData = await buildAccountData(dir);
        await save(task);
        return { ...view(task), ok: task.accountData.status === "ok", account_data: task.accountData,
          ...(task.accountData.status === "ok" ? {} : { code: "account_data_failed", error: task.accountData.reason }) };
      }
      const broker = createResearchBroker({
        ...deps.brokerDeps,
        dataDir: dir,
        snapshot: task.broker,
        beforeNetwork: async (snapshot) => {
          task.broker = snapshot;
          await save(task);
        },
      });
      try {
        if (action === "search") {
          const result = await broker
            .forPerspective(perspectiveOf(args.perspective))
            .search(nonempty(args.query, "query"));
          await assertTopic(task, dir);
          task.broker = broker.snapshot();
          return {
            ...view(task),
            result,
            usage: broker.usage(),
            note: "搜索结果仅是线索；引用前必须read_page，不要把摘要当作已读原文。",
          };
        }
        if (action === "read_page") {
          const source = args.source_id ? broker.getSource(str(args.source_id)) : null;
          const url = str(args.url) || source?.finalUrl || source?.url || "";
          if (!/^https?:\/\//i.test(url))
            throw new HostResearchError("invalid_url", "read_page需要有效HTTP(S) url或已登记的source_id");
          const offset = typeof args.offset === "number" ? args.offset : 0;
          // 缓存命中当场给页；没命中只在锁内预扣并记在途，出网放到锁外（收尾的 save 把扣额落盘）
          const read = reservePageRead(task, broker, perspectiveOf(args.perspective), url, offset);
          if (read instanceof DeferredPageRead) return read;
          task.broker = broker.snapshot();
          return renderPage(task, broker, read, offset, view);
        }
        if (action === "cite") {
          const sourceId = nonempty(args.source_id, "source_id"),
            claim = nonempty(args.claim, "claim"),
            quote = nonempty(args.quote, "quote");
          const check = broker.validateQuote(sourceId, quote);
          if (!check.ok)
            throw new HostResearchError(
              "quote_not_verified",
              `${check.reason}。如仅有用户陈述，应明确调用claim_offline并说明原因；不会自动降级。`,
            );
          const source = broker.getSource(sourceId)!;
          const id = `cite-${digest({ sourceId, claim, quote }).slice(0, 20)}`;
          const citation = task.citations.find((c) => c.id === id) ?? {
            id,
            sourceId,
            claim,
            quote,
            sourceUrl: source.finalUrl ?? source.url,
            fetchedAt: source.fetchedAt,
            source: "verified_quote" as const,
          };
          if (!task.citations.some((c) => c.id === id)) task.citations.push(citation);
          return {
            ...view(task),
            citation,
            claim_verification: "not_semantically_reviewed",
            ...(await attachEvidence(task, citation, args, dir)),
          };
        }
        if (action === "claim_offline") {
          const claim = nonempty(args.claim, "claim"),
            reason = nonempty(args.reason, "reason"),
            quote = str(args.quote) || claim;
          const id = `u${digest({ claim, quote, reason }).slice(0, 20)}`;
          const item = task.offlineClaims.find((c) => c.id === id) ?? {
            id,
            claim,
            quote,
            reason,
            source: "user_claim" as const,
            at: new Date().toISOString(),
          };
          if (!task.offlineClaims.some((c) => c.id === id)) {
            if (task.offlineClaims.length >= 30)
              throw new HostResearchError("claim_quota", "本轮未核验陈述已满30条，请先核验或精简材料");
            task.offlineClaims.push(item);
          }
          return {
            ...view(task),
            claim_id: item.id,
            claim: item,
            verified: false,
            ...(await attachEvidence(task, item, args, dir)),
          };
        }
        const payload = args.payload as Record<string, unknown> | undefined;
        if (!payload) throw new HostResearchError("missing_payload", "按pack返回的submit_schema提供payload");
        const name = action === "perspective" ? perspectiveOf(args.perspective) : undefined;
        const key = name ? `perspective:${name}` : action;
        const payloadHash = digest(payload);
        if (task.submissionHashes[key]) {
          if (task.submissionHashes[key] !== payloadHash)
            throw new HostResearchError(
              "stage_locked",
              "该阶段已提交另一份结果；为避免迟到结果覆盖，请force prepare建立新任务",
            );
          if (task.brief && (action === "angles" || task.creativeTask.direction?.trim()) && task.status !== "ready")
            await publish(task, save, dir);
          return { ...view(task), replayed: true };
        }
        if (task.status === "ready")
          throw new HostResearchError("task_complete", "本轮研究已经完成；修改研究结论请force prepare新任务");
        if (action === "perspective") {
          if (task.brief) throw new HostResearchError("stage_locked", "综合已完成，不能再改上游视角；请新建任务");
          const result = validatePerspective(payload, name!, brokerWithClaims(broker, task), true);
          if (!result.ok)
            return { ok: false, code: "invalid_perspective", task_id: task.taskId, problems: result.problems };
          for (const insight of result.value.insights) {
            insight.source = insight.sourceIds.every((id) => broker.getSource(id)?.kind === "page")
              ? "verified_quote"
              : "user_claim";
          }
          result.value.evidence.forEach((e) => {
            e.source = "verified_quote";
          });
          task.perspectives[name!] = result.value;
          settlePerspective(task, name!);
          task.submissionHashes[key] = payloadHash;
          const job = await getJob(topicId, dir);
          if (job?.executedBy?.kind === "host" && job.executedBy.host === host)
            await upsertJob(
              {
                ...job,
                perspectives: PERSPECTIVE_NAMES.map((n) => ({
                  name: n,
                  status: task.perspectives[n] ? "succeeded" : "pending",
                })),
              },
              dir,
            );
        } else if (action === "synthesize") {
          const missingRoutes = missingForSynthesis(task);
          if (missingRoutes.length)
            throw new HostResearchError(
              "perspectives_incomplete",
              `五路（四个调研视角 + 账号数据）还没齐：缺 ${missingRoutes.join("、")}。失败的视角重新 claim 重跑，账号数据用 account_data 重跑；没查到也要明确提交缺口，不得假装完成`,
              { missing: missingRoutes },
            );
          const outputs = PERSPECTIVE_NAMES.map((n) => task.perspectives[n]!);
          const suppliedGaps = Array.isArray(payload.gaps)
            ? payload.gaps.filter((v): v is string => typeof v === "string")
            : [];
          const checked = validateBrief(
            payload,
            { topic: task.topic, creativeTask: task.creativeTask, broker, perspectiveResults: outputs },
            [...outputs.flatMap((p) => p.gaps), ...suppliedGaps],
            { deferAngles: true },
          );
          if (!checked.ok)
            return { ok: false, code: "invalid_synthesis", task_id: task.taskId, problems: checked.problems };
          const offlineIds = Array.isArray(payload.offline_claim_ids) ? payload.offline_claim_ids : [];
          if (offlineIds.some((id) => typeof id !== "string" || !task.offlineClaims.some((c) => c.id === id)))
            throw new HostResearchError("unknown_claim", "offline_claim_ids包含未登记的未核验陈述");
          const facts = checked.value;
          for (const e of facts.evidence) {
            const source = broker
              .listSources()
              .find(
                (s) =>
                  s.kind === "page" &&
                  (s.finalUrl ?? s.url) === e.sourceUrl &&
                  broker.validateQuote(s.sourceId, e.quote).ok,
              );
            if (!source) throw new HostResearchError("source_mismatch", "综合证据的来源与已读原文不一致");
            const sourceId = source.sourceId;
            Object.assign(e, { source: "verified_quote", sourceId, fetchedAt: source.fetchedAt });
          }
          for (const id of [...new Set(offlineIds)]) {
            const c = task.offlineClaims.find((v) => v.id === id)!;
            facts.evidence.push({
              claim: c.claim,
              quote: c.quote,
              sourceUrl: "",
              sourceId: c.id,
              source: "user_claim",
            });
            facts.gaps.push(`未核验陈述 ${c.id}：${c.reason}；不得表述为已查证事实`);
          }
          task.brief = {
            schemaVersion: BRIEF_SCHEMA_VERSION,
            ...facts,
            creativeTask: task.creativeTask,
            executedBy: { kind: "host", host },
            perspectives: outputs,
            ownMaterialRefs: task.ownMaterial.refs,
            missingPerspectives: [],
            generatedAt: new Date().toISOString(),
            revision: 0,
            topicHash: task.topicHash,
          };
          task.status = "needs_angles";
          task.submissionHashes[key] = payloadHash;
          if (task.creativeTask.direction?.trim()) await publish(task, save, dir);
        } else if (action === "angles") {
          if (!task.brief)
            throw new HostResearchError("missing_synthesis", "先提交综合，角度必须基于同一份已核验的材料快照");
          const checked = validateAngles(payload, task.brief, task.ownMaterial);
          if (!checked.ok)
            return { ok: false, code: "invalid_angles", task_id: task.taskId, problems: checked.problems };
          const why = readWhyMayPerform(payload, checked.value.cards.length);
          checked.value.cards.forEach((card, i) => { (card as { whyMayPerform?: string }).whyMayPerform = why[i]; });
          for (const card of checked.value.cards) {
            if (
              card.evidenceLevel === "grounded" &&
              card.coreEvidenceIds.some((id) => evidenceByRef(task.brief!.evidence, id)?.source === "user_claim")
            )
              throw new HostResearchError(
                "unverified_grounding",
                "grounded立意不能依赖user_claim；请核验来源或明确使用overview并列出缺口",
              );
          }
          task.brief.angleCards = checked.value.cards;
          task.submissionHashes[key] = payloadHash;
          await publish(task, save, dir);
        }
        return { ...view(task), ...(view(task).status !== "ready" ? { pack: await promptPack(task, broker, undefined, dir) } : {}) };
      } finally {
        task.broker = broker.snapshot();
        await save(task);
      }
    });
    if (!(outcome instanceof DeferredPageRead)) return outcome;
    return await finishPageRead(outcome, {
      topicId, dir, host, viaToken, ...(viaToken ? { perspectiveToken: str(args.perspective_token) } : {}), brokerDeps: deps.brokerDeps, view, assertTopic: (task) => assertTopic(task, dir),
    });
  } catch (err) {
    const storage = storageFailure(err);
    if (storage) return storage;
    return {
      ok: false,
      code: err instanceof HostResearchError ? err.code : "research_operation_failed",
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof HostResearchError ? err.details : {}),
      note: "操作失败已如实返回；未调用备用模型，也未把来源自动降为离线声明。",
    };
  }
}
