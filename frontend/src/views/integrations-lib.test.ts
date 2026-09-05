import { describe, it, expect } from "vitest";
import { integrationStatus } from "./integrations-lib";

const NOW = Date.parse("2026-09-05T10:00:00.000Z");

describe("integrationStatus", () => {
  it("没配 = 未配置", () => {
    expect(integrationStatus({ configured: false }, NOW)).toEqual({ tone: "off", text: "未配置" });
  });

  it("配了 = 已配置,可带补充说明", () => {
    expect(integrationStatus({ configured: true }, NOW)).toEqual({ tone: "on", text: "已配置" });
    expect(integrationStatus({ configured: true, okLabel: "已配置 bocha" }, NOW).text).toBe("已配置 bocha");
  });

  it("有失败记录就压过「已配置」——配了但打不通不许显示成绿的", () => {
    const s = integrationStatus({ configured: true, lastError: "401 Unauthorized", lastErrorAt: "2026-09-05T09:30:00.000Z" }, NOW);
    expect(s.tone).toBe("bad");
    expect(s.text).toBe("上次失败：401 Unauthorized（30 分钟前）");
  });

  it("有原因没时间 → 只报原因,不编一个时间出来", () => {
    expect(integrationStatus({ configured: true, lastError: "getUpdates 409" }, NOW).text).toBe("上次失败：getUpdates 409");
  });

  it("空串 / null 的 lastError 不算失败", () => {
    expect(integrationStatus({ configured: true, lastError: "   " }, NOW).tone).toBe("on");
    expect(integrationStatus({ configured: false, lastError: null }, NOW).tone).toBe("off");
  });
});
