/**
 * video-handlers.test.ts —— 视频线 IPC 层的边界：service 未起、工作区不符、payload 变形、
 * 乐观锁冲突的返回形状、videoReadyAt 只盖一次。
 *
 * service 用桩：这层的职责是「校验 + 翻译 + 盖戳」，真实管线由 modules/video 自己的
 * 232 条测试守；在这里跑 ffmpeg 只会把边界测试变成集成测试。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getContent, saveContent, updateContent } from "../storage/local-store.js";
import {
  VideoConflictError,
  type ConfirmCutArgs,
  type ConfirmEditorPlanArgs,
  type FillEditorSlotArgs,
  type RequestPreviewArgs,
  type VideoService,
} from "../modules/video/service.js";
import type { VideoState } from "../modules/video/types.js";
import {
  getVideoRuntimeStatus,
  setVideoService,
  videoAsrStatusHandler,
  videoAsrWarmupHandler,
  videoBuildStartHandler,
  videoCutConfirmHandler,
  videoCutPreviewHandler,
  videoEditorConfirmHandler,
  videoEditorPlanGetHandler,
  videoEditorRerunHandler,
  videoEditorSlotFillHandler,
  videoReassembleHandler,
  videoRetryHandler,
  videoReviewConfirmHandler,
  videoRoughCutRerunHandler,
  videoStatusHandler,
  videoTranscriptGetHandler,
} from "./video-handlers.js";

const STATE: VideoState = {
  schemaVersion: 1,
  entryType: "aroll",
  phase: "review",
  state: "awaiting_human",
  revisions: { transcript: 1, cut: 2, timeline: 1, rendered: 1 },
  updatedAt: "2026-07-27T00:00:00.000Z",
};

interface Calls {
  startBuild: string[];
  confirmCut: Array<[string, ConfirmCutArgs]>;
  confirmEditorPlan: Array<[string, ConfirmEditorPlanArgs]>;
  confirmReview: Array<[string, { renderedRevision: number; verdict: string }]>;
  retry: string[];
  rerunRoughCut: string[];
  rerunEditor: string[];
  fillEditorSlot: Array<[string, FillEditorSlotArgs]>;
  requestCutPreview: Array<[string, RequestPreviewArgs]>;
  reassemble: string[];
  shutdown: number;
}

let dir: string;
let contentId: string;
let calls: Calls;

/** 可按需让某个方法抛错的门面桩 */
function stubService(overrides: Partial<VideoService> = {}): VideoService {
  return {
    startBuild: async (id) => {
      calls.startBuild.push(id);
      return { ...STATE, phase: "ingest", state: "queued" };
    },
    confirmCut: async (id, args) => {
      calls.confirmCut.push([id, args]);
      return { ...STATE, phase: "edit", state: "queued" };
    },
    confirmEditorPlan: async (id, args) => {
      calls.confirmEditorPlan.push([id, args]);
      return { ...STATE, phase: "assemble", state: "queued" };
    },
    confirmReview: async (id, args) => {
      calls.confirmReview.push([id, args]);
      return args.verdict === "approve"
        ? { ...STATE, phase: "done", state: "done" }
        : { ...STATE, phase: "cut", state: "awaiting_human" };
    },
    retry: async (id) => {
      calls.retry.push(id);
      return { ...STATE, phase: "render", state: "queued" };
    },
    rerunRoughCut: async (id) => {
      calls.rerunRoughCut.push(id);
      return { ...STATE, phase: "cut", state: "queued" };
    },
    rerunEditor: async (id) => {
      calls.rerunEditor.push(id);
      return { ...STATE, phase: "edit", state: "queued" };
    },
    fillEditorSlot: async (id, args) => {
      calls.fillEditorSlot.push([id, args]);
      return { plan: { schemaVersion: 1, cutRevision: 2, origin: "human", overlays: [] }, revision: args.planRevision + 1 };
    },
    requestCutPreview: async (id, args) => {
      calls.requestCutPreview.push([id, args]);
      return { ...STATE, phase: "cut", state: "awaiting_human", preview: { requestedRevision: 2 } };
    },
    reassemble: async (id) => {
      calls.reassemble.push(id);
      return { ...STATE, phase: "assemble", state: "queued" };
    },
    getStatus: async () => ({ state: STATE, jobs: [] }),
    getTranscript: async () => null,
    getEditorPlan: async () => null,
    warmupAsr: async () => ({ status: "warming" }),
    asrStatus: async () => ({ status: "ready", detail: "模型已就位" }),
    shutdown: async () => {
      calls.shutdown += 1;
    },
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-handlers-"));
  calls = {
    startBuild: [],
    confirmCut: [],
    confirmEditorPlan: [],
    confirmReview: [],
    retry: [],
    rerunRoughCut: [],
    rerunEditor: [],
    fillEditorSlot: [],
    requestCutPreview: [],
    reassemble: [],
    shutdown: 0,
  };
  contentId = (
    await saveContent({ title: "口播稿", body: "正文", status: "approved", tags: [], platform: "douyin" }, dir)
  ).id;
  setVideoService(stubService(), dir);
});

