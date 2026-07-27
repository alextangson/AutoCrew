/**
 * timeline-validate.test.ts —— timeline 校验矩阵（spec §2.5）。
 *
 * 这些错误串会**原样回给 LLM 自纠**并显示给人看，所以既测「拦没拦住」，
 * 也测「话说得像不像人话」（关键中文词必须出现）。
 */
import { describe, it, expect } from "vitest";
import {
  TIMELINE_REGISTRY,
  validateTimeline,
  type TimelineValidateContext,
} from "./timeline-validate.js";
import type { VideoAssetEntry, VideoTimeline } from "./types.js";

const OUTPUT_MS = 10_000;

function assets(): VideoAssetEntry[] {
  return [
    { assetId: "a-screen", kind: "screen", ref: { kind: "video", file: "s.mp4" }, status: "ready" },
    { assetId: "a-img", kind: "image", ref: { kind: "content", filename: "i.png" }, status: "confirmed" },
    { assetId: "a-pending", kind: "ai", ref: { kind: "video", file: "ai.mp4" }, status: "pending" },
    { assetId: "a-failed", kind: "ai", ref: { kind: "video", file: "x.mp4" }, status: "failed" },
  ];
}

function ctx(over: Partial<TimelineValidateContext> = {}): TimelineValidateContext {
  return { registry: TIMELINE_REGISTRY, outputDurationMs: OUTPUT_MS, assets: assets(), ...over };
}

function timeline(over: Partial<VideoTimeline> = {}): VideoTimeline {
  return {
    schemaVersion: 1,
    fps: 30,
    width: 1080,
    height: 1920,
    anchor: { kind: "aroll", transcriptRevision: 1, cutRevision: 2 },
    base: { type: "aroll" },
    overlays: [],
    captions: { style: "word-highlight", emphasisWords: ["重点"] },
    audio: { anchorGainDb: 0 },
    ...over,
  };
}

const screenOverlay = (over: Record<string, unknown> = {}) => ({
  clipId: "c1",
  outputStartMs: 1000,
  durationMs: 2000,
  source: { type: "screen", assetId: "a-screen", fit: "cover" },
  transition: "fade",
  ...over,
});

describe("合法 timeline", () => {
  it("最小合法体（无覆盖轨）→ 零错误", () => {
    expect(validateTimeline(timeline(), ctx())).toEqual([]);
  });

  it("完整体：屏录 + 图形 + 图片 + 标题卡 → 零错误", () => {
    const t = timeline({
      overlays: [
        screenOverlay(),
        {
          clipId: "c2",
          outputStartMs: 3000,
          durationMs: 1500,
          source: { type: "graphic", template: "code-block", props: { code: "x=1", lang: "py" } },
        },
        { clipId: "c3", outputStartMs: 5000, durationMs: 1000, source: { type: "image", assetId: "a-img" } },
      ] as VideoTimeline["overlays"],
      titleCard: { template: "hook-title", text: "钩子", durationMs: 1200 },
    });
    expect(validateTimeline(t, ctx())).toEqual([]);
  });

  it("首尾相接不算重叠（前一段的 end == 后一段的 start）", () => {
    const t = timeline({
      overlays: [
        screenOverlay({ clipId: "c1", outputStartMs: 0, durationMs: 1000 }),
        screenOverlay({ clipId: "c2", outputStartMs: 1000, durationMs: 1000 }),
      ] as VideoTimeline["overlays"],
    });
    expect(validateTimeline(t, ctx())).toEqual([]);
  });
});

