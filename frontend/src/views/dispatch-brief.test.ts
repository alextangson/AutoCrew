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

  it("已有稿件派生新平台稿时先读取源稿，沿用写稿管线并保留原稿", () => {
    const brief = buildDispatchBrief({
      ...base,
      topic: topic(),
      platform: "douyin",
      source: { id: "content-source", title: "退货率原稿", platform: "wechat_mp" },
    });
    expect(brief).toContain("抖音原生版本");
    expect(brief).toContain("《退货率原稿》（公众号");
    expect(brief).toContain("get_draft（id：content-source）");
    expect(brief).toContain("再调用 generate_script");
    expect(brief).toContain("research 参数");
    expect(brief).toContain("基于原稿事实和立意");
    expect(brief).toContain("topic-1");
    expect(brief).toContain("保留上述原 topic_id");
    expect(brief).toContain("另存目标平台新稿，不覆盖源稿");
    expect(brief).toContain("写前角度选择、证据检查和审稿流程");
    expect(brief).toContain("不调用 adapt_platform");
    expect(brief).not.toContain("skip_reason");
  });

  it("复用源稿仍保留用户 direction 和显式跳过角度的原话", () => {
    const brief = buildDispatchBrief({
      ...base,
      topic: topic(),
      source: { id: "content-source", title: "退货率原稿", platform: "wechat_mp" },
      direction: " 只写消费者退货这一条线 ",
      skipAngle: true,
    });
    expect(brief).toContain("direction 参数)：只写消费者退货这一条线");
    expect(brief).toContain("最高优先级");
    expect(brief).toContain("用户已在工作台点了「直接写」");
    expect(brief).toContain("skip_reason 参数");
  });

  it("选题记录缺失时使用稿件留存的 topicId，原有血缘不断", () => {
    const brief = buildDispatchBrief({ ...base, topic: null, topicId: " topic-missing " });
    expect(brief).toContain("选题编号：topic-missing");
    expect(brief).toContain("仍带上原 topic_id");
    expect(brief).not.toContain(" topic-missing ");
  });

  it("真实 topic.id 优先，不让备用 topicId 改写血缘", () => {
    const brief = buildDispatchBrief({ ...base, topic: topic(), topicId: "topic-wrong" });
    expect(brief).toContain("topic-1");
    expect(brief).not.toContain("topic-wrong");
  });

  it("没有源稿、没有有效备用编号时保持原有派稿内容", () => {
    expect(buildDispatchBrief({ ...base, topic: null, topicId: "  " }))
      .toBe("用选题《直播带货的退货率》写一篇公众号原生版本");
    expect(buildDispatchBrief({ ...base, topic: topic() }))
      .toBe("用选题《直播带货的退货率》写一篇公众号原生版本。选题上下文——灵感库编号：topic-1（开写时带上 topic_id,血缘别断）");
  });
});
