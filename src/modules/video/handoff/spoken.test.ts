import { describe, expect, it } from "vitest";
import { parseSrt, spokenFromSrt, unverifiedAdditions } from "./spoken.js";

describe("实拍版口播", () => {
  it("去序号时间轴、中文直接拼、西文补空格、停顿 ≥ 1.5 秒换段；认 BOM 与 CRLF", () => {
    const srt = "﻿1\r\n00:00:00,000 --> 00:00:01,000\r\n你好\r\n\r\n2\r\n00:00:01,200 --> 00:00:02,000\r\nhello\r\nworld\r\n\r\n3\r\n00:00:03,500 --> 00:00:04,000\r\n<i>新段</i>\r\n";
    expect(spokenFromSrt(srt)).toBe("你好hello world\n\n新段\n");
  });

  it("时间轴坏了、结束早于开始、没有文字 → 抛人话错误", () => {
    expect(() => parseSrt("1\n00:00\n你好")).toThrow(/时间轴/);
    expect(() => parseSrt("1\n00:00:02,000 --> 00:00:01,000\n你好")).toThrow(/结束早于开始/);
    expect(() => parseSrt("1\n00:00:00,000 --> 00:00:01,000\n")).toThrow(/没有任何带文字/);
    expect(() => parseSrt("")).toThrow();
  });

  it("只列定稿里没有的数字与出处", () => {
    const out = unverifiedAdditions("用了 3 年，增长 20%。", "用了 3 年，增长 20%，据说能到三千万。有 2026 年的报告");
    expect(out.some((l) => l.includes("三千万"))).toBe(true);
    expect(out.some((l) => l.includes("「2026」"))).toBe(true);
    expect(out.some((l) => l.includes("出处「据说能到三千万」"))).toBe(true);
    expect(out.some((l) => l.includes("「3」") || l.includes("20%」"))).toBe(false);
    expect(unverifiedAdditions("一样的话", "一样的话")).toEqual([]);
  });
});
