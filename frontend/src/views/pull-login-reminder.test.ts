import { describe, expect, it } from "vitest";
import { pullLoginLine, retryMessage } from "./PullLoginReminder";

describe("看板回流登录提醒", () => {
  it("说清哪个平台、去哪登录、上次成功是哪天", () => {
    const line = pullLoginLine({ platform: "wechat_video", label: "视频号", consoleUrl: "https://channels.weixin.qq.com", action: "在 ego lite 里登录视频号后台", lastSuccessAt: "2026-10-15T01:00:00.000Z" });
    expect(line).toContain("视频号数据回流要重新登录");
    expect(line).toContain("ego lite");
    expect(line).toContain("2026-10-15");
  });
});

describe("重抓结果照实说", () => {
  it("风控 / 浏览器没连 / 超时 / 状态没写住不说成「要重新登录」", () => {
    const at = (status: string, extra = {}) => retryMessage("视频号", { ok: true, data: { platform: "wechat_video", status, ...extra } });
    expect(at("risk_control")).toContain("风控");
    expect(at("browser_unreachable")).toContain("浏览器未连接");
    expect(at("timeout")).toContain("超时");
    expect(at("in_flight")).toContain("正在抓");
    expect(at("ok", { rowCount: 3, imported: 3, persistError: "EIO" })).toContain("状态没写住");
    expect(at("needs_login")).toContain("登录");
    expect(retryMessage("视频号", { ok: false, error: "服务挂了" })).toBe("服务挂了");
  });
});
