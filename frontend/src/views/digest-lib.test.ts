import { describe, it, expect } from "vitest";
import { digestHourLabel, digestStateLine, digestTone, DIGEST_HOURS, type DigestView } from "./digest-lib";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function view(over: Partial<DigestView> = {}): DigestView {
  return {
    enabled: true,
    hour: 9,
    nextAt: null,
    lastSentAt: null,
    lastError: null,
    lastErrorAt: null,
    attemptsToday: 0,
    ...over,
  };
}

describe("digest-lib · 卡上那一行（摘要 spec §2.5）", () => {
  it("小时下拉是 0–23，两位数补零", () => {
    expect(DIGEST_HOURS).toHaveLength(24);
    expect(digestHourLabel(9)).toBe("09:00");
    expect(digestHourLabel(21)).toBe("21:00");
  });

  it("没配 bot → 先配 bot（这一段整体灰显）", () => {
    expect(digestStateLine({ digest: view(), configured: false, now: NOW })).toContain("先配 bot");
    expect(digestTone({ digest: view(), configured: false, now: NOW })).toBe("off");
  });

  it("状态读不到时照实说，不假装正常", () => {
    expect(digestStateLine({ configured: true, now: NOW })).toContain("读不到");
  });

  it("关掉时说清打开后会怎样", () => {
    expect(digestStateLine({ digest: view({ enabled: false, hour: 21 }), configured: true, now: NOW })).toBe(
      "已关闭——打开后每天 21:00 发一份到你的 Telegram",
    );
  });

  it("有失败：原因 + 相对时间 + 今天试了几次，tone=bad", () => {
    const d = view({ lastError: "网络不通", lastErrorAt: minutesAgo(5), attemptsToday: 2 });
    const line = digestStateLine({ digest: d, configured: true, now: NOW });
    expect(line).toBe("上次失败：网络不通（5 分钟前）　今天已试 2/3 次");
    expect(digestTone({ digest: d, configured: true, now: NOW })).toBe("bad");
  });

  it("失败没有时间戳就只报原因（不拿别的字段冒充）", () => {
    expect(digestStateLine({ digest: view({ lastError: "网络不通" }), configured: true, now: NOW })).toBe(
      "上次失败：网络不通",
    );
  });

  it("发过就报上次发送时间；没发过说「还没发过」", () => {
    expect(digestStateLine({ digest: view({ lastSentAt: minutesAgo(180) }), configured: true, now: NOW })).toBe(
      "上次发送 3 小时前　每天 09:00",
    );
    expect(digestStateLine({ digest: view(), configured: true, now: NOW })).toBe("还没发过——每天 09:00 到点自动发");
  });
});
