import { describe, it, expect } from "vitest";
import { buildDispatchBrief } from "./dispatch-brief";
import type { Topic } from "../lib";

function topic(over: Partial<Topic> = {}): Topic {
  return { id: "topic-1", title: "直播带货的退货率", createdAt: "2026-08-20T00:00:00.000Z", ...over };
}

const base = { title: "直播带货的退货率", platform: "wechat_mp", direction: "", skipAngle: false };

describe("buildDispatchBrief", () => {
  it("带上选题编号,血缘不断", () => {
    expect(buildDispatchBrief({ ...base, topic: topic() })).toContain("topic-1");
  });

  it("手写方向点名 direction 参数——模型要走结构化参数,不是把它读成普通上下文", () => {
    const brief = buildDispatchBrief({ ...base, topic: topic(), direction: " 只写退货率那条线 " });
    expect(brief).toContain("direction 参数");
    expect(brief).toContain("只写退货率那条线");
    // 首尾空白不进 brief
    expect(brief).not.toContain(" 只写退货率那条线 ");
  });

  it("没填方向就不出现 direction 那句", () => {
    expect(buildDispatchBrief({ ...base, topic: topic() })).not.toContain("direction");
  });

  it("「直接写」把跳过原话交给 skip_reason —— 跳过必须留痕,不是模型猜的布尔", () => {
    const brief = buildDispatchBrief({ ...base, topic: topic(), skipAngle: true });
    expect(brief).toContain("skip_reason");
    expect(brief).toContain("直接写");
  });

  it("没点「直接写」时绝不出现 skip_reason —— 否则等于替用户跳过了角度闸口", () => {
    expect(buildDispatchBrief({ ...base, topic: topic(), direction: "自己的角度" })).not.toContain("skip_reason");
  });

  it("孤稿(无选题)也能派活,只是没有选题上下文", () => {
    const brief = buildDispatchBrief({ ...base, topic: null });
    expect(brief).toContain("直播带货的退货率");
    expect(brief).not.toContain("选题上下文");
  });

  it("选题字段缺省的不硬凑:没有 reason/link/score 就不出现那几句", () => {
    const brief = buildDispatchBrief({ ...base, topic: topic() });
    expect(brief).not.toContain("入库理由");
    expect(brief).not.toContain("参考链接");
    expect(brief).not.toContain("选题评分");
  });

  it("描述与标题一样时不重复念一遍", () => {
    const brief = buildDispatchBrief({ ...base, topic: topic({ description: "直播带货的退货率" }) });
    expect(brief).not.toContain("背景：");
  });
});
