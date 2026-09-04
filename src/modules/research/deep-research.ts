/**
 * 深调研任务的执行体（spec §5「综合与简报」）——装进 runner 的 `runJob`。
 *
 * 一条 job 的全貌：读选题 → 建 per-job broker → 四视角 `Promise.allSettled` 并行 →
 * ≥2 路成功则综合 → 分配不可变 revision → 落简报 → 回执 `JobOutcome`。
 *
 * 三条纪律：
 * 1. **一路的失败只让这一路缺席**：allSettled + 每路自带 deadline，最慢的一路拖不死整条 job（P1-9）。
 * 2. **进度实时可见**：每路启动/落定都读改写 `job.perspectives` 并触发 `onProgress`
 *    （runner 的 onJobChanged 只管它自己写的 queued/running/落定三处，管不到视角级进度）。
 *    四路并发写同一条台账，所以状态以**内存快照为准**并串行落盘——否则「读-改-写」
 *    交错会把先落的那一路状态写回去（丢更新）。
 * 3. **失败不产半份简报**：<2 路成功、综合失败、写盘失败都落 failed 且不写文件；
 *    旧简报的有效性由 runner 的 briefRevision 指针保证（重跑失败不回退，§2）。
 */
import { getTopic } from "../../storage/local-store.js";
import type { EngineConfig } from "../../engine/config.js";
import type { runLoop } from "../../engine/loop.js";
import { loadProfile } from "../profile/creator-profile.js";
import { runAngleStage } from "./angle-stage.js";
import { resolveEffectiveBrief } from "./brief-snapshot.js";
import {
  BRIEF_SCHEMA_VERSION,
  nextBriefRevision,
  saveBrief,
  type PerspectiveOutput,
  type ResearchBrief,
} from "./brief-store.js";
import {
  downloadBriefAssets,
  type AssetDownloadOptions,
} from "./research-asset-download.js";
import { createResearchBroker, type BrokerActivity, type ResearchBrokerDeps } from "./research-broker.js";
import {
  PERSPECTIVE_NAMES,
  getJob,
  topicHashOf,
  upsertJob,
  type PerspectiveName,
  type PerspectiveState,
  type ResearchJob,
} from "./research-job-store.js";
import { runPerspective, type ResearchTopicRef } from "./research-perspectives.js";
import type { JobOutcome } from "./research-runner.js";
import { runSynthesis, type SynthesisPayload } from "./research-synthesis.js";

/** 少于这个数就不产简报：一两路视角合成不出「跨视角张力」，那是伪装成简报的单点意见（§5） */
const MIN_PERSPECTIVES = 2;

