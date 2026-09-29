import { describe, it, expect } from "vitest";
import { buildDispatch } from "./dispatch-brief";
import type { Topic } from "../lib";

function topic(over: Partial<Topic> = {}): Topic {
  return { id: "topic-1", title: "测试", createdAt: "2026-08-20T00:00:00.000Z", ...over };
}
const base = { title: "测试", platform: "douyin", direction: "", skipAngle: false };

describe("buildDispatch（v1.1：气泡人话，编号走结构化）", () => {
  it("气泡只有人话，不含选题编号或给模型的指令", () => {
    const m = buildDispatch({ ...base, topic: topic() });
    expect(m.text).toBe("写抖音稿 ·《测试》");
    expect(m.text).not.toMatch(/topic-1|血缘|参数/);
    expect(m.dispatch).toEqual({ kind: "write", title: "测试", platform: "douyin", topic_id: "topic-1" });
  });
  it("选题记录缺失时沿用稿件上的血缘编号", () => {
    expect(buildDispatch({ ...base, topic: null, topicId: " topic-9 " }).dispatch.topic_id).toBe("topic-9");
  });
  it("手写角度、复用源稿、直接写都进结构化字段，气泡里是人话", () => {
    const m = buildDispatch({ ...base, topic: topic(), direction: " 只写退货率 ", skipAngle: true, source: { id: "content-1-a", title: "源稿", platform: "wechat_mp" } });
    expect(m.dispatch).toMatchObject({ direction: "只写退货率", skip_angle: true, source_id: "content-1-a" });
    expect(m.text).toBe("写抖音稿 ·《测试》 · 复用《源稿》 · 角度：只写退货率 · 直接写");
  });
});
