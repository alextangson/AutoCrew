/**
 * event-map.test.ts — IPC 结果 → 工作日志事件的映射语义
 */
import { describe, it, expect } from "vitest";
import { CHANNEL_EVENT_MAP } from "./event-map.js";

const map = (ch: keyof typeof CHANNEL_EVENT_MAP, payload: Record<string, unknown>, result: Record<string, unknown>) =>
  CHANNEL_EVENT_MAP[ch]!({ payload, result });

describe("channel event map", () => {
  it("transition：成功 → 人话状态；失败 → 不记", () => {
    const e = map("content:transition", { id: "c1", target_status: "reviewing" }, { ok: true, content: { title: "标题" } });
    expect(e).toMatchObject({ role: "system", kind: "transition", contentId: "c1" });
    expect(e!.label).toBe("《标题》 → 待审");
    expect(map("content:transition", { id: "c1", target_status: "reviewing" }, { ok: false })).toBeNull();
  });

  it("adoption：带裁决人话与采纳率；rate null 不显示假 0%", () => {
    const e = map(
      "content:adoption",
      { id: "c1", verdict: "light_edit" },
      { ok: true, content: { title: "T" }, stats: { rate: 2 / 3, judged: 3 } },
    );
    expect(e!.label).toContain("轻改采纳");
    expect(e!.label).toContain("67%");
    const noRate = map("content:adoption", { id: "c1", verdict: "adopted" }, { ok: true, content: {}, stats: { rate: null } });
    expect(noRate!.label).not.toContain("%");
  });

  it("update：只在蒸馏出新规则时记日志", () => {
    expect(map("content:update", {}, { ok: true, content: {} })).toBeNull();
    const e = map("content:update", {}, { ok: true, styleLearned: { newRules: [1, 2] } });
    expect(e!.label).toContain("2 条风格规则");
  });

  it("publish：回执带配图数；阻断带违禁词；其他失败不记", () => {
    const ok = map("publish:wechat_draft", { content_id: "c1" }, { ok: true, imageCount: 3 });
    expect(ok).toMatchObject({ role: "publisher", kind: "publish_receipt" });
    expect(ok!.label).toContain("3 张");
    const blocked = map("publish:wechat_draft", { content_id: "c1" }, { ok: false, violations: ["翻墙"] });
    expect(blocked).toMatchObject({ role: "review", kind: "publish_blocked" });
    expect(blocked!.label).toContain("翻墙");
    expect(map("publish:wechat_draft", { content_id: "c1" }, { ok: false, error: "网络错误" })).toBeNull();
  });

  it("radar：带候选数，缺 data 时降级为无数字文案", () => {
    expect(map("radar:refresh", {}, { ok: true, data: { topics: [1, 2, 3] } })!.label).toContain("3 条");
    expect(map("radar:refresh", {}, { ok: true })!.label).toBe("侦察员扫榜完成");
  });

  it("radar more/rescore：记录新增与重评数量", () => {
    expect(map("radar:more", {}, { ok: true, data: { savedCount: 5 } })!.label).toContain("新增 5 条");
    expect(map("radar:rescore", {}, { ok: true, data: { updatedCount: 12 } })!.label).toContain("12 条");
  });
});
