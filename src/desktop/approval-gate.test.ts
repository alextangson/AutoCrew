import { describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalBinding } from "./approval-gate.js";

const binding: ApprovalBinding = {
  action: "wechat_mp_draft",
  contentId: "content-1-a",
  workspaceDir: "/tmp/workspace-a",
  contentFingerprint: "sha256:original",
};

describe("ApprovalGate", () => {
  it("binds approval to action, workspace, content and exact revision", () => {
    const gate = new ApprovalGate();
    const approval = gate.issue(binding);
    expect(gate.consume(approval.token, { ...binding, contentFingerprint: "sha256:changed" }).ok).toBe(false);
    expect(gate.consume(approval.token, binding)).toEqual({ ok: true });
  });

  it("is one-shot and expires closed", () => {
    let now = 1_000;
    const gate = new ApprovalGate(100, () => now);
    const first = gate.issue(binding);
    expect(gate.consume(first.token, binding).ok).toBe(true);
    expect(gate.consume(first.token, binding).ok).toBe(false);

    const second = gate.issue(binding);
    now += 101;
    expect(gate.consume(second.token, binding).ok).toBe(false);
  });
});
