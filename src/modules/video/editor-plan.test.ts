/**
 * editor-plan.test.ts —— 剪辑师的确定性部分（横屏 spec §3.3 校验 + §4 边界清单）。
 * 硬规则全在这一层，所以**边界值逐条锁死**：恰好 60% 覆盖、恰好 45s、恰好 5s 露脸、
 * 恰好 3 次引用都必须合法，多 1ms 就必须被拦。卡在等号上的产物最难查。
 */
import { describe, it, expect } from "vitest";
import type { Asset } from "../../storage/local-store.js";
import {
  IMAGE_MAX_MS,
  OVERLAY_MAX_MS,
  hasLegalWindow,
  normalizeEmphasisWords,
  planToSlots,
  scanBrollCandidates,
  toPlanOverlays,
  trimCandidates,
  unmatchedEmphasisWords,
  validatePlanOverlays,
  type EditorCandidate,
  type SubmittedOverlay,
} from "./editor-plan.js";

/** 200 秒的成片：掐掉开头 30s / 结尾 15s 之后，合法窗口是 [30000, 185000] */
const TOTAL = 200_000;

const screen: EditorCandidate = {
  assetId: "b1",
  kind: "screen",
  label: "屏录：产品界面演示",
  filename: "screen.mp4",
  tags: [],
  durationMs: 60_000,
  ref: { kind: "content", filename: "screen.mp4" },
};
const image: EditorCandidate = {
  assetId: "b2",
  kind: "image",
  label: "图版：三层结构",
  filename: "layers.png",
  tags: [],
  ref: { kind: "content", filename: "layers.png" },
};
const candidates = [screen, image];

const one = (over: Partial<SubmittedOverlay> = {}): SubmittedOverlay => ({
  assetId: "b1",
  outputStartMs: 40_000,
  durationMs: 10_000,
  inMs: 0,
  outMs: 10_000,
  ...over,
});
const check = (items: SubmittedOverlay[]): string[] => validatePlanOverlays(items, candidates, TOTAL);

describe("校验：素材与时间的基本盘", () => {
  it("一段规规矩矩的屏录 → 无错误", () => {
    expect(check([one()])).toEqual([]);
  });

  it("assetId 不在清单里 → 打回并列出可用编号", () => {
    expect(check([one({ assetId: "b9" })])[0]).toContain("b9");
    expect(check([one({ assetId: "b9" })])[0]).toContain("b1、b2");
  });

  it("超出成片总长 → 越界", () => {
    const errors = check([one({ outputStartMs: 180_000, durationMs: 30_000, outMs: 30_000 })]);
    expect(errors.join()).toContain("越界");
  });

  it("负起点 / 零时长 → 当场打回，不往下算", () => {
    expect(check([one({ durationMs: 0, outMs: 0 })])[0]).toContain("durationMs 必须 >0");
    expect(check([one({ outputStartMs: -1 })])[0]).toContain("outputStartMs 必须 ≥0");
  });
});

describe("校验：开头 30s 与结尾 15s 的禁区（代码判，不是 prompt 请求）", () => {
  it("恰好卡在 30000ms 开始合法，早 1ms 就被拦", () => {
    expect(check([one({ outputStartMs: 30_000 })])).toEqual([]);
    expect(check([one({ outputStartMs: 29_999 })]).join()).toContain("禁区");
  });

  it("恰好在 185000ms 结束合法，晚 1ms 就被拦", () => {
    expect(check([one({ outputStartMs: 175_000 })])).toEqual([]);
    expect(check([one({ outputStartMs: 175_001 })]).join()).toContain("禁区");
  });

  it("片子太短就没有合法窗口——这时不该调模型", () => {
    expect(hasLegalWindow(60_000)).toBe(true);
    expect(hasLegalWindow(48_000)).toBe(true);
    expect(hasLegalWindow(47_999)).toBe(false);
    expect(hasLegalWindow(2_000)).toBe(false);
  });
});