export interface DeepResearchDeps {
  /** 选题所在工作区 */
  dataDir: string;
  engineConfig?: EngineConfig;
  /** broker 的注入口（测试塞假 search/fetch，生产走真实出网） */
  brokerDeps?: ResearchBrokerDeps;
  runLoopImpl?: typeof runLoop;
  /** 每视角墙钟上限；缺省 4 分钟（spec §3） */
  perspectiveDeadlineMs?: number;
  /** 素材下载段的注入口（测试塞假下载器 / 收紧预算）；预算缺省见 research-asset-download */
  assetDownloadDeps?: Omit<AssetDownloadOptions, "dataDir" | "topicId">;
  /**
   * 视角进度写盘后的通知（SSE `research:updated` 用）。
   * runner 的 `onJobChanged` 只覆盖它自己写的三处（queued/running/落定），**管不到**
   * 视角级进度——这条进度是 runJob 内部写的，所以出口在这里，装配时接到同一个发射器上。
   */
  onProgress?: (job: ResearchJob) => void;
  /**
   * 每次真实出网的可见出口（工作日志「调研员·X 视角在搜：…」）。
   * 视角级进度只有四拍，撑不住分钟级的等待——写稿排队等简报的那十几分钟里，
   * 界面上得有东西在动，否则「调研在干活」和「卡死」长得一模一样。
   */
  onActivity?: (activity: BrokerActivity) => void;
  /** 非致命故障的可见出口（进度写失败、单路视角失败原因）；默认 console.warn */
  onWarn?: (message: string) => void;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 引擎注入透传：给了才覆盖，没给就让子运行自己按 dataDir 加载配置 */
function engineOverrides(deps: DeepResearchDeps) {
  return {
    ...(deps.engineConfig ? { engineConfig: deps.engineConfig } : {}),
    ...(deps.runLoopImpl ? { runLoopImpl: deps.runLoopImpl } : {}),
  };
}

/**
 * 视角进度：内存快照是唯一真相，落盘串行排队。
 * 四路并发各自「读 job → 改 perspectives → 写」会互相覆盖，所以写的时候一律
 * 写**整份当前快照**，并用一条 promise 链保证落盘顺序与状态变更顺序一致。
 */
class PerspectiveProgress {
  private readonly states: PerspectiveState[];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly topicId: string,
    private readonly dataDir: string,
    initial: PerspectiveState[],
    private readonly warn: (message: string) => void,
    private readonly onProgress?: (job: ResearchJob) => void,
  ) {
    // 必须**拷贝**：直接持有 job.perspectives 里的对象会把 runner 已经发出去的那份
    // 快照一起改掉（SSE 消费方晚一步序列化就会读到「未来」的状态）
    this.states = PERSPECTIVE_NAMES.map((name) => ({
      ...(initial.find((p) => p.name === name) ?? { name, status: "pending" as const }),
    }));
  }

  snapshot(): PerspectiveState[] {
    return this.states.map((s) => ({ ...s }));
  }

  set(name: PerspectiveName, status: PerspectiveState["status"], errorCode?: string): Promise<void> {
    const state = this.states.find((s) => s.name === name);
    if (state) {
      state.status = status;
      if (errorCode) state.errorCode = errorCode;
      else delete state.errorCode;
    }
    this.chain = this.chain.then(() => this.flush());
    return this.chain;
  }

  /** 进度写失败不该带走整条 job：任务照跑，故障从 warn 冒出来 */
  private async flush(): Promise<void> {
    try {
      const job = await getJob(this.topicId, this.dataDir);
      if (!job) return; // 没有台账行（直接调 runJob 的场景）：没什么可更新的
      const saved = await upsertJob({ ...job, perspectives: this.snapshot() }, this.dataDir);
      // 写盘之后再通知：消费方按 topicId 重读永远读到已落定的状态（同 runner 的顺序）
      this.onProgress?.(saved);
    } catch (err) {
      this.warn(`调研进度写台账失败（${this.topicId}）：${errText(err)}`);
    }
  }
}

interface PerspectiveRunContext {
  topic: ResearchTopicRef;
  progress: PerspectiveProgress;
  warn: (message: string) => void;
}

function failed(
  perspectives: PerspectiveState[],
  errorCode: string,
  failReason: string,
): JobOutcome {
  return { status: "failed", perspectives, errorCode, failReason };
}

/** 单路：启动写 running，落定写 succeeded/failed。**不抛**——失败即缺席 */
async function runOne(
  name: PerspectiveName,
  ctx: PerspectiveRunContext,
  deps: DeepResearchDeps,
  broker: ReturnType<typeof createResearchBroker>,
  profile: Awaited<ReturnType<typeof loadProfile>>,
): Promise<PerspectiveOutput | null> {
  await ctx.progress.set(name, "running");
  const result = await runPerspective({
    name,
    topic: ctx.topic,
    profile,
    broker,
    dataDir: deps.dataDir,
    ...engineOverrides(deps),
    ...(deps.perspectiveDeadlineMs ? { deadlineMs: deps.perspectiveDeadlineMs } : {}),
  });
  if (result.status === "succeeded") {
    await ctx.progress.set(name, "succeeded");
    return result.output;
  }
  await ctx.progress.set(name, "failed", result.errorCode);
  ctx.warn(`视角「${name}」失败（${result.errorCode}）：${result.reason}`);
  return null;
}