describe("结构与头部", () => {
  it("非对象输入只报一条，不刷屏", () => {
    expect(validateTimeline("[]", ctx())).toEqual(["timeline 必须是一个 JSON 对象"]);
    expect(validateTimeline(null, ctx())).toHaveLength(1);
  });

  it("schemaVersion / fps / width / height 必须合法", () => {
    const errs = validateTimeline(timeline({ schemaVersion: 2 as 1, fps: 0, width: -1, height: 1920.5 }), ctx());
    expect(errs.join("\n")).toContain("schemaVersion 必须是 1");
    expect(errs.filter((e) => /^(fps|width|height)/.test(e))).toHaveLength(3);
  });

  it("anchor 缺失 / kind 不对 / revision 非正整数都被点名", () => {
    expect(validateTimeline(timeline({ anchor: undefined as never }), ctx()).join()).toContain("anchor 必须是对象");
    const errs = validateTimeline(
      timeline({ anchor: { kind: "tts", transcriptRevision: 0, cutRevision: 1 } as never }),
      ctx(),
    );
    expect(errs.join("\n")).toContain("anchor.kind");
    expect(errs.join("\n")).toContain("anchor.transcriptRevision");
  });

  it("base 必须是 aroll——底轨恒覆盖全程，成片不许有黑屏空洞", () => {
    expect(validateTimeline(timeline({ base: { type: "tts" } as never }), ctx()).join()).toContain("黑屏空洞");
  });

  it("audio.anchorGainDb 必须是数字；bgm 结构不全被点名", () => {
    expect(validateTimeline(timeline({ audio: { anchorGainDb: "0" } as never }), ctx()).join()).toContain("anchorGainDb");
    const errs = validateTimeline(
      timeline({ audio: { anchorGainDb: 0, bgm: { file: "", gainDb: "x" } } as never }),
      ctx(),
    );
    expect(errs.join("\n")).toContain("audio.bgm.file");
    expect(errs.join("\n")).toContain("audio.bgm.gainDb");
  });
});

describe("受控枚举命中 registry", () => {
  it("captions.style 不在枚举里 → 报错并列出可用值", () => {
    const errs = validateTimeline(timeline({ captions: { style: "karaoke" } }), ctx());
    expect(errs[0]).toContain("word-highlight");
  });

  it("captions.emphasisWords 必须是字符串数组", () => {
    const t = timeline({ captions: { style: "word-highlight", emphasisWords: [1] as never } });
    expect(validateTimeline(t, ctx()).join()).toContain("emphasisWords");
  });

  it("titleCard.template 不在枚举 / 文案空 / 时长越界", () => {
    const t = timeline({ titleCard: { template: "fancy", text: "  ", durationMs: OUTPUT_MS + 1 } });
    const errs = validateTimeline(t, ctx());
    expect(errs.join("\n")).toContain("hook-title");
    expect(errs.join("\n")).toContain("titleCard.text");
    expect(errs.join("\n")).toContain("不前插也不改总时长");
  });

  it("transition 不在枚举里 → 报错并列出 cut / fade", () => {
    const t = timeline({ overlays: [screenOverlay({ transition: "zoom" })] as VideoTimeline["overlays"] });
    expect(validateTimeline(t, ctx()).join()).toContain("cut、fade");
  });
});

describe("覆盖轨", () => {
  it("overlays 必须是数组", () => {
    expect(validateTimeline(timeline({ overlays: undefined as never }), ctx())[0]).toContain("空数组");
  });

  it("durationMs 必须 > 0", () => {
    const t = timeline({ overlays: [screenOverlay({ durationMs: 0 })] as VideoTimeline["overlays"] });
    expect(validateTimeline(t, ctx()).join()).toContain("durationMs 必须是正整数");
  });

  it("越界输出域 → 报出算式，人能一眼看懂差多少", () => {
    const t = timeline({ overlays: [screenOverlay({ outputStartMs: 9000, durationMs: 2000 })] as VideoTimeline["overlays"] });
    const errs = validateTimeline(t, ctx());
    expect(errs.join("\n")).toContain("11000ms，超过成片总长 10000ms");
  });

  it("输出域总长为 0（全删）时任何覆盖轨都无处安放，且提示先选段", () => {
    const t = timeline({ overlays: [screenOverlay()] as VideoTimeline["overlays"] });
    expect(validateTimeline(t, ctx({ outputDurationMs: 0 })).join()).toContain("请先选段再组装");
  });

  it("两两重叠被拦下", () => {
    const t = timeline({
      overlays: [
        screenOverlay({ clipId: "c1", outputStartMs: 0, durationMs: 2000 }),
        screenOverlay({ clipId: "c2", outputStartMs: 1500, durationMs: 500 }),
      ] as VideoTimeline["overlays"],
    });
    expect(validateTimeline(t, ctx()).join()).toContain("时间重叠");
  });

  it("被长片段完全包住的短片段也算重叠（不是只比相邻两条）", () => {
    const t = timeline({
      overlays: [
        screenOverlay({ clipId: "c1", outputStartMs: 0, durationMs: 5000 }),
        screenOverlay({ clipId: "c2", outputStartMs: 100, durationMs: 100 }),
        screenOverlay({ clipId: "c3", outputStartMs: 4000, durationMs: 100 }),
      ] as VideoTimeline["overlays"],
    });
    expect(validateTimeline(t, ctx()).filter((e) => e.includes("时间重叠"))).toHaveLength(2);
  });

  it("clipId 重复 / 缺失被点名", () => {
    const t = timeline({
      overlays: [
        screenOverlay({ clipId: "same", outputStartMs: 0, durationMs: 100 }),
        screenOverlay({ clipId: "same", outputStartMs: 200, durationMs: 100 }),
        screenOverlay({ clipId: "", outputStartMs: 400, durationMs: 100 }),
      ] as VideoTimeline["overlays"],
    });
    const errs = validateTimeline(t, ctx()).join("\n");
    expect(errs).toContain("clipId 重复");
    expect(errs).toContain("clipId 必须是非空字符串");
  });
});