describe("校验：时长上限（边界值合法）", () => {
  it("单段恰好 45s 合法，45001ms 被拦", () => {
    expect(check([one({ durationMs: OVERLAY_MAX_MS, outMs: OVERLAY_MAX_MS })])).toEqual([]);
    expect(check([one({ durationMs: OVERLAY_MAX_MS + 1, outMs: OVERLAY_MAX_MS + 1 })]).join()).toContain("超过上限");
  });

  it("图片恰好 15s 合法，15001ms 被拦（静图挂太久观众走神）", () => {
    const img = (durationMs: number): SubmittedOverlay => ({ assetId: "b2", outputStartMs: 40_000, durationMs });
    expect(check([img(IMAGE_MAX_MS)])).toEqual([]);
    expect(check([img(IMAGE_MAX_MS + 1)]).join()).toContain("图片上限");
  });
});

describe("校验：inMs/outMs（codex 的阻断项）", () => {
  it("屏录不给取材窗口 → 打回并告诉它素材多长", () => {
    const errors = check([{ assetId: "b1", outputStartMs: 40_000, durationMs: 10_000 }]);
    expect(errors.join()).toContain("缺 inMs/outMs");
    expect(errors.join()).toContain("60000ms");
  });

  it("跨度与 durationMs 对不上 → 打回（不做变速）", () => {
    expect(check([one({ inMs: 0, outMs: 12_000 })]).join()).toContain("对不上");
  });

  it("outMs 超过素材全长 → 打回", () => {
    expect(check([one({ inMs: 55_000, outMs: 65_000 })]).join()).toContain("超过素材");
  });

  it("倒挂区间 → 打回", () => {
    expect(check([one({ inMs: 9_000, outMs: 9_000 })]).join()).toContain("不成立");
  });

  it("恰好取到素材末尾合法", () => {
    expect(check([one({ inMs: 50_000, outMs: 60_000 })])).toEqual([]);
  });

  it("图片带 inMs/outMs → 打回（它没有时间轴）", () => {
    expect(check([{ assetId: "b2", outputStartMs: 40_000, durationMs: 5_000, inMs: 0, outMs: 5_000 }]).join()).toContain(
      "没有时间轴",
    );
  });
});

describe("校验：排布（重叠 / 露脸间隔 / 总覆盖 / 引用次数）", () => {
  it("两段重叠 → 打回", () => {
    const items = [one({ outputStartMs: 40_000 }), one({ outputStartMs: 45_000 })];
    expect(check(items).join()).toContain("重叠");
  });

  it("间隔恰好 5s 合法，4999ms 被拦", () => {
    const gapOf = (gap: number) => [one({ outputStartMs: 40_000 }), one({ outputStartMs: 50_000 + gap })];
    expect(check(gapOf(5_000))).toEqual([]);
    expect(check(gapOf(4_999)).join()).toContain("露脸");
  });

  it("覆盖恰好 60% + 同素材恰好 3 次 → 合法；多 1ms 就超", () => {
    const trio = (last: number): SubmittedOverlay[] => [
      one({ outputStartMs: 30_000, durationMs: 40_000, inMs: 0, outMs: 40_000 }),
      one({ outputStartMs: 75_000, durationMs: 40_000, inMs: 10_000, outMs: 50_000 }),
      // 取材窗口贴着素材末尾往前推，多出来的那 1ms 只体现在总覆盖上
      one({ outputStartMs: 120_000, durationMs: last, inMs: 60_000 - last, outMs: 60_000 }),
    ];
    expect(check(trio(40_000))).toEqual([]);
    expect(check(trio(40_001)).join()).toContain("总覆盖");
  });

  it("同一素材第 4 次引用 → 打回", () => {
    const four = [30_000, 75_000, 120_000, 160_000].map((outputStartMs) =>
      one({ outputStartMs, durationMs: 10_000, inMs: 0, outMs: 10_000 }),
    );
    expect(check(four).join()).toContain("上限 3 次");
  });

  it("转场必须在受控枚举里", () => {
    expect(check([one({ transition: "zoom" })]).join()).toContain("受控枚举");
    expect(check([one({ transition: "fade" })])).toEqual([]);
  });
});