function describeFailures(perspectives: PerspectiveState[]): string {
  return perspectives
    .filter((p) => p.status !== "succeeded")
    .map((p) => `${p.name}(${p.errorCode ?? p.status})`)
    .join("、");
}

/** 四路并行；成功的产出按 PERSPECTIVE_NAMES 顺序收集，失败的只留状态与告警 */
async function runAllPerspectives(
  ctx: PerspectiveRunContext,
  deps: DeepResearchDeps,
  broker: ReturnType<typeof createResearchBroker>,
  profile: Awaited<ReturnType<typeof loadProfile>>,
): Promise<PerspectiveOutput[]> {
  const settled = await Promise.allSettled(
    PERSPECTIVE_NAMES.map((name) => runOne(name, ctx, deps, broker, profile)),
  );
  const outputs: PerspectiveOutput[] = [];
  for (const [i, res] of settled.entries()) {
    if (res.status === "fulfilled") {
      if (res.value) outputs.push(res.value);
      continue;
    }
    // runPerspective 契约上不抛；真抛了就是本层的 bug，同样只让这一路缺席并留痕
    await ctx.progress.set(PERSPECTIVE_NAMES[i], "failed", "crashed");
    ctx.warn(`视角「${PERSPECTIVE_NAMES[i]}」异常退出：${errText(res.reason)}`);
  }
  return outputs;
}

/** 分配不可变 revision → 组装 → 落盘。写盘失败即整轮失败，不留半份简报 */
async function publishBrief(
  job: ResearchJob,
  topic: { title: string; description: string },
  outputs: PerspectiveOutput[],
  perspectives: PerspectiveState[],
  payload: SynthesisPayload,
  dataDir: string,
): Promise<JobOutcome> {
  const missingPerspectives = perspectives.filter((p) => p.status !== "succeeded").map((p) => p.name);
  try {
    const revision = await nextBriefRevision(job.topicId, dataDir);
    const brief: ResearchBrief = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      ...payload,
      perspectives: outputs,
      missingPerspectives,
      generatedAt: new Date().toISOString(),
      revision,
      // 用**实际调研的那份选题文本**算 hash：期间选题被改过的话，这份简报确实基于旧版
      topicHash: topicHashOf(topic.title, topic.description),
    };
    await saveBrief(job.topicId, brief, dataDir);
    return {
      status: missingPerspectives.length === 0 ? "succeeded" : "partial",
      perspectives,
      briefRevision: revision,
    };
  } catch (err) {
    return failed(perspectives, "brief_write_failed", `简报写盘失败：${errText(err)}`);
  }
}

/**
 * 素材下载段（§7）：综合成功之后、简报落盘之前。**只改 payload，不改 job 终态**——
 * 一张图都没下来也不会让这轮调研变成 failed，降级原因逐条落在 pick 上、全败进 gaps。
 */
async function withDownloadedAssets(
  payload: SynthesisPayload,
  topicId: string,
  deps: DeepResearchDeps,
  warn: (message: string) => void,
): Promise<SynthesisPayload> {
  const result = await downloadBriefAssets(payload.assetPicks, {
    dataDir: deps.dataDir,
    topicId,
    ...deps.assetDownloadDeps,
  });
  const degraded = result.picks.length - result.storedCount;
  if (degraded > 0) warn(`素材下载：${result.storedCount} 张入库、${degraded} 张降级为仅链接`);
  return {
    ...payload,
    assetPicks: result.picks,
    gaps: result.gap ? [...payload.gaps, result.gap] : payload.gaps,
  };
}

/**
 * 立意段（P1 spec §4.1）：综合与素材下载之后、简报落盘之前，**独立一次 LLM pass** 产角度卡 v3。
 *
 * 为什么在这里而不是并进综合：立场一旦在材料综合里定死，写出来的就是「劝你别碰」那一类
 * （P0 36 稿 0 可发）。也因此它**永远不该让整条 job 失败**——失败只是这份简报没有卡，
 * 写稿走无卡路径，原因写进 gaps 让人看得见（§5 边界行为）。
 */