describe("素材引用（§2.6）", () => {
  it("assetId 不在清单里 → 报错", () => {
    const t = timeline({ overlays: [screenOverlay({ source: { type: "screen", assetId: "nope" } })] as VideoTimeline["overlays"] });
    expect(validateTimeline(t, ctx()).join()).toContain("素材清单里不存在");
  });

  it("素材未就绪（pending / failed）不许进 timeline", () => {
    for (const id of ["a-pending", "a-failed"]) {
      const t = timeline({ overlays: [screenOverlay({ source: { type: "ai", assetId: id } })] as VideoTimeline["overlays"] });
      expect(validateTimeline(t, ctx()).join()).toContain("还不能用（需 ready 或 confirmed）");
    }
  });

  it("屏录裁切窗口必须自洽，fit 只认 cover / contain", () => {
    const t = timeline({
      overlays: [
        screenOverlay({ source: { type: "screen", assetId: "a-screen", inMs: 500, outMs: 500, fit: "fill" } }),
      ] as VideoTimeline["overlays"],
    });
    const errs = validateTimeline(t, ctx()).join("\n");
    expect(errs).toContain("必须大于 inMs");
    expect(errs).toContain("cover / contain");
  });

  it("source.type 不认识 → 列出四种可用类型", () => {
    const t = timeline({ overlays: [screenOverlay({ source: { type: "sticker" } })] as VideoTimeline["overlays"] });
    expect(validateTimeline(t, ctx()).join()).toContain("screen、graphic、ai、image");
  });
});

describe("图形模板 props（registry 驱动）", () => {
  const graphic = (props: unknown, template = "code-block") =>
    timeline({
      overlays: [
        { clipId: "g1", outputStartMs: 0, durationMs: 1000, source: { type: "graphic", template, props } },
      ] as VideoTimeline["overlays"],
    });

  it("模板不在 registry → 报错并列出可用模板", () => {
    expect(validateTimeline(graphic({}, "lower-third"), ctx()).join()).toContain("code-block");
  });

  it("缺必填 props → 逐个点名", () => {
    const errs = validateTimeline(graphic({ code: "x" }), ctx());
    expect(errs.join("\n")).toContain("缺少必填字段 lang");
  });

  it("props 类型不对 → 说清应为什么类型", () => {
    expect(validateTimeline(graphic({ code: 1, lang: "py" }), ctx()).join()).toContain("类型应为 string");
  });

  it("未登记的 props 被拒（LLM 爱自己发明字段）", () => {
    const errs = validateTimeline(graphic({ code: "x", lang: "py", theme: "dark" }), ctx());
    expect(errs.join("\n")).toContain("未登记的字段 theme");
  });

  it("props 不是对象 → 报错", () => {
    expect(validateTimeline(graphic("code"), ctx()).join()).toContain("props 必须是对象");
  });
});
