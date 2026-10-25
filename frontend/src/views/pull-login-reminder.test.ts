import { describe, expect, it } from "vitest";
import { pullLoginLine } from "./PullLoginReminder";

describe("看板回流登录提醒", () => {
  it("说清哪个平台、去哪登录、上次成功是哪天", () => {
    const line = pullLoginLine({ platform: "wechat_video", label: "视频号", consoleUrl: "https://channels.weixin.qq.com", action: "在 ego lite 里登录视频号后台", lastSuccessAt: "2026-10-15T01:00:00.000Z" });
    expect(line).toContain("视频号数据回流要重新登录");
    expect(line).toContain("ego lite");
    expect(line).toContain("2026-10-15");
  });
});
