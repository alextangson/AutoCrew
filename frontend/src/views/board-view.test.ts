import { describe, expect, it } from "vitest";
import { boardFiles, codexLine, finalCutMeta, middleEllipsis, nowKind, refreshFailedLine, rejectNoteError, stepperStates } from "./board-view";
import type { FinalCutCard, GateView, ProjectReview } from "./project-board";

const gate = (status: GateView["status"]): GateView =>
  ({ gate: "x", status, artifact_sha256: null, reject_sha256: null, approval: null, rejection: null });
const now = Date.parse("2026-09-27T09:10:00Z");
function review(over: Partial<ProjectReview> = {}): ProjectReview {
  return {
    enabled: true, handoff_valid: true, draft_hash: "d1", project: { project_root: "/lib/projects/p" },
    handoff: { generation: 2, at: "2026-09-27T08:00:00Z", aroll_path: "/lib/projects/p/02-aroll/a.mp4", draft_hash: "d1", hash: "h" },
    execution: { session_id: "s", heartbeat: { result: "粗剪完成", next_action: "等你审", reported_at: "2026-09-27T09:07:00Z", session_id: "s" }, artifacts: [] },
    gates: { gate1: gate("pending"), gate2: gate("pending"), gate3: gate("pending"), gate4: gate("pending") },
    ...over,
  };
}
const card: FinalCutCard = { path: "07-delivery/成片.mp4", name: "成片.mp4", sha256: "f".repeat(64), sha8: "ffffffff", role: "final-cut", external: false,
  duration_ms: 523_000, exported_at: null, jianying_draft: "纠正AI", missing: false, changed: false };

describe("nowKind + stepperStates", () => {
  it("交接前 / 剪辑中 / 没有有效交接", () => {
    expect(nowKind("draft_ready", null)).toBe("pre_handoff");
    expect(nowKind("editing", review())).toBe("cutting");
    expect(nowKind("editing", review({ handoff_valid: false }))).toBe("no_handoff");
    expect(nowKind("editing", null)).toBe("no_handoff");
  });
  it("步骤条：前面打勾、当前强调、后面淡", () => {
    expect(stepperStates("final_review").map((s) => s.state)).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(stepperStates("pre_handoff")[0]).toEqual({ label: "交接", state: "current" });
    expect(stepperStates("ready").at(-1)).toEqual({ label: "发布", state: "current" });
  });
});

describe("codexLine", () => {
  it("轮到创始人时（成片和封面都批了）不提醒 Codex 卡住", () => {
    const old = { session_id: "s", heartbeat: { result: "导出第 1 版", next_action: "等审", reported_at: "2026-09-27T07:00:00Z", session_id: "s" }, artifacts: [] };
    const approved = { gate1: gate("pending"), gate2: gate("pending"), gate3: gate("approved"), gate4: gate("approved") };
    expect(codexLine(review({ execution: old, gates: approved }), now).stale).toBeNull();
    expect(codexLine(review({ execution: old }), now).stale).not.toBeNull();
  });
  it("相对时间 + 结果，下一步单列", () => {
    expect(codexLine(review(), now)).toEqual({ text: "Codex · 3 分钟前：粗剪完成", next: "等你审", stale: null });
  });
  it("没报过就明说；超过 30 分钟给提醒", () => {
    const r = codexLine(review({ execution: null }), now);
    expect(r.text).toBe("Codex 还没报告过进度");
    expect(r.stale).toMatch(/30 分钟/);
  });
});

describe("boardFiles", () => {
  it("相对路径拼到项目根上，给出访达目标", () => {
    const rows = boardFiles(review({ final_cut: card }));
    expect(rows.map((r) => [r.label, r.path, r.target])).toEqual([
      ["原片", "/lib/projects/p/02-aroll/a.mp4", "aroll"],
      ["成片", "/lib/projects/p/07-delivery/成片.mp4", "f".repeat(64)],
      ["封面文件夹", "/lib/projects/p/05-cover", "covers_dir"],
      ["项目文件夹", "/lib/projects/p", "project_root"],
    ]);
  });
  it("剪映导出目录里的绝对路径原样；还没有的给空", () => {
    const rows = boardFiles(review({ final_cut: { ...card, path: "/Users/x/Movies/导出/a.mp4", external: true }, project: null }));
    expect(rows[1].path).toBe("/Users/x/Movies/导出/a.mp4");
    expect(rows[3].path).toBeNull();
  });
});

describe("finalCutMeta", () => {
  it("时长用中文单位，导出时间按本地时区", () => {
    const exported = new Date(2026, 8, 27, 17, 50).toISOString();
    expect(finalCutMeta({ ...card, external: true, exported_at: exported }, new Date(2026, 8, 27, 18, 0).getTime()))
      .toBe("8 分 43 秒 · 今天 17:50 从剪映导出 · 草稿「纠正AI」 · 指纹 ffffffff");
    expect(finalCutMeta({ ...card, duration_ms: null, jianying_draft: null })).toBe("时长读不出 · 指纹 ffffffff");
  });
});

describe("小工具", () => {
  it("长文件名从中间省略，保住扩展名", () => {
    expect(middleEllipsis("短.mp4")).toBe("短.mp4");
    const long = middleEllipsis("这是一个非常非常非常非常非常非常非常非常长的成片文件名最终版v3.mp4", 20);
    expect([...long].length).toBe(20);
    expect(long.endsWith(".mp4")).toBe(true);
  });
  it("刷新失败带上次更新时间；原话必填", () => {
    expect(refreshFailedLine("HTTP 500", now - 3 * 60_000, now)).toBe("看板更新失败：HTTP 500（上次更新 3 分钟前）");
    expect(refreshFailedLine("断网", null, now)).toBe("看板更新失败：断网");
    expect(rejectNoteError("  ")).not.toBeNull();
    expect(rejectNoteError("节奏太慢")).toBeNull();
  });
});
