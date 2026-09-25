/** Host-driven research desk: deterministic fetching, validation and storage, never an LLM call. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getContent, getDataDir, getTopic, updateContent } from "../storage/local-store.js";
import { gateClaimWrite, type ClaimDenial } from "../storage/claims.js";
import { writeJsonAtomic, writeTextAtomic } from "../storage/json-atomic.js";
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
import { restoreEvidenceLedger, type LedgerEntry } from "../modules/research/evidence-ledger.js";
import { externalBlock, sanitizeExternal } from "../modules/research/research-prompt-kit.js";
import { isReadyPack, readPack, writePack, serializeWriterCall, renderPack, packPath, PACK_MD } from "./writer-pack.js";

export const SCOUT_DESCRIPTION =
  "Host-driven research; all analysis uses the current conversation model, never a configured LLM API. prepare/pack freezes the complete task and returns task_id + role instructions. search is optional; use host search then read_page{url} when no search key is configured. cite accepts only exact quotes from server-fetched pages. claim_offline explicitly records an unverified user_claim with a reason, never a fallback that pretends research succeeded. Submit four perspective payloads, synthesize facts, then angles; all use returned schemas. Every action after prepare requires topic_id/task_id. cite/claim_offline can attach evidence to matching content_id/pack_id (plus claim_token when the draft is claimed, same host included, else claim_held); the per-content 12-item lifetime quota survives force reissues. Changed tasks reject old submissions.";
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
] as const;
export const scoutSchema = Type.Object(
  {
    action: Type.Union(actions.map((v) => Type.Literal(v))),
    topic_id: text,
    task_id: Type.Optional(text),
    platform: Type.Optional(text),
    requirements: Type.Optional(text),
    direction: Type.Optional(text),
    force: Type.Optional(Type.Boolean()),
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
/** 补证入稿被写门拒绝（P6 §3.8）：走研究台的错误通道，但把持有者原样带回去 */
class ClaimHeldError extends HostResearchError {
  constructor(readonly denial: ClaimDenial) {
    super(denial.code ?? "claim_held", denial.error);
  }
}
const nonempty = (v: unknown, name: string) => {
  const s = str(v);
  if (!s.trim()) throw new HostResearchError("missing_argument", `${name} 必填`);
  return s;
};
function perspectiveOf(value: unknown): PerspectiveName {
  if (!(PERSPECTIVE_NAMES as readonly unknown[]).includes(value))
    throw new HostResearchError("invalid_perspective", "perspective 必须是 audience/evidence/counter/benchmark");
  return value as PerspectiveName;
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
    perspectives: PERSPECTIVE_NAMES.map((name) => ({
      name,
      status: task.perspectives[name] ? "submitted" : "pending",
    })),
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
        : target(task, "pack", missing[0] ? { perspective: missing[0] } : {}),
    note:
      task.status === "ready"
        ? "本轮研究由当前宿主分析，来源和引文由工具核验；未调用后台模型。未核验材料仍按 user_claim 标注。"
        : "等待当前宿主完成研究分析；此任务不会在后台自行调用模型，请按返回的任务书继续。",
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
function promptPack(
  task: HostResearchTask,
  broker: ResearchBroker,
  perspective?: PerspectiveName,
): Record<string, unknown> {
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
  return {
    stage: task.status === "ready" ? "complete" : "angles",
    system: buildAngleSystemPrompt(task.profile, task.creativeTask),
    user: buildAngleUserMessage({ ...common, brief: task.brief }),
    submit_schema: ANGLE_SCHEMA,
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

/** 写门（P6 §3.8）：往稿件证据账本里写 = 写这篇稿，和写稿同一道令牌门；拒绝时带回持有者 */
async function gateEvidenceWrite(
  contentId: string,
  host: string,
  args: Record<string, unknown>,
  dir: string,
): Promise<{ claim_token?: string }> {
  const token = str(args.claim_token).trim();
  const gate = await gateClaimWrite(contentId, { host, employee: "writer", token: token || undefined }, dir);
  if ("denied" in gate) throw new ClaimHeldError(gate.denied);
  return gate.grant;
}

/** Citation insertion is fenced by the active writer pack, with a lifetime quota per content. */
async function attachEvidence(
  task: HostResearchTask,
  evidence: HostCitation | HostOfflineClaim,
  args: Record<string, unknown>,
  dir: string,
): Promise<Record<string, unknown>> {
  const contentId = str(args.content_id),
    packId = str(args.pack_id);
  if (!contentId && !packId) return {};
  if (!contentId || !packId) throw new HostResearchError("missing_pack", "补证入稿需要同时提供content_id和pack_id");
  return serializeWriterCall(contentId, async () => {
    const content = await getContent(contentId, dir);
    if (!content || content.topicId !== task.topicId)
      throw new HostResearchError("wrong_content", "补证目标不属于本次选题");
    if (!["drafting", "revision", "needs_evidence"].includes(content.status))
      throw new HostResearchError("content_not_writable", "稿件当前不在写作/修订/补证阶段，不能改写该稿证据账本");
    const pack = await readPack(contentId, dir);
    if (
      !pack ||
      !isReadyPack(pack) ||
      pack.packId !== packId ||
      content.pack?.packId !== packId ||
      pack.host !== task.host
    )
      throw new HostResearchError("stale_pack", "写作包已失效、尚未就绪或属于另一宿主，补证未入稿");
    if (Object.values(pack.attempts).some((a) => ["reviewing", "awaiting_host_review"].includes(a.status)))
      throw new HostResearchError("review_in_progress", "本稿正在审阅，先完成该次审稿再补证，避免修改审稿快照");
    const folder = path.join(dir, "research", "host-evidence");
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, `${contentId}.json`);
    let history: Record<string, LedgerEntry> = {};
    try {
      history = JSON.parse(await fs.readFile(file, "utf-8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const key = digest({
      source: evidence.source,
      quote: evidence.quote,
      claim: evidence.claim,
      sourceUrl: "sourceUrl" in evidence ? evidence.sourceUrl : "",
    });
    const id = `ev-H${key.slice(0, 20)}`;
    if (!history[id] && Object.keys(history).length >= 12)
      throw new HostResearchError("evidence_quota", "本稿宿主补证累计已满12条；重领包不会重置额度，请用已有材料收束");
    // 核对全过才过门：作废的补证不该顺手认领一篇稿
    const grant = await gateEvidenceWrite(contentId, task.host, args, dir);
    const entry: LedgerEntry = {
      id,
      source: evidence.source,
      quote: evidence.quote,
      claim: evidence.claim,
      ...(evidence.source === "verified_quote" ? { sourceId: evidence.sourceId, sourceUrl: evidence.sourceUrl } : {}),
    };
    history[id] ??= entry;
    await writeJsonAtomic(file, history); // quota survives crashes and force reissues
    const ledger = restoreEvidenceLedger(pack.ledger);
    for (const item of Object.values(history)) ledger.add(item);
    pack.ledger = ledger.snapshot();
    await writePack(contentId, pack, dir);
    await writeTextAtomic(packPath(contentId, dir, PACK_MD), renderPack(contentId, pack));
    await updateContent(contentId, { evidenceLedger: pack.ledger, _versionNote: "宿主补证登记（保留来源等级）" }, dir);
    return {
      content_id: contentId,
      pack_id: packId,
      evidence_entry: entry,
      host_evidence_used: Object.keys(history).length,
      host_evidence_limit: 12,
      ...grant,
    };
  });
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
  try {
    return await withHostResearchLock(topicId, dir, async (current, save) => {
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
        if (current && current.host !== host && current.status !== "ready")
          throw new HostResearchError("task_owned", `当前研究任务由 ${current.host} 持有；不能静默接管其在途研究`);
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
          pack: promptPack(task, broker, args.perspective ? perspectiveOf(args.perspective) : undefined),
        };
      }
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
      if (creativeTaskHash(suppliedTask) !== creativeTaskHash(task.creativeTask))
        throw new HostResearchError(
          "task_changed",
          "本轮任务已冻结；变更要求请重新prepare，不能把旧来源分析静默用于新任务",
        );
      if (action === "status") return view(task);
      if (task.host !== host)
        throw new HostResearchError("task_owned", `此任务由 ${task.host} 持有，当前宿主不能改写其结果`);
      await guardEngine(topicId, dir);
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
          const page = await broker.forPerspective(perspectiveOf(args.perspective)).readPage(url);
          await assertTopic(task, dir);
          task.broker = broker.snapshot();
          const clean = Array.from(sanitizeExternal(page.text, page.text.length));
          const offset = typeof args.offset === "number" ? args.offset : 0;
          return {
            ...view(task),
            source_id: page.sourceId,
            final_url: page.finalUrl,
            fetched_at: broker.getSource(page.sourceId)?.fetchedAt,
            source: "verified_quote",
            page: externalBlock([clean.slice(offset, offset + 12000).join("")]),
            ...(offset + 12000 < clean.length ? { next_offset: offset + 12000 } : {}),
            asset_candidates: page.assetCandidates,
            cached: page.cached,
            usage: broker.usage(),
            note: "已抓取页面快照；cite只核验引文逐字存在，不证明宿主对该引文的解释为真。",
          };
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
          if (PERSPECTIVE_NAMES.some((n) => !task.perspectives[n]))
            throw new HostResearchError(
              "perspectives_incomplete",
              "四个视角尚未全部交付；没有查到的情况也应明确提交材料缺口，不得假装完成",
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
        return { ...view(task), ...(view(task).status !== "ready" ? { pack: promptPack(task, broker) } : {}) };
      } finally {
        task.broker = broker.snapshot();
        await save(task);
      }
    });
  } catch (err) {
    return {
      ok: false,
      code: err instanceof HostResearchError ? err.code : "research_operation_failed",
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof ClaimHeldError && err.denial.holder ? { holder: err.denial.holder } : {}),
      note: "操作失败已如实返回；未调用备用模型，也未把来源自动降为离线声明。",
    };
  }
}
