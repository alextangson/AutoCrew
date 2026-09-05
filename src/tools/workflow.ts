/**
 * autocrew_workflow — 写作全流程的**宿主入口**（dsh 插件 spec §4，P1 spec §2）。
 *
 * 工作台今天能跑通「深调研 → 立意卡 → 创始人选卡 → 后台写稿 → 取稿」，靠的是
 * `src/desktop/*` 那套接线（research-runtime 的投递口、ipc 的选卡通道、chat-router 的
 * 角度闸口）。dsh / MCP / CLI 三个宿主一个都够不着它——desktop 那层拖着 server-only 依赖，
 * 不能反向 import。本文件是那三段语义在 core 层的**同构副本**：
 *
 * - 搜索 key 门只管 `full`（`angles` 不出网，它要的是引擎）——同 research-runtime.postJob；
 * - 选卡认 `resolveEffectiveBrief` 的快照版本、改写走 `parseAngleCard`——同 ipc.topicSelectAngleHandler；
 * - 有候选卡却没选就**不接单**——同 chat-router.angleGate。
 *
 * 三条纪律：
 * 1. **永不替创始人选卡**。卡按 `score` 排序，分只是排序不是推荐（P1 §3.1 codex #7）。
 *    闸口拒单时把候选原样交出去，让宿主 agent 回去问人——这一轮往返正是整条角度链的意义。
 * 2. **只投递，不阻塞**。research 与 write 都是分钟级后台任务，两个入口都当场返回，宿主轮询。
 * 3. **失败一律 `ok:false`**，不抛（dsh 桥按 `ok:false` 抛错才会把这轮标成失败——
 *    返回一个内含 error 的「成功」结果正是最贵的那类 bug，见 adapters/dsh/README.md）。
 *    桥只把 `error` 字符串带给模型，所以闸口的候选摘要**也写进 error 文本**，
 *    结构化的 `cards` 是给 MCP/CLI 这类能看全对象的宿主的。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";

import { loadEngineConfig, ENGINE_DEFAULTS } from "../engine/config.js";
import {
  activeAngleCard,
  angleCardsOf,
  findAngleCard,
  parseAngleCard,
} from "../modules/research/angle-cards.js";
import { resolveEffectiveBrief, type BriefSnapshot } from "../modules/research/brief-snapshot.js";
import { createDeepResearchRunJob } from "../modules/research/deep-research.js";
import { getJob, topicHashOf, type ResearchJobKind } from "../modules/research/research-job-store.js";
import { createResearchRunner, type ResearchRunner } from "../modules/research/research-runner.js";
import { SEARCH_NOT_CONFIGURED, searchAvailable } from "../modules/research/search-provider.js";
import { CLIPBOARD_PLATFORMS, type ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";
import { startGenerateScript, type ScriptRequest } from "../modules/writing/generate-script.js";
import {
  CONTENT_STATUS_LABEL,
  getContent,
  getDataDir,
  getTopic,
  updateTopic,
  type Content,
} from "../storage/local-store.js";
import { cardLine, cardView, jobView, sortedCards } from "./workflow-views.js";
// 健康视图是桌面与 dsh 共用的那一个（spec §4.1「同一个视图函数」）——doctor 不另写一份
import { buildEngineHealth, probeAllProviders } from "../desktop/engine-health.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

const ACTIONS = ["research", "status", "select_angle", "write", "draft", "doctor"] as const;
type WorkflowAction = (typeof ACTIONS)[number];

export const workflowSchema = Type.Object({
  action: Type.Unsafe<WorkflowAction>({
    type: "string",
    enum: [...ACTIONS],
    description: "research | status | select_angle | write | draft | doctor",
  }),
  topic_id: Type.Optional(Type.String({ description: "选题 id（research / status / select_angle / write 必填）" })),
  kind: Type.Optional(
    Type.Unsafe<ResearchJobKind>({
      type: "string",
      enum: ["full", "angles"],
      description: "research 的任务类型：full = 四视角深调研（默认，需要搜索 key）；angles = 在现有简报上只重跑立意",
    }),
  ),
  angle_id: Type.Optional(Type.String({ description: "select_angle：创始人选中的立意卡 id，如 angle-2" })),
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
        "select_angle：你读到这批候选时的 brief.revision。带上就会校验候选是否已经被重跑换过一批；不带则按当前生效简报落。",
    }),
  ),
  platform: Type.Optional(
    Type.String({ description: `write：目标平台。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}` }),
  ),
  direction: Type.Optional(
    Type.String({ description: "write：创始人自己写的角度（优先级高于选中的卡），有它就不再要求选卡" }),
  ),
  skip_reason: Type.Optional(
    Type.String({ description: "write：创始人**明说**不选卡直接写时的原话转述；只进留痕，不进 prompt" }),
  ),
  content_id: Type.Optional(Type.String({ description: "draft：稿件 id（write 返回的 contentId）" })),
  probe: Type.Optional(
    Type.Boolean({
      description:
        "doctor：true = 真去每个模型端点发一次极小调用，回每条线的通/坏与耗时（几秒到几十秒）。默认 false，只看配置不出网。",
    }),
  ),
});

export const WORKFLOW_DESCRIPTION = [
  "AutoCrew 写作全流程编排：深调研 → 立意候选 → 创始人选卡 → 后台写稿 → 取稿。按这个顺序用：",
  "1) research{topic_id, kind}：投一轮任务。kind=full 是四视角深调研（要先配好搜索 key），kind=angles 是在现有简报上只重跑立意。**投递即返回**，真活在后台跑，通常 5–15 分钟。",
  "2) status{topic_id}：轮询到 job.terminal=true 为止（1–2 分钟一次）。落定后 brief.cards 就是立意候选。",
  "3) 把 cards **原样念给创始人听**，让他挑一张。cards 按 score 排序，score 只是排序、不是推荐；本工具永远不替他选卡，你也不要替他选。",
  "4) select_angle{topic_id, angle_id, card?}：落他选的那张。他改了文字就把改写后的整张卡放进 card。",
  "5) write{topic_id, platform, direction?, skip_reason?}：开写。**有候选卡却没选、也没给 direction/skip_reason 时会被拒**（needsAngle）——那是让你回去问创始人，不是让你自己挑一张。写稿也是后台的，通常 15–30 分钟。",
  "6) draft{content_id}：轮询取稿。status=drafting = 还在写；needs_evidence = 数字硬门拦下了，看 unverifiedNumbers 和 blockedReason。",
  "doctor{probe?}：引擎/搜索配没配好、数据目录在哪。跑不动时先看它；模型调用报错时用 doctor{probe:true} 真测一遍端点，回答创始人是哪条线坏了，别复述原始报错。",
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
  const res = await runner.trigger(topicId, kind);
  if (!res.accepted) return fail(res.reason, res.inFlight ? { inFlight: true } : {});
  return {
    ok: true,
    job: jobView(res.job),
    deduped: res.deduped,
    note: `${kind === "angles" ? "重新立意" : "深调研"}已在后台开始（通常 5–15 分钟）。用 status{topic_id} 轮询到 job.terminal=true，不要编造结果。`,
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
  const cards = snap ? sortedCards(angleCardsOf(snap.brief)) : [];

  return {
    ok: true,
    topicId,
    title: topic.title,
    job: job ? jobView(job) : null,
    ...(snap
      ? {
          brief: {
            revision: snap.revision,
            summary: snap.brief.summary,
            tensions: snap.brief.tensions,
            gaps: snap.brief.gaps,
            cards: cards.map(cardView),
            note: "cards 按 score 排序；分只用于排序，不是推荐——把候选原样念给创始人，由他选。",
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
  if (!topicId || !angleId) return fail("topic_id 与 angle_id 必填");
  const topic = await getTopic(topicId, dataDir);
  if (!topic) return fail(`选题不存在：${topicId}`);

  // 唯一「当前有效简报」入口（P1 §3.0）：认台账指针，不认磁盘最大版
  const snap = await resolveEffectiveBrief(topicId, dataDir, warn);
  if (!snap) return fail(NO_BRIEF);
  const claimed = params.brief_revision;
  if (claimed !== undefined && claimed !== snap.revision) {
    return fail(`角度候选已更新（当前 v${snap.revision}，你手上是 v${String(claimed)}）——重新 status 一次再选`);
  }
  const original = findAngleCard(snap.brief, angleId);
  if (!original) return fail(`角度 ${angleId} 不在简报 v${snap.revision} 里`);

  // 没给 card = 点选原卡；给了 = 改写版（改写才是创始人观点进管线的口子，客户端 score 一律丢弃重算）
  const card = params.card === undefined ? original : parseAngleCard(params.card, snap.brief, angleId);
  if (typeof card === "string") return fail(card);
  const updated = await updateTopic(
    topicId,
    { selectedAngle: { briefRevision: snap.revision, angleId, card, selectedAt: new Date().toISOString() } },
    dataDir,
  );
  if (!updated) return fail(`选题不存在：${topicId}`);
  return { ok: true, topic: updated };
}

// ─── write ────────────────────────────────────────────────────────────────────

/**
 * 角度闸口（角度卡 spec §1.6，同 chat-router.angleGate）。返回拒单回执 = 不接单，null = 放行。
 * 放行四条路：给了 direction、明说 skip_reason、之前选过且还作数、这条选题压根没有候选卡。
 */