async function withAngleCards(
  payload: SynthesisPayload,
  outputs: PerspectiveOutput[],
  topic: ResearchTopicRef,
  profile: Awaited<ReturnType<typeof loadProfile>>,
  deps: DeepResearchDeps,
  warn: (message: string) => void,
): Promise<{ payload: SynthesisPayload; failure?: { errorCode: string; reason: string } }> {
  // 只喂事实：卡是本段的产出，revision 还没分配（落盘那步才定），这里给 0 占位
  const factBrief: ResearchBrief = {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    ...payload,
    angleCards: undefined,
    // 视角全文一起给：立意要看到受众/反方视角的洞察，不只是综合后的摘要
    perspectives: outputs,
    missingPerspectives: [],
    generatedAt: new Date().toISOString(),
    revision: 0,
    topicHash: "",
  };
  const result = await runAngleStage({
    brief: factBrief,
    topic,
    profile,
    dataDir: deps.dataDir,
    ...engineOverrides(deps),
  });
  if (result.status === "succeeded") {
    return { payload: { ...payload, angleCards: result.cards } };
  }
  warn(`立意未产出（${result.errorCode}）：${result.reason}`);
  // 综合那一步产的 v2 卡照旧保留（本刀不动综合产地）：立意失败不该连既有候选一起没收。
  // full job 只记 gaps（简报照出，写稿走无卡路径）；angles job 拿 failure 让整轮失败——
  // 一份「只换了卡、卡还没换成」的新 revision 没有任何意义。
  return {
    payload: { ...payload, gaps: [...payload.gaps, `立意未产出：${result.reason}`] },
    failure: { errorCode: result.errorCode, reason: result.reason },
  };
}

/**
 * angles job（P1 spec §3.5）：**不出网、不跑视角**，只在当前生效简报上重跑一次立意，
 * 把事实字段原样抄进新一版、只换角度卡。
 *
 * 三条纪律：
 * 1. **认指针不认磁盘最新版**（§3.0）：读 `resolveEffectiveBrief`，没有生效简报就
 *    `no_brief` 失败——绝不拿一份没被采纳的简报重算立意。
 * 2. **立意失败即整轮失败**：`angle_failed`，一个字都不落盘。full job 允许「简报没有卡」，
 *    angles job 不允许——那样只会产出一版和上一版逐字相同的简报。
 * 3. **事实原样抄**：摘要/视角/张力/证据/素材/缺口/缺席视角全部照抄，本段不重新解释材料。
 */
async function runAnglesOnly(
  job: ResearchJob,
  topic: { title: string; description: string },
  deps: DeepResearchDeps,
  warn: (message: string) => void,
): Promise<JobOutcome> {
  const snapshot = await resolveEffectiveBrief(job.topicId, deps.dataDir, warn);
  if (!snapshot) {
    return failed([], "no_brief", "这条选题还没有生效简报——先跑一轮深调研，才有事实可以重新立意");
  }
  const { brief } = snapshot;
  const topicRef: ResearchTopicRef = { title: topic.title, description: topic.description };
  const profile = await loadProfile(deps.dataDir);
  const facts: SynthesisPayload = {
    summary: brief.summary,
    tensions: brief.tensions,
    angleSuggestions: brief.angleSuggestions,
    evidence: brief.evidence,
    assetPicks: brief.assetPicks,
    gaps: brief.gaps,
  };
  const { payload, failure } = await withAngleCards(
    facts,
    brief.perspectives,
    topicRef,
    profile,
    deps,
    warn,
  );
  if (failure) return failed([], "angle_failed", `立意未产出（${failure.errorCode}）：${failure.reason}`);

  // 选题正文可能在上一轮调研之后被改过：照跑（事实还是那批事实），但把「基于旧版选题」
  // 写进 gaps——与简报 stale 标注同一口径，不静默
  const topicHash = topicHashOf(topic.title, topic.description);
  const gaps =
    topicHash === brief.topicHash
      ? payload.gaps
      : [...payload.gaps, `选题正文在上一轮调研后改过，这版立意仍基于旧版选题的事实（简报 v${snapshot.revision}）——需要新事实就跑深调研`];

  try {
    const revision = await nextBriefRevision(job.topicId, deps.dataDir);
    const next: ResearchBrief = {
      ...brief,
      ...payload,
      gaps,
      missingPerspectives: brief.missingPerspectives,
      generatedAt: new Date().toISOString(),
      revision,
      topicHash,
    };
    await saveBrief(job.topicId, next, deps.dataDir);
    return { status: "succeeded", perspectives: [], briefRevision: revision };
  } catch (err) {
    return failed([], "brief_write_failed", `简报写盘失败：${errText(err)}`);
  }
}

