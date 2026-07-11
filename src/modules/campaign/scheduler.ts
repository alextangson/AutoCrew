import {
  claimCampaignTask,
  completeCampaignTask,
  failCampaignTask,
  getCampaign,
} from "../../storage/campaign-store.js";
import { executeCampaignAgentTask, type CampaignTaskOutput } from "./agent-runner.js";
import type { CampaignTask } from "./domain.js";

export interface CampaignBatchResult {
  campaignId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  results: Array<{ taskId: string; runId: string; ok: boolean; artifactTitle?: string; error?: string }>;
}

interface SchedulerDeps {
  executeTask?: (
    campaignId: string,
    task: CampaignTask,
    runId: string,
    dataDir?: string,
  ) => Promise<CampaignTaskOutput>;
}

export async function runCampaignReadyTasks(
  campaignId: string,
  opts: { maxTasks?: number; onProgress?: (event: Record<string, unknown>) => void } = {},
  dataDir?: string,
  deps: SchedulerDeps = {},
): Promise<CampaignBatchResult> {
  const initial = await getCampaign(campaignId, dataDir);
  if (!initial) throw new Error(`Campaign 不存在:${campaignId}`);
  if (initial.status !== "active") throw new Error("Campaign 必须先启动为 active");
  const maxTasks = Math.max(1, Math.min(opts.maxTasks ?? 2, 10));
  const execute = deps.executeTask ?? executeCampaignAgentTask;
  const results: CampaignBatchResult["results"] = [];

  for (let index = 0; index < maxTasks; index++) {
    const claimed = await claimCampaignTask(campaignId, dataDir);
    if (!claimed) break;
    opts.onProgress?.({ phase: "task_start", campaignId, taskId: claimed.task.id, runId: claimed.run.id, label: claimed.task.title });
    try {
      const output = await execute(campaignId, claimed.task, claimed.run.id, dataDir);
      await completeCampaignTask(campaignId, claimed.run.id, output, dataDir);
      results.push({ taskId: claimed.task.id, runId: claimed.run.id, ok: true, artifactTitle: output.title });
      opts.onProgress?.({ phase: "task_done", campaignId, taskId: claimed.task.id, runId: claimed.run.id, label: output.title });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failCampaignTask(campaignId, claimed.run.id, message, dataDir);
      results.push({ taskId: claimed.task.id, runId: claimed.run.id, ok: false, error: message });
      opts.onProgress?.({ phase: "task_failed", campaignId, taskId: claimed.task.id, runId: claimed.run.id, label: message });
    }
  }

  return {
    campaignId,
    attempted: results.length,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}
