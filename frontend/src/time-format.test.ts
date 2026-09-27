import { describe, expect, it } from "vitest";
import { clockLabel, dateLabel, durationText, relativeLabel } from "./time-format";

// 用本地时间构造，测试与机器时区无关
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);
const now = local(2026, 9, 27, 18, 0).getTime();

describe("clockLabel", () => {
  it("今天 / 昨天 / 几月几日，按本地时区", () => {
    expect(clockLabel(local(2026, 9, 27, 17, 50).toISOString(), now)).toBe("今天 17:50");
    expect(clockLabel(local(2026, 9, 26, 9, 5).toISOString(), now)).toBe("昨天 09:05");
    expect(clockLabel(local(2026, 9, 20, 16, 46).toISOString(), now)).toBe("9月20日 16:46");
    expect(clockLabel(local(2025, 12, 31, 23, 0).toISOString(), now)).toBe("2025年12月31日 23:00");
  });
  it("UTC 字符串不再原样截取", () => {
    const iso = "2026-09-27T09:50:00Z";
    const d = new Date(iso);
    expect(clockLabel(iso, now)).toContain(`${String(d.getHours()).padStart(2, "0")}:50`);
  });
  it("空值、坏值显示 —", () => {
    expect(clockLabel(undefined, now)).toBe("—");
    expect(clockLabel("不是时间", now)).toBe("—");
    expect(dateLabel(null, now)).toBe("—");
  });
});

describe("relativeLabel", () => {
  it("刚刚 / N 分钟前 / N 小时前，更早落回日期", () => {
    expect(relativeLabel(new Date(now - 20_000).toISOString(), now)).toBe("刚刚");
    expect(relativeLabel(new Date(now + 60_000).toISOString(), now)).toBe("刚刚");
    expect(relativeLabel(new Date(now - 3 * 60_000).toISOString(), now)).toBe("3 分钟前");
    expect(relativeLabel(new Date(now - 2 * 3600_000 - 5).toISOString(), now)).toBe("2 小时前");
    expect(relativeLabel(local(2026, 9, 20, 16, 46).toISOString(), now)).toBe("9月20日 16:46");
  });
});

describe("durationText", () => {
  it("秒 / 分秒 / 时分", () => {
    expect(durationText(20_000)).toBe("20 秒");
    expect(durationText(523_000)).toBe("8 分 43 秒");
    expect(durationText(480_000)).toBe("8 分");
    expect(durationText(3_720_000)).toBe("1 小时 2 分");
    expect(durationText(3_600_400)).toBe("1 小时");
    expect(durationText(0)).toBe("0 秒");
  });
  it("读不出就明说", () => {
    expect(durationText(null)).toBe("时长读不出");
    expect(durationText(NaN)).toBe("时长读不出");
  });
});
