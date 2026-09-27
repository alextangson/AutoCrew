import { describe, expect, it } from "vitest";
import { boardAnomalies, currentStep, finalCutArtifact, heartbeatStale, stepSummary, type GateView, type ProjectReview } from "./project-board";

const gate = (status: GateView["status"], approved_at = "2026-09-27T08:00:00Z"): GateView =>
  ({ gate: "x", status, artifact_sha256: null, reject_sha256: null, approval: status === "approved" ? { artifact_sha256: "a", approved_at } : null, rejection: null });
function review(over: Partial<ProjectReview> = {}): ProjectReview {
  return {
    enabled: true, handoff_valid: true, draft_hash: "d1",
    handoff: { generation: 1, at: "2026-09-27T08:00:00Z", aroll_path: "/lib/p/02-aroll/纠正AI.mp4", draft_hash: "d1", hash: "h" },
    execution: { session_id: "s", heartbeat: { result: "r", next_action: "n", reported_at: "2026-09-27T09:00:00Z", session_id: "s" }, artifacts: [] },
    gates: { gate1: gate("pending"), gate2: gate("pending"), gate3: gate("pending"), gate4: gate("pending") },
    ...over,
  };
}
const final = { path: "07-delivery/f.mp4", sha256: "f", role: "final-cut", reported_at: "2026-09-27T09:00:00Z" };

describe("currentStep", () => {
  it("没成片=剪辑中；有成片没批=成片待审；成片批了=封面；封面也批=待发布", () => {
    expect(currentStep(review())).toBe("cutting");
    const withFinal = review({ execution: { ...review().execution!, artifacts: [final] } });
    expect(currentStep(withFinal)).toBe("final_review");
    const g = review().gates!;
    expect(currentStep({ ...withFinal, gates: { ...g, gate3: gate("approved") } })).toBe("covers");
    expect(currentStep({ ...withFinal, gates: { ...g, gate3: gate("approved"), gate4: gate("approved") } })).toBe("ready");
    // 成片批准失效 → 回到成片待审
    expect(currentStep({ ...withFinal, gates: { ...g, gate3: gate("invalidated"), gate4: gate("approved") } })).toBe("final_review");
  });
  it("摘要：批准时间折成一行", () => {
    expect(stepSummary("final_review", review({ gates: { ...review().gates!, gate3: gate("approved") } }))).toBe("成片已批 · 2026-09-27 08:00");
  });
});

describe("finalCutArtifact", () => {
  it("成片候选与成片取最近一次报到的", () => {
    const cand = { ...final, role: "final-cut-candidate", sha256: "c", reported_at: "2026-09-27T10:00:00Z" };
    expect(finalCutArtifact([final, cand])?.sha256).toBe("c");
    expect(finalCutArtifact([{ ...final, role: "rough_cut" }])).toBeNull();
  });
});

describe("boardAnomalies", () => {
  it("剪辑中却没有有效交接包 → no_handoff（包括读不到项目）", () => {
    expect(boardAnomalies("editing", review({ handoff_valid: false }))).toEqual(["no_handoff"]);
    expect(boardAnomalies("editing", { enabled: false })).toEqual(["no_handoff"]);
    expect(boardAnomalies("editing", null)).toEqual(["no_handoff"]);
    expect(boardAnomalies("draft_ready", { enabled: false })).toEqual([]);
  });
  it("交接后稿子被改 → draft_changed", () => {
    expect(boardAnomalies("editing", review({ draft_hash: "d2" }))).toEqual(["draft_changed"]);
    expect(boardAnomalies("editing", review())).toEqual([]);
  });
});

describe("heartbeatStale", () => {
  const at = (iso: string) => Date.parse(iso);
  it("最近一次 report 超过 30 分钟标黄；从没报过从交接时间算", () => {
    expect(heartbeatStale(review(), at("2026-09-27T09:29:00Z"))).toBe(false);
    expect(heartbeatStale(review(), at("2026-09-27T09:31:00Z"))).toBe(true);
    expect(heartbeatStale(review({ execution: null }), at("2026-09-27T08:31:00Z"))).toBe(true);
    expect(heartbeatStale({ enabled: true }, at("2026-09-27T08:31:00Z"))).toBe(false);
  });
});
