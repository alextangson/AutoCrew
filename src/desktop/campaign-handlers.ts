import {
  PROMOTION_CHANNELS,
  allowedCampaignTransitions,
  isCampaignMode,
  isCampaignStatus,
  isPromotionChannel,
  type CampaignBrief,
  type PromotionChannel,
} from "../modules/campaign/domain.js";
import {
  buildCampaignTeam,
  createCampaign,
  getCampaign,
  listCampaigns,
  retryCampaignTask,
  readCampaignArtifact,
  transitionCampaign,
} from "../storage/campaign-store.js";
import { isCampaignId } from "../storage/entity-id.js";
import { runCampaignReadyTasks } from "../modules/campaign/scheduler.js";

type Payload = Record<string, unknown>;

function dataDir(payload: Payload): string | undefined {
  return (payload._dataDir as string) || undefined;
}

function cleanStrings(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, max);
}

function validateTargetUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("target_url 只支持 http/https");
  return parsed.toString();
}

function defaultChannels(targetUrl: string | undefined): PromotionChannel[] {
  return targetUrl ? ["website", "seo", "content"] : ["content"];
}

export async function campaignListHandler(payload: Payload): Promise<Record<string, unknown>> {
  try {
    return { ok: true, data: { campaigns: await listCampaigns(dataDir(payload)) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function campaignGetHandler(payload: Payload): Promise<Record<string, unknown>> {
  if (!isCampaignId(payload.id)) return { ok: false, error: "需要合法 campaign id" };
  try {
    const campaign = await getCampaign(payload.id, dataDir(payload));
    if (!campaign) return { ok: false, error: "Campaign 不存在或已损坏" };
    return { ok: true, data: { campaign, allowedTransitions: allowedCampaignTransitions(campaign.status) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function campaignCreateHandler(payload: Payload): Promise<Record<string, unknown>> {
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name || name.length > 120) return { ok: false, error: "name 必须为 1-120 字" };
  if (!isCampaignMode(payload.mode)) return { ok: false, error: "mode 必须是 personal 或 managed_growth" };
  const goals = cleanStrings(payload.goals, 12);
  if (goals.length === 0) return { ok: false, error: "至少需要一个推广目标" };

  try {
    const targetUrl = validateTargetUrl(payload.target_url);
    const businessDescription = typeof payload.business_description === "string"
      ? payload.business_description.trim().slice(0, 5_000)
      : undefined;
    if (!targetUrl && !businessDescription) return { ok: false, error: "target_url 与 business_description 至少提供一个" };

    const rawChannels = cleanStrings(payload.channels, PROMOTION_CHANNELS.length);
    if (rawChannels.some((channel) => !isPromotionChannel(channel))) {
      return { ok: false, error: `不支持的渠道；可选：${PROMOTION_CHANNELS.join("、")}` };
    }
    const channels = (rawChannels.length > 0 ? rawChannels : defaultChannels(targetUrl)) as PromotionChannel[];
    const brief: CampaignBrief = {
      ...(targetUrl ? { targetUrl } : {}),
      ...(businessDescription ? { businessDescription } : {}),
      goals,
      ...(typeof payload.audience === "string" && payload.audience.trim()
        ? { audience: payload.audience.trim().slice(0, 2_000) }
        : {}),
      channels: [...new Set(channels)],
      constraints: cleanStrings(payload.constraints, 30),
    };
    const campaign = await createCampaign({ name, mode: payload.mode, brief }, dataDir(payload));
    return { ok: true, data: { campaign } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function campaignPlanTeamHandler(payload: Payload): Promise<Record<string, unknown>> {
  if (!isCampaignId(payload.id)) return { ok: false, error: "需要合法 campaign id" };
  try {
    const campaign = await buildCampaignTeam(payload.id, dataDir(payload));
    if (!campaign) return { ok: false, error: "Campaign 不存在或已损坏" };
    return { ok: true, data: { campaign, team: campaign.team, tasks: campaign.tasks } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function campaignTransitionHandler(payload: Payload): Promise<Record<string, unknown>> {
  if (!isCampaignId(payload.id)) return { ok: false, error: "需要合法 campaign id" };
  if (!isCampaignStatus(payload.target_status)) return { ok: false, error: "需要合法 target_status" };
  try {
    const campaign = await transitionCampaign(payload.id, payload.target_status, dataDir(payload));
    if (!campaign) return { ok: false, error: "Campaign 不存在或已损坏" };
    return { ok: true, data: { campaign, allowedTransitions: allowedCampaignTransitions(campaign.status) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function campaignRunReadyHandler(
  payload: Payload,
  ctx?: { onProgress?: (event: Record<string, unknown>) => void },
): Promise<Record<string, unknown>> {
  if (!isCampaignId(payload.id)) return { ok: false, error: "需要合法 campaign id" };
  const maxTasks = typeof payload.max_tasks === "number" && Number.isInteger(payload.max_tasks)
    ? payload.max_tasks
    : 2;
  try {
    const batch = await runCampaignReadyTasks(
      payload.id,
      { maxTasks, ...(ctx?.onProgress ? { onProgress: ctx.onProgress } : {}) },
      dataDir(payload),
    );
    const campaign = await getCampaign(payload.id, dataDir(payload));
    return { ok: true, data: { batch, campaign } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function campaignRetryTaskHandler(payload: Payload): Promise<Record<string, unknown>> {
  if (!isCampaignId(payload.id)) return { ok: false, error: "需要合法 campaign id" };
  if (typeof payload.task_id !== "string" || !payload.task_id) return { ok: false, error: "需要 task_id" };
  try {
    const campaign = await retryCampaignTask(payload.id, payload.task_id, dataDir(payload));
    if (!campaign) return { ok: false, error: "Campaign 或任务不存在" };
    return { ok: true, data: { campaign } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function campaignArtifactGetHandler(payload: Payload): Promise<Record<string, unknown>> {
  if (!isCampaignId(payload.id)) return { ok: false, error: "需要合法 campaign id" };
  if (typeof payload.artifact_id !== "string" || !payload.artifact_id) return { ok: false, error: "需要 artifact_id" };
  try {
    const markdown = await readCampaignArtifact(payload.id, payload.artifact_id, dataDir(payload));
    if (markdown === null) return { ok: false, error: "产物不存在或路径不合法" };
    return { ok: true, data: { artifactId: payload.artifact_id, markdown } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
