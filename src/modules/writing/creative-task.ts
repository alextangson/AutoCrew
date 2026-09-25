/** The creator's original brief, shared by research, planning, writing and review. */
import crypto from "node:crypto";

export interface CreativeTask {
  version: 1;
  platform?: string;
  requirements?: string;
  direction?: string;
}

export type CreativeTaskRequest = Partial<Omit<CreativeTask, "version">>;
const FIELDS = ["platform", "requirements", "direction"] as const;

/** Omission inherits; an explicit empty field clears. Never summarize the creator's words. */
export function createCreativeTask(req: CreativeTaskRequest, inherited?: CreativeTask): CreativeTask {
  const task: CreativeTask = { version: 1 };
  for (const key of FIELDS) {
    const value = req[key] === undefined ? inherited?.[key] : req[key];
    if (typeof value === "string" && value.trim()) task[key] = value;
  }
  return task;
}

/** Fill omitted task fields without adding version metadata to a runtime writing request. */
export function inheritCreativeTask<T extends CreativeTaskRequest>(req: T, task?: CreativeTask): T {
  return {
    ...req,
    ...Object.fromEntries(FIELDS.filter(key => req[key] === undefined && task?.[key] !== undefined).map(key => [key, task![key]])),
  };
}

export function creativeTaskHash(task?: CreativeTask): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify(FIELDS.map(key => task?.[key]?.trim() ?? "")))
    .digest("hex").slice(0, 16);
}

/** Legacy briefs can still serve existing platform-only requests; new plans need new research. */
export function creativeTaskMatches(task: CreativeTask, frozen?: CreativeTask): boolean {
  if (!frozen || !FIELDS.some(key => frozen[key]?.trim())) return !task.requirements?.trim() && !task.direction?.trim();
  return creativeTaskHash(task) === creativeTaskHash(frozen);
}

export function renderCreativeTask(task?: CreativeTask): string {
  if (!task || !FIELDS.some(key => task[key]?.trim())) return "";
  return [
    `【统一创作任务书 · ${creativeTaskHash(task)}】`,
    "调研、立意、写作和审稿须遵循同一份要求；材料不足请标出缺口，不可歪曲事实迎合主张。",
    ...(task.platform ? [`目标平台：${task.platform}`] : []),
    ...(task.requirements ? ["创作者完整要求（保留原文）：", task.requirements] : []),
    ...(task.direction ? ["创作者指定方向：", task.direction] : []),
  ].join("\n");
}