describe("定型：toPlanOverlays / planToSlots", () => {
  it("按时间排序编号，屏录默认 cut、图版默认 fade，素材落点被钉住", () => {
    const plan = toPlanOverlays(
      [
        { assetId: "b2", outputStartMs: 60_000, durationMs: 5_000 },
        one({ outputStartMs: 40_000 }),
      ],
      candidates,
    );
    expect(plan.map((o) => o.overlayId)).toEqual(["ov-01", "ov-02"]);
    expect(plan[0]).toMatchObject({ assetId: "b1", kind: "screen", transition: "cut", label: "屏录：产品界面演示" });
    expect(plan[1]).toMatchObject({ assetId: "b2", kind: "image", transition: "fade", ref: { kind: "content", filename: "layers.png" } });
  });

  it("plan → 覆盖轨槽位：取材窗口与转场一路带过去", () => {
    const slots = planToSlots(toPlanOverlays([one({ inMs: 1_000, outMs: 11_000 })], candidates));
    expect(slots).toEqual([
      {
        kind: "screen",
        ref: { kind: "content", filename: "screen.mp4" },
        outputStartMs: 40_000,
        durationMs: 10_000,
        inMs: 1_000,
        outMs: 11_000,
        transition: "cut",
      },
    ]);
  });
});

describe("素材清单筛选（§2.6 兜底规则）", () => {
  const asset = (over: Partial<Asset>): Asset => ({
    filename: "x.mp4",
    type: "video",
    addedAt: "2026-08-22T00:00:00.000Z",
    role: "broll",
    description: "屏录：一段演示",
    media: { durationMs: 8_000 },
    ...over,
  });

  it("只收 role=broll 且有说明的；编号从 b1 起", () => {
    const scan = scanBrollCandidates([
      asset({ filename: "a.mp4" }),
      asset({ filename: "b.png", type: "image", media: undefined }),
      asset({ filename: "aroll.mp4", role: "aroll" }),
    ]);
    expect(scan.candidates.map((c) => [c.assetId, c.filename, c.kind])).toEqual([
      ["b1", "a.mp4", "screen"],
      ["b2", "b.png", "image"],
    ]);
    expect(scan.excluded).toEqual([]);
  });

  it("没写说明 / 读不出时长 / 不是视听素材 → 排除且点名（面板要说清楚）", () => {
    const scan = scanBrollCandidates([
      asset({ filename: "nodesc.mp4", description: "  " }),
      asset({ filename: "nodur.mp4", media: undefined }),
      asset({ filename: "note.txt", type: "other" }),
    ]);
    expect(scan.candidates).toEqual([]);
    expect(scan.excluded.join()).toContain("nodesc.mp4（没写说明）");
    expect(scan.excluded.join()).toContain("nodur.mp4（读不出时长");
    expect(scan.excluded.join()).toContain("note.txt（不是视频或图片");
  });

  it("素材过多 → 按预算截断，被截的进 excluded（边界 #9）", () => {
    const many = Array.from({ length: 20 }, (_, i) => asset({ filename: `s${i}.mp4`, description: "屏".repeat(80) }));
    const trimmed = trimCandidates(scanBrollCandidates(many), 500);
    expect(trimmed.candidates.length).toBeGreaterThan(0);
    expect(trimmed.candidates.length).toBeLessThan(20);
    expect(trimmed.excluded.join()).toContain("超出本次上下文预算");
  });
});

describe("强调词", () => {
  it("去空去重、保序、截到 15 个", () => {
    expect(normalizeEmphasisWords([" FDE ", "FDE", "", "效率"])).toEqual(["FDE", "效率"]);
    expect(normalizeEmphasisWords(Array.from({ length: 30 }, (_, i) => `词${i}`))).toHaveLength(15);
  });

  it("归一化后仍对不上的词被点名（边界 #14：不亮，但要看得见）", () => {
    const kept = "今天聊聊 FDE，这是第二句。";
    expect(unmatchedEmphasisWords(["fde", "第二句"], kept)).toEqual([]);
    expect(unmatchedEmphasisWords(["增长黑客"], kept)).toEqual(["增长黑客"]);
  });
});
