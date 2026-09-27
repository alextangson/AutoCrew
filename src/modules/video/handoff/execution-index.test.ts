import { describe, expect, it } from "vitest";
import { latestArtifact, mergeArtifacts, normalizeExecution } from "./execution-index.js";

const sha = (c: string) => c.repeat(64);

describe("mergeArtifacts", () => {
  it("追加新产物，旧版本不丢", () => {
    const a = mergeArtifacts([], [{ path: "05-cover/v01/3x4.png", sha256: sha("a"), role: "cover:3:4", version: 1 }], 1, "2026-09-27T01:00:00Z");
    const b = mergeArtifacts(a, [{ path: "05-cover/v02/3x4.png", sha256: sha("b"), role: "cover:3:4", version: 2 }], 1, "2026-09-27T02:00:00Z");
    expect(b.map(x => x.version)).toEqual([1, 2]);
    expect(mergeArtifacts(b, [], 1, "2026-09-27T03:00:00Z")).toEqual(b);
  });
  it("同指纹同角色挪了位置：只改路径，不重复", () => {
    const a = mergeArtifacts([], [{ path: "04-edit/final.mp4", sha256: sha("c"), role: "final-cut", version: undefined }], 1, "2026-09-27T01:00:00Z");
    const b = mergeArtifacts(a, [{ path: "07-delivery/final.mp4", sha256: sha("c"), role: "final-cut" }], 1, "2026-09-27T02:00:00Z");
    expect(b).toHaveLength(1);
    expect(b[0].path).toBe("07-delivery/final.mp4");
  });
  it("latestArtifact 取最近一次报到的那件", () => {
    const a = mergeArtifacts([], [{ path: "x", sha256: sha("a"), role: "rough_cut" }], 1, "2026-09-27T01:00:00Z");
    const b = mergeArtifacts(a, [{ path: "y", sha256: sha("b"), role: "rough_cut" }], 1, "2026-09-27T02:00:00Z");
    expect(latestArtifact(b, ["rough_cut"])?.sha256).toBe(sha("b"));
    expect(latestArtifact(b, ["final-cut"])).toBeNull();
  });
});

describe("normalizeExecution", () => {
  it("旧形状（files 整体覆盖）迁到心跳 + 产物索引，旧角色名改新名", () => {
    const old = { request_id: "r1", generation: 2, binding_revision: 1, session_id: "s", machine: "m", host: "codex", transport_session: null,
      editor_project_id: "p", result: "导出完成", next_action: "请审片", recorded_at: "2026-09-26T00:00:00Z",
      files: [{ path: "07-delivery/final.mp4", sha256: sha("a"), role: "final" }, { path: "05-cover/34.png", sha256: sha("b"), role: "cover34" }, { path: "05-cover/43.png", sha256: sha("c"), role: "cover43" }] };
    const n = normalizeExecution(old)!;
    expect(n.schema).toBe(2);
    expect(n.generation).toBe(2);
    expect(n.editor_project_id).toBe("p");
    expect(n.heartbeat).toMatchObject({ request_id: "r1", result: "导出完成", next_action: "请审片", session_id: "s" });
    expect(n.artifacts.map(a => a.role)).toEqual(["final-cut", "cover:3:4", "cover:4:3"]);
    expect(n).not.toHaveProperty("files");
    expect(normalizeExecution(n)).toBe(n);
    expect(normalizeExecution(null)).toBeNull();
  });
});
