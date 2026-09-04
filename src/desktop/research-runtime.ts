/**
 * 深调研运行时（deep-research spec §2「执行」）——server 进程内的**单例**接线：
 * 串行 runner（投递口）+ 四视角执行体 + 启动回收 + 事件出口。
 *
 * 四条纪律：
 * 1. **装配硬规矩：两级进度接同一个发射器**。runner 的 `onJobChanged` 只覆盖它自己写的
 *    三处（queued/running/落定），视角级进度是 runJob 内部写的，出口在 `onProgress`——
 *    漏接后者前端就只能看到「跑起来了」和「跑完了」，中间四视角一片空白。本模块是唯一
 *    装配点，两个回调都指向 `emit`。
 * 2. **所有入口只投递**：`triggerDeepResearch` 落一条 queued 就返回，聊天与 IPC 都不阻塞。
 * 3. **搜索 key 门在投递口**（不是某一个 handler 里）：IPC 按钮、chat 工具、以后的托管触发
 *    共用这一道门，谁都不可能绕过去；未配置时给设置指引，不排一个注定失败的 job。
 * 4. **dataDir 跟当前工作区走**：runner 单例把 dataDir 锁死在创建那一刻，所以工作区切换后
 *    第一次投递会**重新接线**（停旧队列——在途的 runJob 不打断，随后按新 dataDir 补扫回收）。
 *    收件箱那种「固定目标工作区」的问题这里不存在：选题在哪个工作区，调研就落哪个。
 */
import { getDataDir } from "../storage/local-store.js";
import { createDeepResearchRunJob, type DeepResearchDeps } from "../modules/research/deep-research.js";
import type { BrokerActivity } from "../modules/research/research-broker.js";
import { PERSPECTIVE_TASK_BOOKS } from "../modules/research/research-perspectives.js";
import type { JobOutcome } from "../modules/research/research-runner.js";
import { emitEngineEvent } from "./event-hub.js";
import {
  getResearchRunner,
  resetResearchRunner,
  type ResearchRunner,
  type TriggerResult,
} from "../modules/research/research-runner.js";
import {
  isTerminalJobStatus,
  type PerspectiveName,
  type ResearchJob,
  type ResearchJobKind,
} from "../modules/research/research-job-store.js";
import { runResearchFollowup } from "./chat-followup.js";
import { searchAvailable } from "../modules/research/search-provider.js";

/** SSE `research` 流的载荷（spec §2「进度」）：只报 topicId，消费方按它重读状态 */
export interface ResearchUpdatedEvent {
  type: "research:updated";
  topicId: string;
}

/** SSE `chat_followup` 流的载荷（调研回流轮）：总编辑刚往这段会话里落了一轮回报 */
export interface ChatFollowupEvent {
  type: "chat:followup";
  conversationId: string;
  topicId: string;
}

export interface ResearchRuntimeStatus {
  state: "running" | "stopped";
  /** 当前接线的工作区；切工作区后第一次投递会重新绑定 */
  dataDir?: string;
  /** 启动/重绑时回收的中断任务数（可见标注：它们已重新排队） */
  reclaimed?: number;
}

export interface ResearchRuntimeOptions {
  /** 工作区根；缺省走 getDataDir() */
  rootDir?: string;
  /** 状态落定/进度回调，server 接 SSE（总线不在这层接） */
  onResearchEvent?: (evt: ResearchUpdatedEvent) => void;
  /** 回流轮落盘回调，server 接 SSE `chat_followup`（同上，总线不在这层接） */
  onChatFollowupEvent?: (evt: ChatFollowupEvent) => void;
  /** 故障出口——不静默（默认 console.error） */
  onError?: (message: string) => void;
  /** 测试注入：替掉真管线。工厂形态（不是成品 runJob）——替身能看到本层注入的 onProgress */
  createRunJobImpl?: (deps: DeepResearchDeps) => (job: ResearchJob) => Promise<JobOutcome>;
  /** 测试注入：替掉回流轮本体（生产走 chat-followup 的真实现） */
  followupImpl?: typeof runResearchFollowup;
}

