/**
 * 研究任务的持有与变更（P6 §3.7）——两处以前的静默行为改成明说：
 * - 持有者闲置满 30 分钟（按 `task.updatedAt`）才可被别的宿主接管；接管留账，旧持有者的迟到写入回 `lease_lost`。
 * - 要求改了不再悄悄新建任务丢掉已交视角：回 `task_changed` + 字段差异，宿主确认（`confirm_task_change`）后才换任务。
 */
import { HostResearchError, type HostResearchTask } from "../modules/research/host-research-store.js";
import { getJob, upsertJob, PERSPECTIVE_NAMES } from "../modules/research/research-job-store.js";
import type { CreativeTask } from "../modules/writing/creative-task.js";

/** 与稿件认领的租约同长（claims.ts）：闲置这么久没有任何写入，才算人走了 */
export const TASK_IDLE_MS = 30 * 60_000;

const TASK_FIELDS = ["platform", "requirements", "direction"] as const;

/**
 * 当前宿主要写这份任务：同宿主直接过；持有者还在活动期 → `task_owned`（被接管过的旧持有者 → `lease_lost`）；
 * 持有者闲置满 30 分钟 → 当场接管并记账。返回 true = 刚接管，调用方负责落盘。
 */
export async function holdTask(task: HostResearchTask, host: string, dir: string, now = Date.now()): Promise<boolean> {
  if (task.host === host) return false;
  const idleUntil = Date.parse(task.updatedAt) + TASK_IDLE_MS;
  if (Number.isNaN(idleUntil) || now < idleUntil) {
    if (task.takeovers?.some((t) => t.from === host))
      throw new HostResearchError("lease_lost", `这项研究在你闲置满 30 分钟后已由 ${task.host} 接管，迟到结果未写入；请重新 prepare 读取当前任务`, { holder: task.host });
    throw new HostResearchError("task_owned", `当前研究任务由 ${task.host} 持有；不能静默接管其在途研究（它闲置满 30 分钟后才可接管）`, {
      holder: task.host,
      ...(Number.isNaN(idleUntil) ? {} : { idle_expires_at: new Date(idleUntil).toISOString() }),
    });
  }
  task.takeovers = [...(task.takeovers ?? []), { from: task.host, to: host, at: new Date(now).toISOString() }];
  task.host = host;
  // 台账上的执行者跟着换：视角进度只由当前持有者回写
  const job = await getJob(task.topicId, dir);
  if (job?.executedBy?.kind === "host" && job.startedAt === task.createdAt) await upsertJob({ ...job, executedBy: { kind: "host", host } }, dir);
  return true;
}

function field(task: CreativeTask, key: (typeof TASK_FIELDS)[number]): string {
  return task[key]?.trim() ?? "";
}

/** 要求变了、宿主还没确认：列出差异、原任务留着不动，确认和保留两条路都给出来 */
export function taskChangedError(current: HostResearchTask, next: CreativeTask): HostResearchError {
  const diff = Object.fromEntries(TASK_FIELDS
    .filter((key) => field(current.creativeTask, key) !== field(next, key))
    .map((key) => [key, { before: current.creativeTask[key] ?? null, after: next[key] ?? null }]));
  const submitted = PERSPECTIVE_NAMES.filter((name) => current.perspectives[name]);
  return new HostResearchError(
    "task_changed",
    `研究要求与当前任务不同，未新建任务，当前任务（已交 ${submitted.length} 个视角）原样保留。确认按新要求重做调研就照 next_action 带 confirm_task_change:true 再 prepare（旧任务的视角不会带进新任务）；要求其实没变就照 keep_current 继续。`,
    {
      diff,
      current_task_id: current.taskId,
      current_status: current.status,
      submitted_perspectives: submitted,
      next_action: {
        tool: "autocrew_scout",
        params: { action: "prepare", topic_id: current.topicId, ...Object.fromEntries(TASK_FIELDS.map((key) => [key, next[key] ?? ""])), confirm_task_change: true },
        message: "先向创作者说明 diff 里改了什么、会重做调研，再确认新建任务",
      },
      keep_current: { tool: "autocrew_scout", params: { action: "pack", topic_id: current.topicId, task_id: current.taskId } },
    },
  );
}
