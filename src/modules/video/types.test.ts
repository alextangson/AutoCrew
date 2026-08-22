/**
 * types.test.ts —— 跨边界契约锁（spec §2.8 / §3）。
 *
 * `render-manifest.json` 是主进程与 render workspace 之间的协议：render CLI 按这个形状
 * **自己**声明类型（禁止跨 workspace import TS 源码），所以字段名一改，两边就悄悄对不上了。
 * 这里把字段集合钉死——重命名字段必然让测试红，逼人同时去改 render 侧。
 *
 * 类型正确性由 `tsc --noEmit` 保证（本文件的字面量都带类型标注）；
 * 运行时断言只管一件事：**JSON 里出现的键名，一个不多一个不少**。
 */
import { describe, it, expect } from "vitest";
import type { RenderManifest, VideoJob, VideoState } from "./types.js";

const manifest: RenderManifest = {
  schemaVersion: 2,
  contentId: "content-1-abc",
  timelineRevision: 1,
  cutRevision: 2,
  transcriptRevision: 1,
  fps: 30,
  width: 1920,
  height: 1080,
  durationMs: 42_000,
  anchorAudio: { file: "/abs/anchor.wav", durationMs: 42_000 },
  arollVideo: {
    file: "/abs/aroll.mp4",
    segments: [{ sourceStartMs: 0, sourceEndMs: 1000, outputStartMs: 0 }],
  },
  overlays: [
    {
      clipId: "c1",
      outputStartMs: 1000,
      durationMs: 2000,
      kind: "screen",
      file: "/abs/screen.mp4",
      inMs: 0,
      outMs: 2000,
      fit: "cover",
      transition: "fade",
    },
    {
      clipId: "c2",
      outputStartMs: 4000,
      durationMs: 1500,
      kind: "graphic",
      template: "code-block",
      props: { code: "print(1)", lang: "py" },
    },
  ],
  captions: {
    style: "word-highlight",
    words: [{ w: "你", startMs: 0, endMs: 200 }],
    emphasisWords: ["重点"],
  },
  titleCard: { template: "hook-title", text: "钩子", durationMs: 1200 },
  identity: {
    captionTheme: { fontFamily: "Source Han Sans", primaryColor: "#fff", emphasisColor: "#ff0" },
    codeTheme: { background: "#0d1117", foreground: "#c9d1d9", accent: "#58a6ff" },
  },
  provenance: { hasAiClips: false, hasClonedVoice: false },
};

describe("RenderManifest 渲染契约", () => {
  it("顶层字段集合锁定", () => {
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "anchorAudio", "arollVideo", "captions", "contentId", "cutRevision", "durationMs",
        "fps", "height", "identity", "overlays", "provenance", "schemaVersion",
        "timelineRevision", "titleCard", "transcriptRevision", "width",
      ].sort(),
    );
  });

  it("嵌套结构字段集合锁定", () => {
    expect(Object.keys(manifest.anchorAudio).sort()).toEqual(["durationMs", "file"]);
    expect(Object.keys(manifest.arollVideo).sort()).toEqual(["file", "segments"]);
    expect(Object.keys(manifest.arollVideo.segments[0]).sort())
      .toEqual(["outputStartMs", "sourceEndMs", "sourceStartMs"]);
    expect(Object.keys(manifest.captions).sort()).toEqual(["emphasisWords", "style", "words"]);
    expect(Object.keys(manifest.captions.words[0]).sort()).toEqual(["endMs", "startMs", "w"]);
    expect(Object.keys(manifest.identity).sort()).toEqual(["captionTheme", "codeTheme"]);
    expect(Object.keys(manifest.identity.captionTheme).sort())
      .toEqual(["emphasisColor", "fontFamily", "primaryColor"]);
    expect(Object.keys(manifest.provenance).sort()).toEqual(["hasAiClips", "hasClonedVoice"]);
  });

  it("覆盖轨字段集合锁定（screen 与 graphic 两种形态）", () => {
    expect(Object.keys(manifest.overlays[0]).sort()).toEqual(
      ["clipId", "durationMs", "file", "fit", "inMs", "kind", "outMs", "outputStartMs", "transition"],
    );
    expect(Object.keys(manifest.overlays[1]).sort()).toEqual(
      ["clipId", "durationMs", "kind", "outputStartMs", "props", "template"],
    );
  });

  it("唯一画幅 = 横屏 1920×1080@30，画幅是契约不是配置（横屏 spec §2.1）", () => {
    expect([manifest.fps, manifest.width, manifest.height]).toEqual([30, 1920, 1080]);
    expect(manifest.schemaVersion).toBe(2);
  });

  it("JSON 往返无损（manifest 必须是纯数据，不能夹带类实例/函数）", () => {
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});

describe("VideoState / VideoJob 落盘形状", () => {
  it("state 的必填字段就是这些；可选字段缺省时不出现在 JSON 里", () => {
    const s: VideoState = {
      schemaVersion: 1,
      entryType: "aroll",
      phase: "transcribe",
      state: "running",
      revisions: {},
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
    expect(Object.keys(JSON.parse(JSON.stringify(s))).sort()).toEqual(
      ["entryType", "phase", "revisions", "schemaVersion", "state", "updatedAt"],
    );
  });

  it("失败态带得出恢复点：failedPhase + errorCode + failReason", () => {
    const s: VideoState = {
      schemaVersion: 1, entryType: "aroll", phase: "render", state: "failed",
      failedPhase: "render", errorCode: "ffmpeg_exit_1", failReason: "编码器返回非零",
      revisions: { transcript: 1, cut: 2, timeline: 1 },
      updatedAt: "2026-07-27T00:00:00.000Z",
    };
    expect(s.failedPhase).toBe("render");
    expect(s.revisions.rendered).toBeUndefined();
  });

  it("job 的读视图键三件套（contentId / phase / inputKey）都在类型里", () => {
    const j: VideoJob = {
      jobId: "vjob-1-a", contentId: "content-1-abc", phase: "render",
      inputKey: "t1|c2|k1", status: "running", attempts: 1,
      leaseOwner: "pid-123@launch-abc", claimedAt: "2026-07-27T00:00:00.000Z",
      heartbeatAt: "2026-07-27T00:01:00.000Z",
    };
    expect(`${j.contentId}|${j.phase}|${j.inputKey}`).toBe("content-1-abc|render|t1|c2|k1");
  });
});
