/**
 * 阶段门逐条（阶段制 spec §1.2）。判定是纯函数，所以这里一条规则一个用例，
 * 不掺状态图形状、不掺 I/O——那两件事各有各的测试。
 */
import { describe, it, expect, vi } from "vitest";
import { EDITING_VIA_HANDOFF, stageGuardError, isVideoPlatform, VIDEO_PLATFORMS } from "./stage-guard.js";

const video = { platform: "douyin" };
const text = { platform: "wechat_mp" };
const done = { renderedRevision: 2, at: "2026-08-25T00:00:00.000Z" };
const noCover = () => Promise.resolve(false);
const hasCover = () => Promise.resolve(true);

describe("stage guard", () => {
  it("视频平台清单是四个短视频平台，公众号不在内", () => {
    expect([...VIDEO_PLATFORMS].sort()).toEqual(["bilibili", "douyin", "wechat_video", "xiaohongshu"]);
    expect(isVideoPlatform("wechat_mp")).toBe(false);
    expect(isVideoPlatform(undefined)).toBe(false);
  });

  it("非视频平台进不了剪辑阶段", async () => {
    expect(await stageGuardError(text, "approved", "editing", noCover)).toBe("剪辑阶段只属于视频平台稿件");
    // 没设平台的稿件同样进不去——「未知平台」不该被当成视频稿放行
    expect(await stageGuardError({}, "approved", "editing", noCover)).toBeTruthy();
  });

  it("视频稿只能经交接进剪辑阶段（§13.4-C）：手动切换一律拒绝并说清怎么交接", async () => {
    expect(await stageGuardError(video, "approved", "editing", noCover, { viaHandoff: true })).toBeNull();
    expect(await stageGuardError(video, "draft_ready", "editing", noCover, { viaHandoff: true })).toBeNull();
    for (const from of ["approved", "draft_ready", "cover_pending", "editing"] as const)
      expect(await stageGuardError(video, from, "editing", noCover), from).toBe(EDITING_VIA_HANDOFF);
    expect(EDITING_VIA_HANDOFF).toContain("autocrew_video handoff");
  });

  it("视频稿不许从已过审直通待发布", async () => {
    expect(await stageGuardError(video, "approved", "publish_ready", hasCover)).toBe(
      "视频稿要先过剪辑与封面（交接给剪辑工位）",
    );
  });

  it("文字稿从已过审直通待发布照旧放行", async () => {
    expect(await stageGuardError(text, "approved", "publish_ready", noCover)).toBeNull();
  });

  it("剪辑 → 封面设计：没有 videoDone 就拦下", async () => {
    expect(await stageGuardError(video, "editing", "cover_pending", noCover)).toContain("成片还没审通过");
  });

  it("剪辑 → 封面设计：有 videoDone 才放行", async () => {
    expect(await stageGuardError({ ...video, videoDone: done }, "editing", "cover_pending", noCover)).toBeNull();
  });

  it("封面设计 → 待发布：封面没定稿就拦下", async () => {
    expect(await stageGuardError({ ...video, videoDone: done }, "cover_pending", "publish_ready", noCover)).toBe("封面还没定稿");
  });

  it("封面设计 → 待发布：封面定稿即放行", async () => {
    expect(await stageGuardError({ ...video, videoDone: done }, "cover_pending", "publish_ready", hasCover)).toBeNull();
  });

  // P6 §14.7 #1：成片戳是创始人审片的唯一痕迹。force 能从任意列推进封面台，不看来路才挡得住
  it("视频稿没有成片戳：从哪进封面台、从封面台进待发布都拦下（封面定稿了也不行）", async () => {
    for (const from of ["approved", "draft_ready", "publish_ready", "editing"] as const)
      expect(await stageGuardError(video, from, "cover_pending", hasCover), from).toContain("成片还没审通过");
    expect(await stageGuardError(video, "cover_pending", "publish_ready", hasCover)).toContain("成片还没审通过");
    expect(await stageGuardError(text, "approved", "cover_pending", hasCover)).toBeNull();
  });

  it("封面评审单只在真要判它的那一条边上读——别的边不该多花一次 I/O", async () => {
    const read = vi.fn(() => Promise.resolve(false));
    await stageGuardError(video, "approved", "editing", read);
    await stageGuardError({ ...video, videoDone: done }, "editing", "cover_pending", read);
    expect(read).not.toHaveBeenCalled();
    await stageGuardError({ ...video, videoDone: done }, "cover_pending", "publish_ready", read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("剪辑 → 待发布（P6 剪辑工位登记）：成片戳 + 封面定稿两样都在才放行", async () => {
    const withDone = { ...video, videoDone: done };
    expect(await stageGuardError(withDone, "editing", "publish_ready", hasCover)).toBeNull();
    // 少一样都维持旧话术：登记是同一次落盘写两样，缺一样说明没走登记
    expect(await stageGuardError(withDone, "editing", "publish_ready", noCover)).toBe("视频稿要先过剪辑与封面（交接给剪辑工位）");
    expect(await stageGuardError(video, "editing", "publish_ready", hasCover)).toBe("视频稿要先过剪辑与封面（交接给剪辑工位）");
    // 这条新边只开给 editing：别的来路有戳有封面也照拦
    expect(await stageGuardError(withDone, "approved", "publish_ready", hasCover)).toBe("视频稿要先过剪辑与封面（交接给剪辑工位）");
  });

  it("剪辑 → 待发布：没有成片戳时不去读封面评审单", async () => {
    const read = vi.fn(() => Promise.resolve(true));
    await stageGuardError(video, "editing", "publish_ready", read);
    expect(read).not.toHaveBeenCalled();
  });

  it("撤回交接（剪辑 → 草稿就绪）不设门", async () => {
    expect(await stageGuardError(video, "editing", "draft_ready", noCover)).toBeNull();
  });

  it("回退边不设门：退回改稿随时可走；回剪辑也算进剪辑，只能经交接", async () => {
    expect(await stageGuardError(video, "editing", "approved", noCover)).toBeNull();
    expect(await stageGuardError(video, "cover_pending", "editing", noCover)).toBe(EDITING_VIA_HANDOFF);
  });

  it("看板拖动的几条边：认稿、标已发布不设门；视频稿已发布退不回待发布（看板因此不给这条退路）", async () => {
    expect(await stageGuardError(video, "draft_ready", "approved", noCover)).toBeNull();
    expect(await stageGuardError(video, "publish_ready", "published", noCover)).toBeNull();
    expect(await stageGuardError(text, "approved", "published", noCover)).toBeNull();
    expect(await stageGuardError(video, "published", "publish_ready", hasCover)).not.toBeNull();
    expect(await stageGuardError(text, "published", "publish_ready", noCover)).toBeNull();
  });
});

// 收紧后的不变量:视频稿进「待发布」只有封面台与剪辑工位登记两个入口——挡住看板从任意列直拖(force 越形状不越阶段门)
import { describe as d2, expect as e2, it as i2 } from "vitest";
d2("stageGuardError · 视频稿进待发布的唯一入口", () => {
  const noCover = () => Promise.resolve(false);
  const subject = { platform: "douyin" } as const;
  i2("reviewing 直拖 publish_ready 被拒(看板 force 场景)", async () => {
    const err = await stageGuardError(subject, "reviewing", "publish_ready", noCover);
    e2(err).toContain("先过剪辑与封面");
  });
  i2("editing 直跳 publish_ready 被拒", async () => {
    const err = await stageGuardError(subject, "editing", "publish_ready", noCover);
    e2(err).toContain("先过剪辑与封面");
  });
  i2("cover_pending → publish_ready 走封面判定,不撞此规则", async () => {
    const err = await stageGuardError({ ...subject, videoDone: { renderedRevision: 1, at: "2026-09-29T00:00:00.000Z" } }, "cover_pending", "publish_ready", () => Promise.resolve(true));
    e2(err).toBeNull();
  });
  i2("文字平台 approved → publish_ready 不受影响", async () => {
    const err = await stageGuardError({ platform: "wechat_mp" }, "approved", "publish_ready", noCover);
    e2(err).toBeNull();
  });
});
