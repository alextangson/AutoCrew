import { describe, it, expect } from "vitest";
import { approveArtifact, artifactHash, checkArtifactApproval, shortHash } from "./artifact-approval.js";

describe("绑定产物的批准", () => {
  it("指纹相同放行", () => {
    const a = approveArtifact("英文稿", artifactHash("hello"));
    expect(checkArtifactApproval(a, artifactHash("hello"))).toEqual({ ok: true });
  });
  it("产物变了就拒，原因是中文、带两边指纹前 8 位", () => {
    const a = approveArtifact("英文稿", artifactHash("v1"));
    const r = checkArtifactApproval(a, artifactHash("v2"));
    expect(r).toMatchObject({ ok: false, code: "artifact_changed" });
    if (!r.ok) {
      expect(r.reason).toContain("英文稿在批准之后变了");
      expect(r.reason).toContain(artifactHash("v1").slice(0, 8));
      expect(r.reason).toContain(artifactHash("v2").slice(0, 8));
    }
  });
  it("没批过 / 产物没了都拒，不静默放行", () => {
    expect(checkArtifactApproval(null, "x")).toMatchObject({ ok: false, code: "approval_missing" });
    expect(checkArtifactApproval(approveArtifact("成片", "sha256:abc"), null)).toMatchObject({ ok: false, code: "artifact_missing" });
  });
  it("对象指纹与键顺序无关、与值有关", () => {
    expect(artifactHash({ a: 1, b: [1, 2] })).toBe(artifactHash({ b: [1, 2], a: 1 }));
    expect(artifactHash({ a: 1 })).not.toBe(artifactHash({ a: 2 }));
    expect(shortHash("sha256:0123456789")).toBe("01234567");
  });
});