/**
 * 建一个可以直接塞进 `createResearchRunner({ runJob })` 的执行体。
 * 回执语义见 `JobOutcome`：briefRevision 只在 succeeded/partial 时被 runner 采纳。
 */
export function createDeepResearchRunJob(deps: DeepResearchDeps): (job: ResearchJob) => Promise<JobOutcome> {
  const warn = deps.onWarn ?? ((message: string) => console.warn(`[deep-research] ${message}`));

  return async (job: ResearchJob): Promise<JobOutcome> => {
    const topic = await getTopic(job.topicId, deps.dataDir);
    if (!topic || topic.deletedAt) {
      return failed(job.perspectives, "topic_missing", `选题已不存在或在回收站：${job.topicId}`);
    }
    // angles job 走另一条短得多的路：不建 broker、不跑视角，只重跑立意（§3.5）
    if (job.kind === "angles") return runAnglesOnly(job, topic, deps, warn);
    const topicRef: ResearchTopicRef = { title: topic.title, description: topic.description };
    const profile = await loadProfile(deps.dataDir);
    // onActivity 排在 brokerDeps 之后：装配层给的观测出口是这条 job 的最终口径
    const broker = createResearchBroker({
      dataDir: deps.dataDir,
      ...deps.brokerDeps,
      ...(deps.onActivity ? { onActivity: deps.onActivity } : {}),
    });
    const progress = new PerspectiveProgress(
      job.topicId,
      deps.dataDir,
      job.perspectives,
      warn,
      deps.onProgress,
    );
    const ctx: PerspectiveRunContext = { topic: topicRef, progress, warn };

    const outputs = await runAllPerspectives(ctx, deps, broker, profile);
    const perspectives = progress.snapshot();
    if (outputs.length < MIN_PERSPECTIVES) {
      return failed(
        perspectives,
        "too_few_perspectives",
        `只有 ${outputs.length} 路视角成功（需 ≥${MIN_PERSPECTIVES}）：${describeFailures(perspectives)}`,
      );
    }

    // 综合前复查选题：中途被删就停在这儿——不给已删的选题产简报，也省下一次 LLM（§2）
    const current = await getTopic(job.topicId, deps.dataDir);
    if (!current || current.deletedAt) {
      return failed(perspectives, "topic_missing", `调研途中选题被删除，已停在综合前：${job.topicId}`);
    }

    const synthesis = await runSynthesis({
      topic: topicRef,
      perspectiveResults: outputs,
      broker,
      dataDir: deps.dataDir,
      ...engineOverrides(deps),
    });
    if (synthesis.status === "failed") {
      return failed(perspectives, "synthesis_failed", `${synthesis.errorCode}：${synthesis.reason}`);
    }
    const payload = await withDownloadedAssets(synthesis.payload, job.topicId, deps, warn);
    // full job：立意失败只记 gaps（failure 忽略），简报照出——写稿走无卡路径（§5 边界行为）
    const withAngles = await withAngleCards(payload, outputs, topicRef, profile, deps, warn);
    return publishBrief(job, topic, outputs, perspectives, withAngles.payload, deps.dataDir);
  };
}
