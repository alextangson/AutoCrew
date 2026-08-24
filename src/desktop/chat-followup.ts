/**
 * 调研回流轮（Batch 3）——深调研的简报落盘（或调研失败）那一刻，总编辑自动回到
 * **派活的那段对话**发一轮回报。
 *
 * 为什么要有：总编辑对话是严格的请求-响应，用户从聊天派出深度调研后，一轮就结束了，
 * 没有任何机制唤醒它；简报落盘只点亮选题卡，创始人只能回一句「好」然后石沉大海。
 * 角度卡上线后这个断点更痛：调研完成 = 角度候选就绪 = 正该总编辑回来摆卡请人拍板。
 *
 * 四条纪律：
 * 1. **只回报有来源会话的任务**：写稿闸口自动补的调研、选题卡按钮触发的都没有
 *    `originConversationId`，天然被挡在门外——不需要第二个开关。
 * 2. **一个任务只回报一次**：持久防重靠 job.followupAt，同进程重入靠下面的 in-flight 集合。
 * 3. **不打断用户正在进行的那一轮**：等它 settle 再插话，等不到（10 分钟）就放弃并留痕
 *    ——放弃不丢事实，简报仍在选题卡上。
 * 4. **失败也回报**：调研失败照样回一轮说清原因，不静默。回流轮**自己**失败（模型/落盘）
 *    则 warn + 引擎事件留痕，不重试、不炸 runtime。
 *
 * 依赖成环是这条能力的固有形状（对话能派调研、调研要能回话）：
 * research-runtime → 本模块 → chat-persist → chat-router → research-runtime。
 * 环里每一处引用都在函数体内、没有模块求值期的调用，ESM 的实时绑定能正常解开——
 * **别在本模块的顶层做任何会立即执行的事**（顺手加一句 `await`/自启动就会踩进 TDZ）。
 */
import { getConversation } from "../storage/conversation-store.js";
import { getTopic } from "../storage/local-store.js";
import { loadLatestBrief, type AngleCard } from "../modules/research/brief-store.js";
import {
  markJobFollowedUp,
  type PerspectiveName,
  type ResearchJob,
} from "../modules/research/research-job-store.js";
import { PERSPECTIVE_TASK_BOOKS } from "../modules/research/research-perspectives.js";
import { runPersistedChatTurn } from "./chat-persist.js";
import { emitEngineEvent } from "./event-hub.js";
import { hasActiveTurnForConversation } from "./turn-registry.js";

/** 回报消息的开头暗号。SYSTEM_PROMPT 第 28 条按它识别「这不是用户在说话」——两处必须一致 */
export const FOLLOWUP_PREFIX = "【调研回报】";

/** 等用户那一轮 settle：四视角都跑完了，多等几秒不算什么 */
const BUSY_POLL_MS = 3000;
/** 等待上限。超过就放弃——回报的价值随时间衰减，硬插进半小时后的对话只会让人莫名其妙 */
const BUSY_DEADLINE_MS = 10 * 60 * 1000;

/** 组装回报所需的全部事实（确定层；由调用方从台账/简报取好再传进来） */
export interface FollowupReport {
  topicTitle: string;
  /** true = 这轮调研没出简报，下面只有 failReason 有意义 */
  failed: boolean;
  failReason?: string;
  briefRevision?: number;
  /** 没跑成的视角（partial 时逐个点名） */
  missingPerspectives?: PerspectiveName[];
  summary?: string;
  angleCards?: AngleCard[];
  /** 简报的材料缺口并集；没出角度卡时原因就在里面 */
  gaps?: string[];
}

function perspectiveLabel(name: PerspectiveName): string {
  return PERSPECTIVE_TASK_BOOKS[name]?.label ?? name;
}

/** 角度候选块：有卡就逐张摆（id/切入点/论点/禁区），没卡就说清为什么没有 */
function angleBlock(cards: AngleCard[], gaps: string[]): string {
  if (cards.length > 0) {
    const lines = cards.map(
      (c) => `- ${c.id} · ${c.angle}｜论点:${c.thesis}｜不写:${c.antiScope}`,
    );
    return `角度候选(${cards.length} 张):\n${lines.join("\n")}`;
  }
  // 没出卡不是「没什么好说的」：原因由综合层写进 gaps（如「没挑出可引用的证据」）
  const why = gaps.filter((g) => g.includes("角度卡"));
  return `角度候选:这轮没出角度卡——${why.length > 0 ? why.join("；") : "简报里没写原因,去选题卡看这份简报"}`;
}

/**
 * 回报文案（纯函数，锁死在测试里）。总编辑读到它之后怎么讲给用户，由第 28 条提示词管；
 * 这里只负责把事实摆全：哪条选题、第几版、缺哪个视角、摘要、每张角度卡。
 */
