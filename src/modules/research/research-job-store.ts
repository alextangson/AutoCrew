/**
 * Research Job Store — 深调研任务台账（spec §2）：`<dataDir>/research/jobs.jsonl`，
 * append-only、按 **topicId** latest-wins（复用收件箱台账那套读写纪律）。
 *
 * 三条硬约束（同 inbox-store，理由在这里同样成立）：
 * 1. **不删**：失败/过期的 job 也留着——「为什么这次调研没成」要能回溯，
 *    所以本模块不提供删除 API；重跑是 append 一条新的 queued，不是覆盖历史。
 * 2. **append 必须 fsync**：job 是跨进程防重的唯一依据（lease 在 claimedAt 上），
 *    停在页缓存里的一行崩溃后就等于「这个选题从没被调研过」，会重复跑一遍。
 * 3. **dataDir 由调用方传入**：调研落在选题所在工作区，不跟随「当前工作区」。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** 五态（spec §2）：queued/running 为非终态，其余三态落定。partial = 部分视角成功但已出简报 */
export type ResearchJobStatus = "queued" | "running" | "succeeded" | "partial" | "failed";
export type PerspectiveName = "audience" | "evidence" | "counter" | "benchmark";
export type PerspectiveStatus = "pending" | "running" | "succeeded" | "failed";

/** 四视角固定顺序：job 卡上的进度条按这个序渲染，别在别处重排 */
export const PERSPECTIVE_NAMES: readonly PerspectiveName[] = [
  "audience",
  "evidence",
  "counter",
  "benchmark",
];

export interface PerspectiveState {
  name: PerspectiveName;
  status: PerspectiveStatus;
  /** 失败原因码（deadline/quota/schema_invalid…），选题卡逐视角点名用 */
  errorCode?: string;
}

/**
 * 任务类型（P1 spec §3.5）。`full` = 四视角深调研；`angles` = 只在当前简报上重跑一次立意。
 * **缺省即 full**：存量台账里一行 kind 都没有，加了默认值它们才继续是深调研。
 */
export type ResearchJobKind = "full" | "angles";

export interface ResearchJob {
  /** 台账主键：一个选题同时只有一个「当前 job」 */
  topicId: string;
  status: ResearchJobStatus;
  /**
   * 缺席 = `full`（存量记录全是这样）。angles job 不跑视角，
   * 所以它的 `perspectives` 恒为 `[]`——进度条那一栏什么都不画。
   */
  kind?: ResearchJobKind;
  /** running 的 lease 起点；跨进程/重启防重靠它（§2） */
  claimedAt?: string;
  /** 本轮任务入队时刻（重跑会刷新成新一轮的起点） */
  startedAt: string;
  /** 本轮落定时刻（succeeded/partial/failed 都盖） */
  settledAt?: string;
  perspectives: PerspectiveState[];
  /**
   * **当前有效简报的 revision**（§2「重跑读语义」）：只在 succeeded/partial 时推进，
   * 重跑失败保留旧值——旧简报在新版成功前一直有效。
   */
  briefRevision?: number;
  errorCode?: string;
  failReason?: string;
  /** 触发时选题「标题+描述」的 hash；与当前选题不符 = 简报已过期（§2） */
  topicHash: string;
  /**
   * 派这活的那段对话（调研回流轮）。**只有从聊天派出的任务才有**——写稿闸口自动补的
   * 调研、选题卡按钮触发的都没有来源会话，缺席即天然不回流，不需要再加一道开关。
   * 由 chat-persist 在本轮落盘拿到 convId 后回填（首轮的会话此前还不存在）。
   */
  originConversationId?: string;
  /** 已经回报过的时刻。防重的持久依据：一个任务只回报一次 */
  followupAt?: string;
}

const RESEARCH_DIR = "research";
const JOBS_FILE = "jobs.jsonl";

export function isTerminalJobStatus(status: ResearchJobStatus): boolean {
  return status === "succeeded" || status === "partial" || status === "failed";
}