/** 搜索未配置时的人话出口（投递口共用，chat 与 IPC 一字不差） */
export const SEARCH_NOT_CONFIGURED =
  "深调研要联网取证：先去设置页 · 搜索来源配好博查或 Tavily 的 key，再回来点深调研（简报里的每条证据都要有可点的来源）";

const RUNTIME_DOWN = "深调研运行时没在跑（server 未接线）——重启 AutoCrew 后重试";

let options: ResearchRuntimeOptions = {};
let runner: ResearchRunner | null = null;
let boundDataDir: string | null = null;
let started = false;
let status: ResearchRuntimeStatus = { state: "stopped" };
let chain: Promise<unknown> = Promise.resolve();

function report(message: string): void {
  (options.onError ?? ((m: string) => console.error(`[research-runtime] ${m}`)))(message);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 生命周期串行队列：前一步失败也不许卡住后一步（同 inbox-runtime） */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/** 搜索词/域名进日志要限长——一行日志被一条长 query 淹掉就等于没写 */
const ACTIVITY_DETAIL_MAX = 40;

/** 视角中文名复用四视角任务书的 label（那是唯一一份，别在这儿造第二套） */
function perspectiveLabel(name: string): string {
  return PERSPECTIVE_TASK_BOOKS[name as PerspectiveName]?.label ?? name;
}

/** 「调研员·证据与数据视角在搜：新能源车企 2026 销量」——人话一行，谁在查什么一眼看见 */
function activityLabel(activity: BrokerActivity): string {
  const verb = activity.action === "search" ? "在搜" : "在读";
  return `调研员·${perspectiveLabel(activity.perspective)}视角${verb}：${activity.detail.slice(0, ACTIVITY_DETAIL_MAX)}`;
}

/**
 * 落定即回报（调研回流轮 §2）：从对话派出的任务一落定，总编辑就回那段会话报一轮。
 * 门在这里一次判完（终态 + 有来源会话 + 没回报过），真正的等待/组装/落盘在 chat-followup。
 *
 * **已接受的限制**：server 重启期间落定的任务不补回报——启动回收只重排非终态 job，
 * 终态的那些不会再触发本钩子。进度与简报仍在选题卡上，不丢事实；
 * 补一个几小时前的回报比不补更让人困惑。
 *
 * 回流轮可能要等用户当前那轮 settle（最长 10 分钟），所以是 fire-and-forget：
 * 绝不能让它挡住 runner 的下一条任务。
 */
function maybeFollowup(job: ResearchJob, dataDir: string): void {
  if (!isTerminalJobStatus(job.status) || !job.originConversationId || job.followupAt) return;
  const runFollowup = options.followupImpl ?? runResearchFollowup;
  const onEvent = options.onChatFollowupEvent;
  void runFollowup(job, {
    dataDir,
    ...(onEvent
      ? { onDelivered: (e: { conversationId: string; topicId: string }) => onEvent({ type: "chat:followup", ...e }) }
      : {}),
  }).catch((err) => report(`调研回报失败（${job.topicId}）：${errText(err)}`));
}

/**
 * 唯一装配点。`emit` 同时挂在 runner 的 `onJobChanged`（job 级）与 deep-research 的
 * `onProgress`（视角级）上——两级进度必须走同一个出口，见文件头纪律 1。
 * `onActivity` 是第三级（每次真实出网），它不进 SSE 而是进工作日志：等简报的那十几分钟里
 * 界面上唯一在动的东西。emitEngineEvent 自吞错，这里再兜一层 catch。
 */
function wire(dataDir: string): ResearchRunner {
  const emit = (job: ResearchJob): void => {
    options.onResearchEvent?.({ type: "research:updated", topicId: job.topicId });
    maybeFollowup(job, dataDir);
  };
  const runJob = (options.createRunJobImpl ?? createDeepResearchRunJob)({
    dataDir,
    onProgress: emit,
    onActivity: (activity) => {
      void emitEngineEvent({ role: "scout", kind: "work", label: activityLabel(activity) }, dataDir).catch(
        () => undefined,
      );
    },
    onWarn: (message) => report(message),
  });
  return getResearchRunner({
    dataDir,
    runJob,
    onJobChanged: emit,
    onError: (err, ctx) => report(`runner ${ctx.phase} 失败（${ctx.topicId ?? "-"}）：${errText(err)}`),
  });
}

/**
 * 绑定到某个工作区。已经绑在这儿就直接复用；换工作区则停旧实例后重建——
 * `stop()` 只清队列，在途的那条 runJob 会自己跑完并写回**它自己那个** dataDir。
 * 重建后补扫一次：过期 running 回 queued，所有非终态 job 重新排队。
 */
async function bindTo(dataDir: string): Promise<ResearchRunner> {
  if (runner && boundDataDir === dataDir) return runner;
  resetResearchRunner();
  runner = wire(dataDir);
  boundDataDir = dataDir;
  // 先落 running：补扫炸了（台账损坏等）也已经能投递了，状态不该反过来说「没起来」
  status = { state: "running", dataDir };
  const reclaimed = await runner.reclaimStaleJobs();
  status = { state: "running", dataDir, reclaimed: reclaimed.length };
  if (reclaimed.length > 0) {
    report(`回收 ${reclaimed.length} 条中断的调研任务，已重新排队`);
  }
  return runner;
}

/**
 * 启动（或按当前工作区重启）深调研运行时。**幂等**：重复调用等于重新接线。
 * server 启动 fire-and-forget 调用；接不上也只是状态可见，不阻断 server。
 */
export function startResearchRuntime(opts: ResearchRuntimeOptions = {}): Promise<ResearchRuntimeStatus> {
  options = opts;
  started = true;
  return serialize(async () => {
    await bindTo(getDataDir(opts.rootDir));
    return status;
  });
}

/** 两种 kind 共用的投递体。`what` 只用于故障文案（「深调研」/「重新立意」） */
async function postJob(topicId: string, kind: ResearchJobKind, dataDir?: string): Promise<TriggerResult> {
  if (!started) return { accepted: false, reason: RUNTIME_DOWN };
  const target = dataDir ?? boundDataDir ?? getDataDir(options.rootDir);
  const what = kind === "angles" ? "重新立意" : "深调研";
  // 搜索 key 门只管 full：angles job 不出网，它要的是引擎不是搜索
  if (kind === "full" && !(await searchAvailable(target))) {
    return { accepted: false, reason: SEARCH_NOT_CONFIGURED };
  }
  try {
    const active = await serialize(() => bindTo(target));
    return await active.trigger(topicId, kind);
  } catch (err) {
    // 台账写不进去之类的自身故障：照实拒，不假装已排队
    report(`投递失败（${topicId}）：${errText(err)}`);
    return { accepted: false, reason: `${what}投递失败：${errText(err)}` };
  }
}

/** 选题卡按钮 / chat 工具 / 以后的托管触发共用的**唯一投递口** */
export function triggerDeepResearch(topicId: string, dataDir?: string): Promise<TriggerResult> {
  return postJob(topicId, "full", dataDir);
}

/**
 * 重新立意（P1 spec §3.5）：在**当前生效简报**上只重跑立意 pass，产一版只换角度卡的新简报。
 * 同选题有在途研究会被 runner 拒（「研究进行中」）——angles job 永远不和 full job 抢指针。
 */
export function triggerRegenerateAngles(topicId: string, dataDir?: string): Promise<TriggerResult> {
  return postJob(topicId, "angles", dataDir);
}

/** doctor / 状态查询读口 */
export function getResearchRuntimeStatus(): ResearchRuntimeStatus {
  return { ...status };
}

/** 停机（测试与优雅退出）：停投递，在途的 runJob 不打断 */
export function stopResearchRuntime(): void {
  resetResearchRunner();
  runner = null;
  boundDataDir = null;
  started = false;
  options = {};
  status = { state: "stopped" };
}
