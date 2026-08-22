/**
 * 视频线前端纯逻辑(lib.ts 的人话层与提交归一)。
 *
 * 重点是 **phase×state 全枚举都有说法**——「状态机可见」是设计 spec §10 边界清单
 * 第一条,漏一个组合界面上就会出现一张什么都不说的空卡。
 *
 * 组件与 SSE 重连那段没有测试:仓库的前端测试跑在 node 环境(vitest.config.ts),
 * 没有 DOM/EventSource,而补 jsdom 要新增依赖——本期约定 frontend 不加依赖。
 */
import { describe, expect, it } from "vitest";
import {
  VIDEO_PHASE_LABEL,
  alignmentWarning,
  formatMinutesSeconds,
  formatTimecode,
  keepsInTranscriptOrder,
  roughCutSummary,
  videoBlockedGuide,
  videoFinalAssetName,
  videoMediaUrl,
  videoStateSummary,
  type TranscriptSegment,
  type VideoBlockedReason,
  type VideoEditUnits,
  type VideoPhase,
  type VideoRunState,
  type VideoState,
  type VideoTranscript,
} from "./lib";

const PHASES: VideoPhase[] = ["ingest", "transcribe", "cut", "assemble", "render", "review", "done"];
const RUN_STATES: VideoRunState[] = ["idle", "queued", "running", "awaiting_human", "blocked", "failed", "done"];
const REASONS: VideoBlockedReason[] = ["asr_not_ready", "ffmpeg_missing", "key_missing", "aroll_drifted", "budget_exceeded"];

function state(patch: Partial<VideoState>): VideoState {
  return {
    schemaVersion: 1,
    entryType: "aroll",
    phase: "ingest",
    state: "idle",
    revisions: {},
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...patch,
  };
}

describe("videoStateSummary", () => {
  it("phase×state 全枚举都有非空人话,不出现裸英文状态名", () => {
    for (const phase of PHASES) {
      for (const run of RUN_STATES) {
        const text = videoStateSummary(state({ phase, state: run }));
        expect(text.trim().length, `${phase}/${run}`).toBeGreaterThan(0);
        expect(text, `${phase}/${run}`).not.toContain(phase);
        expect(text, `${phase}/${run}`).not.toContain(run);
      }
    }
  });

  it("两道人工门各自说清楚等的是什么", () => {
    expect(videoStateSummary(state({ phase: "cut", state: "awaiting_human" }))).toContain("勾选");
    expect(videoStateSummary(state({ phase: "review", state: "awaiting_human" }))).toContain("审片");
  });

  it("失败按 failedPhase 报,不报当前 phase", () => {
    const s = state({ phase: "render", state: "failed", failedPhase: "assemble" });
    expect(videoStateSummary(s)).toContain(VIDEO_PHASE_LABEL.assemble);
    expect(videoStateSummary(s)).not.toContain(VIDEO_PHASE_LABEL.render);
  });

  it("blocked 带上阻因标题", () => {
    const s = state({ phase: "transcribe", state: "blocked", blockedReason: "asr_not_ready" });
    expect(videoStateSummary(s)).toContain(videoBlockedGuide("asr_not_ready").title);
  });
});

describe("videoBlockedGuide", () => {
  it("五种阻因各有一条人话指引", () => {
    for (const reason of REASONS) {
      const guide = videoBlockedGuide(reason);
      expect(guide.title.length, reason).toBeGreaterThan(0);
      expect(guide.how.length, reason).toBeGreaterThan(0);
    }
  });

  it("asr 有专属动作,ffmpeg 有可复制命令", () => {
    expect(videoBlockedGuide("asr_not_ready").action).toBe("asr_warmup");
    expect(videoBlockedGuide("ffmpeg_missing").command).toContain("ffmpeg");
    expect(videoBlockedGuide("aroll_drifted").action).toBeUndefined();
  });

  it("没给原因也有说法(不留一张没解释的红卡)", () => {
    const guide = videoBlockedGuide(undefined);
    expect(guide.title.length).toBeGreaterThan(0);
    expect(guide.how.length).toBeGreaterThan(0);
  });
});

describe("媒体地址", () => {
  it("播放地址指向被审那一版,并对 contentId 做编码", () => {
    expect(videoMediaUrl("content-1", 2)).toBe("/api/video/media/content-1/final.v2.mp4");
    expect(videoMediaUrl("a/b", 1)).toBe("/api/video/media/a%2Fb/final.v1.mp4");
  });

  it("登记回稿件素材的文件名与播放名不同源(render-exec 的两套命名)", () => {
    expect(videoFinalAssetName(3)).toBe("final-v3.mp4");
  });
});

