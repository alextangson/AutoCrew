import { describe, expect, it } from "vitest";
import { anySubmitted, parsePublishPlan, recordTime, withManual } from "./publish-record.js";

const NOW = Date.parse("2026-09-28T12:00:00+08:00");
const plan = (platforms: unknown) => JSON.stringify({ schema_version: 1, platforms });

describe("parsePublishPlan", () => {
  it("缺文件 = none；坏 JSON / 没有平台清单 / 平台条目不是对象 = 读不到", () => {
    expect(parsePublishPlan(null, NOW)).toEqual({ kind: "none" });
    expect(parsePublishPlan("{oops", NOW)).toMatchObject({ kind: "unreadable" });
    expect(parsePublishPlan(JSON.stringify({ platforms: "douyin" }), NOW)).toMatchObject({ kind: "unreadable" });
    expect(parsePublishPlan(plan(["douyin"]), NOW)).toMatchObject({ kind: "unreadable" });
    expect(parsePublishPlan(plan([{ publication: { status: "scheduled" } }]), NOW)).toMatchObject({ kind: "unreadable" });
  });

  it("定时（未到）/ 应已公开（已过）/ 未提交 / 审核不通过 / 已公开", () => {
    const r = parsePublishPlan(plan([
      { platform: "douyin", publication: { status: "scheduled", review_status: "reviewing", scheduled_at: "2026-10-02T18:00:00+08:00" } },
      { platform: "bilibili", publication: { status: "scheduled", scheduled_at: "2026-09-27T18:00:00+08:00" } },
      { platform: "wechat_video", publication: { status: "not_submitted" } },
      { platform: "xiaohongshu", publication: { status: "scheduled", review_status: "rejected", reject_reason: "封面违规" } },
      { platform: "toutiao", publication: { status: "published", published_at: "2026-09-26T10:00:00+08:00" } },
    ]), NOW);
    if (r.kind !== "ok") throw new Error("expected ok");
    const by = Object.fromEntries(r.platforms.map((p) => [p.platform, p]));
    expect(by.douyin).toMatchObject({ state: "scheduled", submitted: true, review: "reviewing", time: "2026-10-02T18:00:00+08:00" });
    expect(by.bilibili).toMatchObject({ state: "overdue", submitted: true });
    expect(by.wechat_video).toMatchObject({ state: "not_submitted", submitted: false });
    expect(by.xiaohongshu).toMatchObject({ state: "rejected", submitted: true, reason: "封面违规" });
    expect(by.toutiao).toMatchObject({ state: "public", time: "2026-09-26T10:00:00+08:00" });
    expect(anySubmitted(r)).toBe(true);
    expect(recordTime(r)).toBe("2026-10-02T18:00:00+08:00");
  });

  it("不认识的状态：保留原值，不算已发、也不算未发", () => {
    const r = parsePublishPlan(plan([{ platform: "douyin", publication: { status: "queued_by_robot" } }]), NOW);
    expect(r).toMatchObject({ kind: "ok", platforms: [{ state: "unknown", raw: "queued_by_robot", submitted: false }] });
    expect(anySubmitted(r)).toBe(false);
  });

  it("选中的活动名带出来，没选的不带", () => {
    const r = parsePublishPlan(plan([{ platform: "douyin", campaigns: [{ name: "AI新星计划", selected: true }, { name: "别的", selected: false }] }]), NOW);
    expect(r).toMatchObject({ kind: "ok", platforms: [{ campaigns: ["AI新星计划"], state: "not_submitted" }] });
  });
});

describe("withManual", () => {
  const mark = { platform: "wechat_video", at: "2026-09-28T09:00:00+08:00", url: "https://channels.weixin.qq.com/x" };
  it("盖过计划里的未提交；计划里没有的平台也列出来", () => {
    const base = parsePublishPlan(plan([{ platform: "wechat_video", publication: { status: "not_submitted" } }]), NOW);
    const r = withManual(base, [mark, { platform: "bilibili", at: mark.at }]);
    expect(r).toMatchObject({ kind: "ok", platforms: [{ platform: "wechat_video", state: "manual", submitted: true, url: mark.url }, { platform: "bilibili", state: "manual" }] });
  });
  it("计划缺失时手动标记单独成立；计划读不到时仍说读不到但保留手动行", () => {
    expect(withManual({ kind: "none" }, [mark])).toMatchObject({ kind: "ok", platforms: [{ state: "manual" }] });
    const r = withManual(parsePublishPlan("{", NOW), [mark]);
    expect(r).toMatchObject({ kind: "unreadable", platforms: [{ state: "manual" }] });
    expect(anySubmitted(r)).toBe(true);
  });
});