export function buildFollowupMessage(r: FollowupReport): string {
  const title = `选题《${r.topicTitle}》`;
  if (r.failed) {
    return `${FOLLOWUP_PREFIX}${title}调研失败:${r.failReason || "未知原因"}`;
  }
  const missing = r.missingPerspectives ?? [];
  const partial = missing.length > 0 ? `,缺${missing.map(perspectiveLabel).join("、")}视角` : "";
  const head = `${FOLLOWUP_PREFIX}${title}深度调研完成(第 ${r.briefRevision ?? 1} 版简报${partial})。`;
  return [
    head,
    `摘要:${r.summary?.trim() || "（简报没给摘要）"}`,
    angleBlock(r.angleCards ?? [], r.gaps ?? []),
  ].join("\n");
}

export interface FollowupDeps {
  /** 选题所在工作区（与调研任务同一口径） */
  dataDir: string;
  /** 回流轮落盘成功后的出口 → SSE，让前端把新回报直接推到眼前 */
  onDelivered?: (e: { conversationId: string; topicId: string }) => void;
  /** 以下全是测试注入口，生产一个都不传 */
  runTurn?: typeof runPersistedChatTurn;
  isBusy?: (conversationId: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 同进程重入兜底：followupAt 要等这一轮真跑完才盖，中间这段窗口靠它挡住第二次触发 */
const inFlight = new Set<string>();

function warn(message: string): void {
  console.warn(`[chat-followup] ${message}`);
}

/** 台账 + 简报 → 回报事实。简报读不出来算失败形态：照实说，不硬凑一条空回报 */
async function collectReport(job: ResearchJob, dataDir: string): Promise<FollowupReport> {
  const topic = await getTopic(job.topicId, dataDir);
  const topicTitle = topic?.title || job.topicId;
  if (job.status === "failed") {
    return { topicTitle, failed: true, failReason: job.failReason ?? job.errorCode ?? "调研失败" };
  }
  const brief = await loadLatestBrief(job.topicId, dataDir, (m) => warn(m));
  if (!brief) {
    return {
      topicTitle,
      failed: true,
      failReason: "四视角跑完了,但简报读不出来(文件损坏或已被清理)——去选题卡重跑一轮",
    };
  }
  return {
    topicTitle,
    failed: false,
    briefRevision: brief.revision,
    missingPerspectives: brief.missingPerspectives ?? [],
    summary: brief.summary,
    angleCards: brief.angleCards ?? [],
    gaps: brief.gaps ?? [],
  };
}

/** 等这段会话空出来。true = 可以插话；false = 等到上限还没空，本轮放弃 */
async function waitUntilFree(conversationId: string, deps: FollowupDeps): Promise<boolean> {
  const isBusy = deps.isBusy ?? hasActiveTurnForConversation;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + BUSY_DEADLINE_MS;
  while (isBusy(conversationId)) {
    if (now() >= deadline) return false;
    await sleep(BUSY_POLL_MS);
  }
  return true;
}

export type FollowupOutcome = "delivered" | "skipped" | "failed";

/**
 * 跑一轮回报。**永不抛**——它挂在 runner 的落定回调上，炸了不能拖垮调研运行时。
 * 返回值只给测试与调用方留痕用：skipped = 门没过（不该回报/会话没了/等不到空），
 * failed = 该回报但这一轮没成（已留痕，不重试）。
 */
export async function runResearchFollowup(job: ResearchJob, deps: FollowupDeps): Promise<FollowupOutcome> {
  const conversationId = job.originConversationId;
  if (!conversationId || job.followupAt) return "skipped";
  if (inFlight.has(job.topicId)) return "skipped";
  inFlight.add(job.topicId);
  try {
    // 会话已删就静默放弃：回收站里的对话不值得为一条回报复活
    if (!(await getConversation(conversationId, deps.dataDir))) return "skipped";
    if (!(await waitUntilFree(conversationId, deps))) {
      warn(`会话 ${conversationId} 十分钟内一直在忙,放弃回报（简报仍在选题卡上）：${job.topicId}`);
      return "skipped";
    }
    const message = buildFollowupMessage(await collectReport(job, deps.dataDir));
    const result = await (deps.runTurn ?? runPersistedChatTurn)({
      message,
      conversationId,
      dataDir: deps.dataDir,
      origin: "system",
    });
    if (result.ok !== true) {
      await reportFailure(job.topicId, String(result.error ?? "未知错误"), deps.dataDir);
      return "failed";
    }
    await markJobFollowedUp(job.topicId, new Date().toISOString(), deps.dataDir);
    deps.onDelivered?.({ conversationId, topicId: job.topicId });
    return "delivered";
  } catch (err) {
    await reportFailure(job.topicId, err instanceof Error ? err.message : String(err), deps.dataDir);
    return "failed";
  } finally {
    inFlight.delete(job.topicId);
  }
}

/** 回流轮自己失败：日志 + 工作日志各留一份，不重试。事实（简报）没丢，只是没人来说 */
async function reportFailure(topicId: string, detail: string, dataDir: string): Promise<void> {
  warn(`回报没发出去（${topicId}）：${detail}`);
  try {
    await emitEngineEvent(
      { role: "editor", kind: "work", label: `调研回报没发出去(${topicId})：${detail.slice(0, 80)}` },
      dataDir,
    );
  } catch {
    /* 观测层不得破坏执行层 */
  }
}

/** 测试用：清空进程内的在途集合 */
export function resetFollowupState(): void {
  inFlight.clear();
}