describe("formatTimecode", () => {
  it("毫秒 → mm:ss.s", () => {
    expect(formatTimecode(0)).toBe("00:00.0");
    expect(formatTimecode(12345)).toBe("00:12.3");
    expect(formatTimecode(123450)).toBe("02:03.4");
    expect(formatTimecode(3_600_000)).toBe("60:00.0");
  });

  it("坏值不显示成 NaN", () => {
    expect(formatTimecode(Number.NaN)).toBe("00:00.0");
    expect(formatTimecode(-5)).toBe("00:00.0");
  });
});

describe("keepsInTranscriptOrder", () => {
  const segments: TranscriptSegment[] = [
    { id: "s1", text: "一", startMs: 0, endMs: 1000 },
    { id: "s2", text: "二", startMs: 1000, endMs: 2000 },
    { id: "s3", text: "三", startMs: 2000, endMs: 3000 },
  ];

  it("按转写顺序归一(勾选顺序不影响提交内容)", () => {
    expect(keepsInTranscriptOrder(segments, new Set(["s3", "s1"]))).toEqual(["s1", "s3"]);
  });

  it("不认识的 id 不会被带出去(后端会拒,前端先别造)", () => {
    expect(keepsInTranscriptOrder(segments, new Set(["s2", "ghost"]))).toEqual(["s2"]);
  });

  it("一句不留 = 空数组(交给后端拒,不在这里假装成功)", () => {
    expect(keepsInTranscriptOrder(segments, new Set<string>())).toEqual([]);
  });
});

describe("formatMinutesSeconds", () => {
  it("不足一分钟只报秒;坏值不显示成 NaN", () => {
    expect(formatMinutesSeconds(45_000)).toBe("45 秒");
    expect(formatMinutesSeconds(125_000)).toBe("2 分 5 秒");
    expect(formatMinutesSeconds(Number.NaN)).toBe("0 秒");
    expect(formatMinutesSeconds(-1)).toBe("0 秒");
  });
});

describe("roughCutSummary", () => {
  const units = (patch: Partial<VideoEditUnits>): VideoEditUnits => ({
    schemaVersion: 1,
    transcriptRevision: 1,
    origin: "llm",
    segments: [
      { id: "unit-0001", text: "一", startMs: 0, endMs: 30_000 },
      { id: "unit-0002", text: "二", startMs: 30_000, endMs: 90_000 },
    ],
    suggestedDrops: [],
    flags: [],
    ...patch,
  });

  it("报剔除数、总数与预计成片时长", () => {
    const text = roughCutSummary(units({ suggestedDrops: ["unit-0001"] }))!;
    expect(text).toContain("剔除 1 段");
    expect(text).toContain("共 2 段");
    expect(text).toContain("1 分 0 秒");
  });

  it("有剔除就说明切口是硬切——不静默假装无损", () => {
    expect(roughCutSummary(units({ suggestedDrops: ["unit-0001"] }))).toContain("硬切");
    expect(roughCutSummary(units({}))).not.toContain("硬切");
  });

  it("drops 为空但 AI 确实跑过 → 明说「认为无需剔除」", () => {
    expect(roughCutSummary(units({}))).toContain("无需剔除");
  });

  it("全留版(raw)不报 AI 结论——AI 压根没跑,说「剔除 0 段」是骗人", () => {
    expect(roughCutSummary(units({ origin: "raw" }))).toBeNull();
    expect(roughCutSummary(undefined)).toBeNull();
  });
});

describe("alignmentWarning", () => {
  const base: VideoTranscript = { schemaVersion: 1, source: "funasr", segments: [] };

  it("matchedRatio < 0.5 提示逐句确认", () => {
    const warn = alignmentWarning({ ...base, scriptAlignment: { matchedRatio: 0.32 } });
    expect(warn).toContain("32%");
  });

  it("对得上或没有对齐数据都不吓唬人", () => {
    expect(alignmentWarning({ ...base, scriptAlignment: { matchedRatio: 0.5 } })).toBeNull();
    expect(alignmentWarning({ ...base })).toBeNull();
    expect(alignmentWarning(null)).toBeNull();
  });
});
