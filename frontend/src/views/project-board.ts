/**
 * 剪辑看板的纯逻辑（P6 §13.4-C / G）：步骤、异常态、心跳是否过期、封面分组。
 *
 * 四道门的状态由服务端算好（/api/project-review 的 gates），这里不重推批准规则，
 * 只决定「页面该展开哪一步、该提示什么」。步骤是 status=editing 里的展示步骤，不是状态。
 */
import { durationText } from "../time-format";

export type Artifact = { path: string; sha256: string; role: string; version?: number; reported_at: string; generation?: number };
export type GateStatus = "pending" | "approved" | "rejected" | "invalidated";
export type GateView = {
  gate: string; status: GateStatus; artifact_sha256: string | null; reject_sha256: string | null; reason?: string;
  approval: { artifact_sha256: string; approved_at: string } | null;
  rejection: { note: string; artifact_sha256: string; rejected_at: string } | null;
};
/** 成片待审卡（服务端读出的事实；指纹只在点「通过成片」时重算） */
export type FinalCutCard = {
  path: string; name: string; sha256: string; sha8: string; role: string; external: boolean;
  duration_ms: number | null; exported_at: string | null; jianying_draft: string | null; missing: boolean; changed: boolean;
};
export type CoverPick = { sha256: string; path: string; version?: number };
export type ProjectReview = {
  ok?: boolean; enabled: boolean; status?: string | null; error?: string;
  title?: string; platform?: string; draft_hash?: string; manifest_hash?: string; generation?: number;
  handoff_valid?: boolean; project?: { project_root: string } | null;
  handoff?: { generation: number; at: string; aroll_path: string; draft_hash: string; hash: string } | null;
  decisions?: { title: string; cover_text: string; target_seconds: number; confirmed_at: string } | null;
  execution?: {
    session_id: string; jianying_draft?: string;
    heartbeat: { result: string; next_action: string; reported_at: string; session_id: string; error?: string };
    artifacts: Artifact[];
  } | null;
  cover_selection?: Partial<Record<CoverRatio, CoverPick>> | null;
  gates?: Record<"gate1" | "gate2" | "gate3" | "gate4", GateView>;
  final_cut?: FinalCutCard | null;
};

type CoverRatio = "3:4" | "4:3";
export const REFRESH_MS = 15_000;
export const HEARTBEAT_STALE_MS = 30 * 60_000;

export const BOARD_STEPS = ["cutting", "final_review", "covers", "ready"] as const;
export type BoardStep = (typeof BOARD_STEPS)[number];

const latest = (artifacts: readonly Artifact[], roles: readonly string[]) =>
  artifacts.filter((a) => roles.includes(a.role)).reduce<Artifact | null>((best, a) => (!best || a.reported_at >= best.reported_at ? a : best), null);

/** 成片待审看的那一件（成片或剪映导出候选）；卡片上的时长、导出时间、草稿名由服务端的 final_cut 给。 */
export function finalCutArtifact(artifacts: readonly Artifact[]): Artifact | null {
  return latest(artifacts, ["final-cut", "final-cut-candidate"]);
}

/** 当前该展开的步骤：成片没批 → 剪辑中/成片待审；封面没批 → 封面；都批了 → 待发布 */
export function currentStep(review: ProjectReview): BoardStep {
  const gates = review.gates;
  if (gates?.gate3.status !== "approved") return finalCutArtifact(review.execution?.artifacts ?? []) ? "final_review" : "cutting";
  if (gates.gate4.status !== "approved") return "covers";
  return "ready";
}

export type Anomaly = "no_handoff" | "draft_changed";
/** 异常态要可见：剪辑中却没有有效交接包；稿子在交接后被改过 */
export function boardAnomalies(status: string, review: ProjectReview | null): Anomaly[] {
  const out: Anomaly[] = [];
  const valid = Boolean(review?.enabled && review.handoff_valid && review.handoff);
  if (status === "editing" && !valid) out.push("no_handoff");
  if (valid && review?.handoff?.draft_hash && review.draft_hash && review.handoff.draft_hash !== review.draft_hash) out.push("draft_changed");
  return out;
}

/** Codex 超过 30 分钟没 report（从未报过就从交接时间算）→ 交接卡标黄 */
export function heartbeatStale(review: ProjectReview, now: number): boolean {
  const last = review.execution?.heartbeat?.reported_at ?? review.handoff?.at;
  if (!last) return false;
  const t = Date.parse(last);
  return Number.isFinite(t) && now - t > HEARTBEAT_STALE_MS;
}

/** 时长「8 分 43 秒」；读不出就明说 */
export const durationLabel = durationText;

export const fileName = (p: string) => p.split("/").pop() ?? p;
