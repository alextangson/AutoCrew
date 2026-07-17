/**
 * quality-gate.test.ts — 纯函数门禁的判定口径测试（P0 附录 0-2 阈值语义）
 */
import { describe, it, expect } from "vitest";
import { runQualityGate, formatGateFeedback, resolveQualityGate } from "./quality-gate.js";
import { KOUBO_PACK } from "../packs/koubo.js";
import { WECHAT_ARTICLE_PACK } from "../packs/wechat-article.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";

const SPEC: QualityGateSpec = {
  minChars: 100,
  minDataPoints: 3,
  minImageTags: 2,
  bannedHookPatterns: ["^随着", "^近年来", "^在.{1,12}(领域|行业)", "^众所周知", "^不可否认"],
};

const cjk = (n: number) => "字".repeat(n);
const GOOD_HOOK = "你有没有算过一笔账";
const DATA = "增长 40%，营收 3 亿元，历时 6 个月。";

describe("runQualityGate", () => {
  it("全部达标 → 无 FAIL", () => {
    const body = `${DATA}\n[IMAGE: 增长曲线图]\n${cjk(120)}\n[IMAGE: 对比表格]`;
    expect(runQualityGate(SPEC, { hook: GOOD_HOOK, body, cta: "转发给需要的人" })).toEqual([]);
  });

  it("字数不足 → min_chars FAIL，detail 带双方计数（CJK 口径：标点/英文/数字不计）", () => {
    const failures = runQualityGate({ minChars: 50 }, { hook: "abc 123", body: cjk(30), cta: "!!" });
    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe("min_chars");
    expect(failures[0].detail).toContain("30");
    expect(failures[0].detail).toContain("50");
  });

  it("字数超限 → max_chars FAIL，detail 带双方计数", () => {
    const failures = runQualityGate({ maxChars: 100 }, { hook: "", body: cjk(150), cta: "" });
    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe("max_chars");
    expect(failures[0].detail).toContain("150");
    expect(failures[0].detail).toContain("100");
  });

  it("恰好等于 maxChars 上限 → 不 FAIL（≤ 语义）", () => {
    expect(runQualityGate({ maxChars: 100 }, { hook: "", body: cjk(100), cta: "" })).toEqual([]);
  });

  it("min 与 max 同时配置：区间内通过，区间外各自报对应 FAIL", () => {
    const spec: QualityGateSpec = { minChars: 50, maxChars: 100 };
    expect(runQualityGate(spec, { hook: "", body: cjk(80), cta: "" })).toEqual([]);
    expect(runQualityGate(spec, { hook: "", body: cjk(30), cta: "" })[0].check).toBe("min_chars");
    expect(runQualityGate(spec, { hook: "", body: cjk(120), cta: "" })[0].check).toBe("max_chars");
  });

  it("数据引用只认「数字+量纲」：裸数字与型号数字不计", () => {
    const body = "iPhone 15 很好用，跑分 1000000，但增长 40%，只用了 6 个月";
    const failures = runQualityGate({ minDataPoints: 3 }, { hook: "h", body, cta: "c" });
    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe("min_data_points");
    expect(failures[0].detail).toContain("2 处");
  });

  it("配图标记只数 body，hook/cta 里的不算", () => {
    const failures = runQualityGate(
      { minImageTags: 2 },
      { hook: "[IMAGE: 不该算]", body: "[IMAGE: 只有一个]", cta: "[IMAGE: 也不该算]" },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe("min_image_tags");
  });

  it("Hook 反模式命中 → banned_hook，多个命中只报第一个", () => {
    const failures = runQualityGate(
      { bannedHookPatterns: ["^随着", "^近年来"] },
      { hook: "随着AI的发展，近年来大家都在卷", body: "b", cta: "c" },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe("banned_hook");
    expect(failures[0].detail).toContain("随着");
  });

  it("「在…领域」中缀反模式可变长匹配", () => {
    const failures = runQualityGate(
      { bannedHookPatterns: ["^在.{1,12}(领域|行业)"] },
      { hook: "在人工智能领域，大家都在卷", body: "b", cta: "c" },
    );
    expect(failures).toHaveLength(1);
  });

  it("正常开头不触反模式；hook 前导空白不影响判定", () => {
    const spec: QualityGateSpec = { bannedHookPatterns: ["^随着"] };
    expect(runQualityGate(spec, { hook: GOOD_HOOK, body: "b", cta: "c" })).toEqual([]);
    expect(runQualityGate(spec, { hook: "  随着潮流走", body: "b", cta: "c" })).toHaveLength(1);
  });

  it("空 spec → 永不 FAIL", () => {
    expect(runQualityGate({}, { hook: "随着", body: "", cta: "" })).toEqual([]);
  });
});

describe("resolveQualityGate", () => {
  it("平台 maxChars 落在无包级 gate 的包上（口播×小红书 → 仅 maxChars 的 gate）", () => {
    expect(resolveQualityGate(KOUBO_PACK, "xiaohongshu")).toEqual({ maxChars: 1000 });
    expect(resolveQualityGate(KOUBO_PACK, "wechat_video")).toEqual({ maxChars: 800 });
  });

  it("平台无 maxChars → 原样返回包级 gate（口播×抖音无 gate → undefined）", () => {
    expect(resolveQualityGate(KOUBO_PACK, "douyin")).toBeUndefined();
  });

  it("包级 gate 保留（图文包×公众号：minChars/maxChars 都来自包级）", () => {
    const gate = resolveQualityGate(WECHAT_ARTICLE_PACK, "wechat_mp");
    expect(gate?.minChars).toBe(1500);
    expect(gate?.maxChars).toBe(2000);
    expect(gate?.minImageTags).toBeUndefined();
  });
});

describe("formatGateFeedback", () => {
  it("罗列 FAIL 明细并要求全文重交", () => {
    const msg = formatGateFeedback([
      { check: "min_chars", detail: "中文字符 100 < 5000" },
      { check: "min_image_tags", detail: "标记 1 个 < 4" },
    ]);
    expect(msg).toContain("QUALITY GATE 未通过");
    expect(msg).toContain("中文字符 100 < 5000");
    expect(msg).toContain("重新调用 submit_script");
  });
});