async function angleGate(
  topicId: string,
  req: ScriptRequest,
  dataDir: string,
  warn: (m: string) => void,
): Promise<WorkflowFail | null> {
  const snap: BriefSnapshot | null = await resolveEffectiveBrief(topicId, dataDir, warn);
  const cards = snap ? sortedCards(angleCardsOf(snap.brief)) : [];
  if (!snap || cards.length === 0) return null; // 没有候选就没有闸口（§1.8 降级：不硬出角度）
  if (req.direction?.trim() || req.angleSkipReason?.trim()) return null;
  const topic = await getTopic(topicId, dataDir);
  const hash = topic ? topicHashOf(topic.title, topic.description) : "";
  if (topic && activeAngleCard(topic.selectedAngle, snap.brief, hash)) return null;

  const head = `这条选题有 ${cards.length} 张立意候选（简报 v${snap.revision}），得先让创始人挑一张再开写。把候选原样念给他，让他选一张（select_angle）／说自己的角度（direction）／明说直接写（skip_reason）——不要替他选。`;
  return fail(`${head}\n${cards.map(cardLine).join("\n")}`, {
    needsAngle: true,
    briefRevision: snap.revision,
    cards: cards.map(cardView),
  });
}

async function doWrite(
  params: Record<string, unknown>,
  dataDir: string,
  deps: WorkflowDeps,
  warn: (m: string) => void,
): Promise<WorkflowResult> {
  const topicId = str(params.topic_id);
  if (!topicId) return fail("topic_id 必填");
  const platform = str(params.platform);
  if (!platform) return fail(`platform 必填。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}`);
  if (!(CLIPBOARD_PLATFORMS as readonly string[]).includes(platform)) {
    return fail(`无效 platform「${platform}」。有效值：${CLIPBOARD_PLATFORMS.join(" | ")}`);
  }
  const topic = await getTopic(topicId, dataDir);
  if (!topic) return fail(`选题不存在：${topicId}`);

  const direction = str(params.direction);
  const skipReason = str(params.skip_reason);
  const req: ScriptRequest = {
    topic: topic.title,
    platform: platform as ClipboardPlatform,
    topicId,
    ...(direction ? { direction } : {}),
    ...(skipReason ? { angleSkipReason: skipReason } : {}),
  };

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

function draftView(content: Content): WorkflowOk {
  return {
    ok: true,
    contentId: content.id,
    status: content.status,
    statusLabel: CONTENT_STATUS_LABEL[content.status] ?? content.status,
    title: content.title,
    body: content.body,
    hashtags: content.hashtags,
    review: content.review,
    needsEvidence: content.status === "needs_evidence",
    unverifiedNumbers: content.unverifiedNumbers ?? [],
    blockedReason: content.blockedReason ?? undefined,
    lastError: content.lastError ?? undefined,
    usedAngle: content.usedAngle,
    usedFallback: content.usedFallback,
  };
}

async function doDraft(params: Record<string, unknown>, dataDir: string): Promise<WorkflowResult> {
  const contentId = str(params.content_id);
  if (!contentId) return fail("content_id 必填");
  const content = await getContent(contentId, dataDir);
  if (!content) return fail(`稿件不存在：${contentId}`);
  if (content.status === "drafting") {
    return {
      ok: true,
      contentId,
      status: "drafting",
      note: "还在后台写（通常 15–30 分钟），过一会儿再查。正文此刻是占位，别拿去用。",
    };
  }
  return draftView(content);
}

// ─── doctor ───────────────────────────────────────────────────────────────────

/** engine.json 缺席 + 环境变量有 key 时的处置：默认只给建议，`AUTOCREW_SEED_ENGINE=1` 才落盘 */
async function engineSeed(dataDir: string, hints: string[]): Promise<Record<string, unknown>> {
  const filePath = path.join(dataDir, "engine.json");
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
  try {
    switch (action) {
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
    return fail(`${action || "workflow"} 执行失败：${errText(err)}`);
  }
}