afterEach(async () => {
  setVideoService(null);
  // 确认成功路径会 fire-and-forget 写 recent-actions.json（观测层不 await），
  // 清理要能扛住这条晚到的写：maxRetries 让 rm 对 ENOTEMPTY 重试。
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("service 接线", () => {
  it("未启动：全部通道回人话，不崩也不假装成功", async () => {
    setVideoService(null);
    expect(getVideoRuntimeStatus()).toEqual({ running: false });
    for (const handler of [videoBuildStartHandler, videoStatusHandler, videoRetryHandler, videoAsrStatusHandler]) {
      const res = await handler({ content_id: contentId, _dataDir: dir });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain("视频服务没在跑");
    }
  });

  it("工作区不符：当场拒绝，绝不把稿件写进另一个工作区", async () => {
    const res = await videoBuildStartHandler({ content_id: contentId, _dataDir: "/tmp/another-workspace" });
    expect(res).toMatchObject({ ok: false });
    expect(String(res.error)).toContain("切换工作区后请重启");
    expect(calls.startBuild).toEqual([]);
  });

  it("default 工作区不注入 _dataDir：视为命中，照常投递", async () => {
    const res = await videoBuildStartHandler({ content_id: contentId });
    expect(res.ok).toBe(true);
    expect(calls.startBuild).toEqual([contentId]);
  });

  it("状态透传：运行中报告工作区", () => {
    expect(getVideoRuntimeStatus()).toEqual({ running: true, dataDir: dir });
  });
});

describe("video:build_start / status / transcript_get / retry", () => {
  it("投递即返回 state", async () => {
    const res = await videoBuildStartHandler({ content_id: contentId, _dataDir: dir });
    expect(res).toMatchObject({ ok: true, data: { state: { phase: "ingest", state: "queued" } } });
  });

  it("非法 content_id 在边界就被拒（不进 service）", async () => {
    const res = await videoBuildStartHandler({ content_id: "../etc/passwd", _dataDir: dir });
    expect(res).toMatchObject({ ok: false, error: "需要合法 content_id" });
    expect(calls.startBuild).toEqual([]);
  });

  it("status：没开始剪 = data:null，不是错误", async () => {
    setVideoService(stubService({ getStatus: async () => null }), dir);
    const res = await videoStatusHandler({ content_id: contentId, _dataDir: dir });
    expect(res).toEqual({ ok: true, data: null });
  });

  it("transcript_get：转写还没出来也回 null", async () => {
    const res = await videoTranscriptGetHandler({ content_id: contentId, _dataDir: dir });
    expect(res).toEqual({ ok: true, data: null });
  });

  it("retry：service 的人话错误原样透传", async () => {
    setVideoService(
      stubService({
        retry: async () => {
          throw new Error("当前是 render/running，没有可重试的失败");
        },
      }),
      dir,
    );
    const res = await videoRetryHandler({ content_id: contentId, _dataDir: dir });
    expect(res).toEqual({ ok: false, error: "当前是 render/running，没有可重试的失败" });
  });

  it("rough_cut_rerun：投递即返回 cut/queued", async () => {
    const res = await videoRoughCutRerunHandler({ content_id: contentId, _dataDir: dir });
    expect(res).toMatchObject({ ok: true, data: { state: { phase: "cut", state: "queued" } } });
    expect(calls.rerunRoughCut).toEqual([contentId]);
  });

  it("rough_cut_rerun：人工终裁过的那版被拒，人话原样透传", async () => {
    setVideoService(
      stubService({
        rerunRoughCut: async () => {
          throw new Error("这一版选段是你自己确认过的，AI 建议不会覆盖它");
        },
      }),
      dir,
    );
    const res = await videoRoughCutRerunHandler({ content_id: contentId, _dataDir: dir });
    expect(res).toEqual({ ok: false, error: "这一版选段是你自己确认过的，AI 建议不会覆盖它" });
  });

  it("rough_cut_rerun：非法 content_id 在边界就被拒", async () => {
    expect(await videoRoughCutRerunHandler({ content_id: "../x", _dataDir: dir })).toMatchObject({ ok: false });
    expect(calls.rerunRoughCut).toEqual([]);
  });

  it("asr 预热与查询透传 service 结果", async () => {
    expect(await videoAsrWarmupHandler({ _dataDir: dir })).toEqual({ ok: true, data: { status: "warming" } });
    expect(await videoAsrStatusHandler({ _dataDir: dir })).toEqual({
      ok: true,
      data: { status: "ready", detail: "模型已就位" },
    });
  });
});

describe("video:cut_confirm 的 payload 解析", () => {
  const base = { keeps: ["s1", "s2"], base_transcript_revision: 1, base_cut_revision: 1 };

  it("snake_case 的 flags 被翻成域内形状（覆盖轨不在这一步提交）", async () => {
    const res = await videoCutConfirmHandler({
      ...base,
      content_id: contentId,
      _dataDir: dir,
      flags: [{ segment_id: "s3", flag: "misread" }],
    });
    expect(res.ok).toBe(true);
    expect(calls.confirmCut[0][1]).toEqual({
      keeps: ["s1", "s2"],
      flags: [{ segmentId: "s3", flag: "misread" }],
      baseTranscriptRevision: 1,
      baseCutRevision: 1,
    });
  });

  it("flags 缺省 = 空数组", async () => {
    await videoCutConfirmHandler({ ...base, content_id: contentId, _dataDir: dir });
    expect(calls.confirmCut[0][1]).toEqual({
      keeps: ["s1", "s2"],
      flags: [],
      baseTranscriptRevision: 1,
      baseCutRevision: 1,
    });
  });

  it.each([
    [{ keeps: "s1" }, "keeps 必须是分句 id 数组"],
    [{ keeps: ["s1", 3] }, "keeps 里有非法分句 id"],
    [{ flags: [{ segment_id: "s1", flag: "hallucinated" }] }, "flag 只能是"],
    [{ base_cut_revision: -1 }, "base_cut_revision 必须是非负整数"],
    [{ base_transcript_revision: 1.5 }, "base_transcript_revision 必须是非负整数"],
  ])("变形 payload %# 被拒且不进 service", async (patch, expected) => {
    const res = await videoCutConfirmHandler({ ...base, ...patch, content_id: contentId, _dataDir: dir });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(expected);
    expect(calls.confirmCut).toEqual([]);
  });

  it("乐观锁冲突：带 conflict 标记 + 当前状态，前端据此重载", async () => {
    setVideoService(
      stubService({
        confirmCut: async () => {
          throw new VideoConflictError("选段基于的版本已过期，请重载后重试", STATE);
        },
      }),
      dir,
    );
    const res = await videoCutConfirmHandler({ ...base, content_id: contentId, _dataDir: dir });
    expect(res).toMatchObject({ ok: false, conflict: true, data: { state: { phase: "review" } } });
    expect(String(res.error)).toContain("已过期");
  });
});

describe("video:editor_* 的 payload 解析", () => {
  const base = { plan_revision: 2, kept_overlay_ids: ["ov-01"] };

  it("snake_case 翻成域内形状", async () => {
    const res = await videoEditorConfirmHandler({ ...base, content_id: contentId, _dataDir: dir });
    expect(res.ok).toBe(true);
    expect(calls.confirmEditorPlan[0][1]).toEqual({ planRevision: 2, keptOverlayIds: ["ov-01"] });
  });

  it.each([
    [{ plan_revision: -1 }, "plan_revision 必须是非负整数"],
    [{ kept_overlay_ids: "ov-01" }, "kept_overlay_ids 必须是字符串数组"],
    [{ kept_overlay_ids: ["ov-01", 7] }, "kept_overlay_ids 里有非法项"],
  ])("变形 payload %# 被拒且不进 service", async (patch, expected) => {
    const res = await videoEditorConfirmHandler({ ...base, ...patch, content_id: contentId, _dataDir: dir });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(expected);
    expect(calls.confirmEditorPlan).toEqual([]);
  });

  it("乐观锁冲突：带 conflict 标记 + 当前状态", async () => {
    setVideoService(
      stubService({
        confirmEditorPlan: async () => {
          throw new VideoConflictError("成片计划基于的版本已过期，请重载后重试", STATE);
        },
      }),
      dir,
    );
    const res = await videoEditorConfirmHandler({ ...base, content_id: contentId, _dataDir: dir });
    expect(res).toMatchObject({ ok: false, conflict: true, data: { state: { phase: "review" } } });
  });

  it("plan_get 还没跑过 = data:null（不是错误）；rerun 只投递", async () => {
    expect(await videoEditorPlanGetHandler({ content_id: contentId, _dataDir: dir })).toEqual({ ok: true, data: null });
    const res = await videoEditorRerunHandler({ content_id: contentId, _dataDir: dir });
    expect(res).toMatchObject({ ok: true, data: { state: { phase: "edit", state: "queued" } } });
    expect(calls.rerunEditor).toEqual([contentId]);
  });

  it("service 没起来 → 三个口都说人话，不崩", async () => {
    setVideoService(null);
    for (const handler of [videoEditorPlanGetHandler, videoEditorConfirmHandler, videoEditorRerunHandler]) {
      const res = await handler({ ...base, content_id: contentId, _dataDir: dir });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain("视频服务没在跑");
    }
  });
});

describe("video:review_confirm 与 videoReadyAt", () => {
  const approve = { rendered_revision: 1, verdict: "approve" };

  it("approve：盖 videoReadyAt 并回传", async () => {
    const res = await videoReviewConfirmHandler({ ...approve, content_id: contentId, _dataDir: dir });
    expect(res.ok).toBe(true);
    const stamped = (res.data as { videoReadyAt?: string }).videoReadyAt;
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await getContent(contentId, dir))?.videoReadyAt).toBe(stamped);
  });

  it("只盖一次：重剪重审不覆盖首次达成的时刻（publishedAt 同款）", async () => {
    await updateContent(contentId, { videoReadyAt: "2026-01-01T00:00:00.000Z" }, dir);
    const res = await videoReviewConfirmHandler({ ...approve, content_id: contentId, _dataDir: dir });
    expect(res).toMatchObject({ ok: true, data: { videoReadyAt: "2026-01-01T00:00:00.000Z" } });
    expect((await getContent(contentId, dir))?.videoReadyAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("打回不盖戳（成片还没通过审）", async () => {
    const res = await videoReviewConfirmHandler({
      content_id: contentId,
      rendered_revision: 1,
      verdict: "reject",
      _dataDir: dir,
    });
    expect(res).toMatchObject({ ok: true, data: { state: { phase: "cut", state: "awaiting_human" } } });
    expect((res.data as Record<string, unknown>).videoReadyAt).toBeUndefined();
    expect((await getContent(contentId, dir))?.videoReadyAt).toBeUndefined();
  });

  it("稿件不在了：确认仍成功，但盖戳失败明写在返回里（不静默）", async () => {
    await fs.rm(path.join(dir, "contents", contentId), { recursive: true, force: true });
    const res = await videoReviewConfirmHandler({ ...approve, content_id: contentId, _dataDir: dir });
    expect(res.ok).toBe(true);
    expect(String((res.data as { stampWarning?: string }).stampWarning)).toContain("videoReadyAt");
  });

  it("verdict / rendered_revision 变形被拒", async () => {
    expect(
      await videoReviewConfirmHandler({ content_id: contentId, rendered_revision: 1, verdict: "maybe", _dataDir: dir }),
    ).toMatchObject({ ok: false, error: "verdict 只能是 approve / reject" });
    expect(
      await videoReviewConfirmHandler({ content_id: contentId, rendered_revision: "1", verdict: "approve", _dataDir: dir }),
    ).toMatchObject({ ok: false });
    expect(calls.confirmReview).toEqual([]);
  });

  it("冲突（审的是旧版成片）同样带 conflict 标记", async () => {
    setVideoService(
      stubService({
        confirmReview: async () => {
          throw new VideoConflictError("审的是成片 v1，当前已是 v2，请重载后重试", STATE);
        },
      }),
      dir,
    );
    const res = await videoReviewConfirmHandler({ ...approve, content_id: contentId, _dataDir: dir });
    expect(res).toMatchObject({ ok: false, conflict: true });
    expect((await getContent(contentId, dir))?.videoReadyAt).toBeUndefined();
  });
});

describe("video:editor_slot_fill / cut_preview / reassemble", () => {
  const fill = { content_id: "", plan_revision: 3, overlay_id: "ov-01", library_id: "asset-1" };

  it("填槽：翻成域内形状，返回派生出的新一版 plan", async () => {
    const res = await videoEditorSlotFillHandler({ ...fill, content_id: contentId, _dataDir: dir });
    expect(res.ok).toBe(true);
    expect(calls.fillEditorSlot[0][1]).toEqual({ planRevision: 3, overlayId: "ov-01", libraryId: "asset-1" });
    expect((res.data as { revision: number }).revision).toBe(4);
  });

  it.each([
    [{ overlay_id: "" }, "overlay_id 必须是非空字符串"],
    [{ library_id: 7 }, "library_id 必须是非空字符串"],
    [{ plan_revision: "3" }, "plan_revision 必须是非负整数"],
  ])("填槽变形 payload %# 被拒且不进 service", async (patch, expected) => {
    const res = await videoEditorSlotFillHandler({ ...fill, ...patch, content_id: contentId, _dataDir: dir });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(expected);
    expect(calls.fillEditorSlot).toEqual([]);
  });

  it("预览请求：只带 keeps 与两个 base revision（勾选是草稿，不带 flags）", async () => {
    const res = await videoCutPreviewHandler({
      content_id: contentId,
      keeps: ["seg-0001"],
      base_transcript_revision: 1,
      base_cut_revision: 2,
      _dataDir: dir,
    });
    expect(res.ok).toBe(true);
    expect(calls.requestCutPreview[0][1]).toEqual({ keeps: ["seg-0001"], baseTranscriptRevision: 1, baseCutRevision: 2 });
    expect((res.data as { state: VideoState }).state.preview?.requestedRevision).toBe(2);
  });

  it("预览请求变形 payload 被拒且不进 service", async () => {
    const res = await videoCutPreviewHandler({ content_id: contentId, keeps: "seg-0001", base_transcript_revision: 1, base_cut_revision: 2, _dataDir: dir });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("keeps 必须是分句 id 数组");
    expect(calls.requestCutPreview).toEqual([]);
  });

  it("重新组装：只要 content_id，判定在 service", async () => {
    const res = await videoReassembleHandler({ content_id: contentId, _dataDir: dir });
    expect(res.ok).toBe(true);
    expect(calls.reassemble).toEqual([contentId]);
  });

  it("三条新通道都吃 service 未起 / 工作区不符这两道门", async () => {
    setVideoService(null);
    for (const h of [videoEditorSlotFillHandler, videoCutPreviewHandler, videoReassembleHandler]) {
      expect((await h({ content_id: contentId })).ok).toBe(false);
    }
    setVideoService(stubService(), dir);
    for (const h of [videoEditorSlotFillHandler, videoCutPreviewHandler, videoReassembleHandler]) {
      const res = await h({ content_id: contentId, _dataDir: "/another/workspace" });
      expect(String(res.error)).toContain("切换工作区后请重启");
    }
  });
});