/**
 * 简报过期判定的锚（§2）。**首尾空白归一后**再 hash：给标题末尾补个空格不该让
 * 满血简报被标成「基于旧版选题」；标题/描述本身改了才算改。
 * 两字段用数组 JSON 序列化后再 hash，避免「标题末尾带分隔符」拼出同一个串。
 */
export function topicHashOf(title: string, description: string): string {
  const payload = JSON.stringify([title.trim(), description.trim()]);
  return crypto.createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 16);
}

/** 新一轮 job 的视角初值：四项全 pending */
export function pendingPerspectives(): PerspectiveState[] {
  return PERSPECTIVE_NAMES.map((name) => ({ name, status: "pending" as PerspectiveStatus }));
}

function jobsPath(dataDir: string): string {
  return path.join(dataDir, RESEARCH_DIR, JOBS_FILE);
}

async function readJournal(dataDir: string): Promise<ResearchJob[]> {
  let raw: string;
  try {
    raw = await fs.readFile(jobsPath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const jobs: ResearchJob[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ResearchJob;
      // 单行损坏（崩在写一半）不清空整个读视图，也不让半条记录冒充 job
      if (parsed && typeof parsed.topicId === "string") jobs.push(parsed);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return jobs;
}

/**
 * 唯一写入口：append + fsync。传进来的 job 就是**落定后的完整记录**——
 * 读-改-写由调用方（runner）做，台账这层不猜补丁语义（`undefined` 字段
 * 经 JSON.stringify 自然消失，释放 lease 就是把 claimedAt 置 undefined）。
 */
export async function upsertJob(job: ResearchJob, dataDir: string): Promise<ResearchJob> {
  await fs.mkdir(path.join(dataDir, RESEARCH_DIR), { recursive: true });
  const fh = await fs.open(jobsPath(dataDir), "a");
  try {
    await fh.writeFile(JSON.stringify(job) + "\n", "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  return job;
}

/**
 * 读-改-追加一个字段。**只给回流轮那两个标记用**：它们不属于 runner 的状态机
 * （runner 只写 queued/running/落定三处），却要落在同一条记录上，所以在这层给两个
 * 语义明确的小写口，而不是开一个「随便打补丁」的通用 API——台账不猜补丁语义的纪律还在。
 * job 不存在返回 null（选题被删/从没调研过）。
 */
async function amendJob(
  topicId: string,
  patch: Partial<Pick<ResearchJob, "originConversationId" | "followupAt">>,
  dataDir: string,
): Promise<ResearchJob | null> {
  const job = await getJob(topicId, dataDir);
  if (!job) return null;
  return upsertJob({ ...job, ...patch }, dataDir);
}

/**
 * 回填「这活是哪段对话派的」。本轮 turn 落盘后才知道 convId（首轮成功前不建会话），
 * 所以是回填不是直写。任务可能已经落定——照样打标，只是那一刻的回流钩子已经错过了。
 */
export function noteJobOrigin(
  topicId: string,
  conversationId: string,
  dataDir: string,
): Promise<ResearchJob | null> {
  return amendJob(topicId, { originConversationId: conversationId }, dataDir);
}

/** 盖「已回报」戳。回流轮真的落盘之后才盖——没发出去的回报不算回报 */
export function markJobFollowedUp(
  topicId: string,
  at: string,
  dataDir: string,
): Promise<ResearchJob | null> {
  return amendJob(topicId, { followupAt: at }, dataDir);
}

export async function getJob(topicId: string, dataDir: string): Promise<ResearchJob | null> {
  const journal = await readJournal(dataDir);
  for (let i = journal.length - 1; i >= 0; i--) {
    if (journal[i].topicId === topicId) return journal[i];
  }
  return null;
}

/**
 * latest-wins 读视图，**按 startedAt 升序**（老的在前）：启动回收要按入队序重排，
 * 「最老的未落定 job」也靠这个序。列表 UI 要新的在前自己 reverse。
 */
export async function listJobs(dataDir: string): Promise<ResearchJob[]> {
  const byTopic = new Map<string, ResearchJob>();
  for (const job of await readJournal(dataDir)) byTopic.set(job.topicId, job);
  return [...byTopic.values()].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.topicId.localeCompare(b.topicId),
  );
}
