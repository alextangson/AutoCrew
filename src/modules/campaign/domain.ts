/**
 * Campaign is the durable aggregate above AutoCrew's existing content flows.
 * Personal creator operations and managed customer growth use the same model;
 * mode controls defaults and policy, not storage shape.
 */

export type CampaignMode = "personal" | "managed_growth";

export type CampaignStatus =
  | "draft"
  | "planning"
  | "ready"
  | "active"
  | "paused"
  | "completed"
  | "archived";

export const PROMOTION_CHANNELS = [
  "website",
  "seo",
  "content",
  "xiaohongshu",
  "wechat_mp",
  "douyin",
  "bilibili",
  "email",
  "reddit",
  "x",
  "linkedin",
  "product_hunt",
  "paid_ads",
] as const;

export type PromotionChannel = (typeof PROMOTION_CHANNELS)[number];

export type CampaignAgentRole =
  | "growth_lead"
  | "market_researcher"
  | "content_strategist"
  | "copywriter"
  | "seo_specialist"
  | "channel_operator"
  | "paid_media_specialist"
  | "performance_analyst";

export type GovernedAction =
  | "external_publish"
  | "send_message"
  | "paid_spend"
  | "change_website"
  | "export_customer_data";

export interface CampaignAgent {
  id: string;
  role: CampaignAgentRole;
  name: string;
  mission: string;
  capabilities: string[];
  approvalRequiredFor: GovernedAction[];
}

export interface CampaignTeam {
  id: string;
  planner: "rules_v1";
  version: number;
  agents: CampaignAgent[];
  createdAt: string;
}

export type CampaignTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "awaiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface CampaignTask {
  id: string;
  title: string;
  description: string;
  assigneeRole: CampaignAgentRole;
  channel?: PromotionChannel;
  status: CampaignTaskStatus;
  dependsOn: string[];
  requiredApproval?: GovernedAction;
  createdAt: string;
  updatedAt: string;
}

export type CampaignRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface CampaignRun {
  id: string;
  taskId: string;
  agentId: string;
  status: CampaignRunStatus;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export type CampaignArtifactKind =
  | "research"
  | "strategy"
  | "content"
  | "creative"
  | "report"
  | "website_change";

export interface CampaignArtifact {
  id: string;
  taskId: string;
  runId?: string;
  kind: CampaignArtifactKind;
  title: string;
  uri: string;
  createdAt: string;
}

export interface CampaignApproval {
  id: string;
  taskId: string;
  runId?: string;
  action: GovernedAction;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedAt: string;
  decidedAt?: string;
  note?: string;
}

export interface CampaignMetricSnapshot {
  id: string;
  channel: PromotionChannel;
  capturedAt: string;
  values: Record<string, number>;
  source: "manual" | "platform_export" | "connector";
}

export interface CampaignBrief {
  targetUrl?: string;
  businessDescription?: string;
  goals: string[];
  audience?: string;
  channels: PromotionChannel[];
  constraints: string[];
}

export interface Campaign {
  schemaVersion: 1;
  id: string;
  name: string;
  mode: CampaignMode;
  status: CampaignStatus;
  brief: CampaignBrief;
  team: CampaignTeam | null;
  tasks: CampaignTask[];
  runs: CampaignRun[];
  artifacts: CampaignArtifact[];
  approvals: CampaignApproval[];
  metrics: CampaignMetricSnapshot[];
  createdAt: string;
  updatedAt: string;
}

const STATUS_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ["planning", "archived"],
  planning: ["ready", "draft", "archived"],
  ready: ["active", "planning", "archived"],
  active: ["paused", "completed"],
  paused: ["active", "completed", "archived"],
  completed: ["active", "archived"],
  archived: [],
};

export function allowedCampaignTransitions(status: CampaignStatus): CampaignStatus[] {
  return [...STATUS_TRANSITIONS[status]];
}

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function isCampaignMode(value: unknown): value is CampaignMode {
  return value === "personal" || value === "managed_growth";
}

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return typeof value === "string" && value in STATUS_TRANSITIONS;
}

export function isPromotionChannel(value: unknown): value is PromotionChannel {
  return typeof value === "string" && (PROMOTION_CHANNELS as readonly string[]).includes(value);
}
