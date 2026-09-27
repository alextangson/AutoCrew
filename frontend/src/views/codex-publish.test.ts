import { describe, expect, it } from "vitest";
import { codexTargetLine, codexThreadId, finalCutPath, publishMessage, showCodexPublish, videoPlatforms } from "./codex-publish";
import type { GateView, ProjectReview } from "./project-board";

const S = (c: string) => c.repeat(64);
const gate = (status: GateView["status"], sha: string | null = null): GateView => ({ gate: "g", status, artifact_sha256: sha, reject_sha256: null,
  approval: sha ? { artifact_sha256: sha, approved_at: "2026-09-27T08:00:00Z" } : null, rejection: null });
const at = "2026-09-27T08:00:00Z";
function review(over: Partial<ProjectReview> = {}): ProjectReview {
  return {
    enabled: true, handoff_valid: true, project: { project_root: "/lib/p1" },
    execution: { session_id: "0199A1B2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", heartbeat: { result: "", next_action: "", reported_at: at, session_id: "" }, artifacts: [
      { path: "/jy/export.mp4", sha256: S("f"), role: "final-cut-candidate", reported_at: at },
      { path: "05-cover/v2-34.png", sha256: S("a"), role: "cover:3:4", version: 2, reported_at: at },
      { path: "05-cover/v2-43.png", sha256: S("b"), role: "cover:4:3", version: 2, reported_at: at },
    ] },
    cover_selection: { "3:4": { sha256: S("a"), path: "05-cover/v2-34.png", version: 2 }, "4:3": { sha256: S("b"), path: "05-cover/v2-43.png", version: 2 } },
    gates: { gate1: gate("approved"), gate2: gate("approved"), gate3: gate("approved", S("f")), gate4: gate("approved", S("c")) },
    ...over,
  };
}

describe("按钮什么时候出现", () => {
  it("看板只在待发布且未登记；发布页只在 publish_ready", () => {
    expect(showCodexPublish("board", "editing", review())).toBe(true);
    expect(showCodexPublish("board", "publish_ready", review())).toBe(false);
    expect(showCodexPublish("publish_page", "publish_ready", review())).toBe(true);
    expect(showCodexPublish("publish_page", "published", review())).toBe(false);
  });
  it("封面没批、没有看板数据都不出现", () => {
    const r = review(); r.gates!.gate4 = gate("pending");
    expect(showCodexPublish("board", "editing", r)).toBe(false);
    expect(showCodexPublish("publish_page", "publish_ready", r)).toBe(false);
    expect(showCodexPublish("board", "editing", null)).toBe(false);
    expect(showCodexPublish("board", "editing", { enabled: false })).toBe(false);
  });
});

describe("打开哪条对话", () => {
  it("UUID 会话 → 这条对话；缺失或非 UUID → 新开", () => {
    expect(codexThreadId(review())).toBe("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
    expect(codexTargetLine(review())).toBe("会打开这条视频的剪辑对话");
    const bad = review(); bad.execution!.session_id = "sess-1";
    expect(codexThreadId(bad)).toBeNull();
    expect(codexThreadId(review({ execution: null }))).toBeNull();
    expect(codexTargetLine(bad)).toContain("会新开一个");
  });
});

it("平台只留视频平台，去重保序", () => {
  expect(videoPlatforms(["wechat_mp", "xiaohongshu", "douyin", "抖音", "bilibili", "wechat_video", "zhihu"])).toEqual(["小红书", "抖音", "B站", "视频号"]);
  expect(videoPlatforms([])).toEqual([]);
});

describe("成片路径", () => {
  it("没挪进项目 → 剪映导出候选", () => { expect(finalCutPath(review())).toBe("/jy/export.mp4"); });
  it("挪进 07-delivery 后优先项目内那份", () => {
    const r = review(); r.execution!.artifacts.push({ path: "07-delivery/final.mp4", sha256: S("f"), role: "final-cut", reported_at: at });
    expect(finalCutPath(r)).toBe("/lib/p1/07-delivery/final.mp4");
  });
});

describe("发布指令", () => {
  const base = { contentId: "content-1-abc", title: "标题", review: review(), platforms: ["抖音", "B站"] };
  it("带 content_id、成片、两张封面路径、平台和授权说明，不超过 12 行", () => {
    const m = publishMessage({ ...base, status: "editing" });
    for (const s of ["content-1-abc", "/jy/export.mp4", "/lib/p1/05-cover/v2-34.png", "/lib/p1/05-cover/v2-43.png", "抖音、B站", "授权", "立即发布", "publish-content"]) expect(m).toContain(s);
    expect(m.split("\n")[0]).toContain("发布这条视频：标题");
    expect(m).toContain("autocrew_video register");
    expect(m.split("\n").length).toBeLessThanOrEqual(12);
  });
  it("已登记就不再让它 register", () => {
    expect(publishMessage({ ...base, status: "publish_ready" })).not.toContain("register");
  });
});
