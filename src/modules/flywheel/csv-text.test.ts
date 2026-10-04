import { describe, it, expect } from "vitest";
import { rowsToCsvText } from "./csv-text.js";
import { parseCsv } from "./csv-import.js";

// ─── rowsToCsvText ────────────────────────────────────────────────────────────

describe("rowsToCsvText", () => {
  it("produces header + one data row", () => {
    const csv = rowsToCsvText([{ a: "1", b: "2" }]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe("1,2");
  });

  it("quotes fields that contain commas", () => {
    const csv = rowsToCsvText([{ x: "hello,world" }]);
    expect(csv).toContain('"hello,world"');
  });

  it("quotes fields that contain double-quotes (escaped as \"\")", () => {
    const csv = rowsToCsvText([{ x: 'say "hi"' }]);
    expect(csv).toContain('"say ""hi"""');
  });

  it("sanitizes newlines to single space (parseCsv 不支持换行内嵌字段)", () => {
    const csv = rowsToCsvText([{ x: "line1\nline2" }]);
    expect(csv).toContain("line1 line2");
    expect(csv).not.toContain("line1\nline2");
  });

  it("returns empty string for empty rows array", () => {
    expect(rowsToCsvText([])).toBe("");
  });

  // ─── round-trip property: rowsToCsvText ↔ parseCsv ───────────────────────

  it("round-trips plain values through parseCsv", () => {
    const rows = [{ 标题: "测试视频", 播放量: "12345", 完播率: "0.35" }];
    const csv = rowsToCsvText(rows);
    const back = parseCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ 标题: "测试视频", 播放量: "12345", 完播率: "0.35" });
  });

  it("round-trips values with commas and quotes", () => {
    const rows = [{ a: 'say "hi", ok', b: "normal,value", c: 'with ""quotes""' }];
    const csv = rowsToCsvText(rows);
    const back = parseCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0]["a"]).toBe('say "hi", ok');
    expect(back[0]["b"]).toBe("normal,value");
    expect(back[0]["c"]).toBe('with ""quotes""');
  });

  it("row with embedded \\n and \\r\\n survives parseCsv intact — no row tearing", () => {
    // DOM innerText 会带换行；不清洗的话首列撕裂 → 误导性 rejected（指向选择器校准），
    // 非首列撕裂 → 表头错位静默腐蚀 journal
    const rows = [
      {
        作品名称: "标题第一行\n标题第二行",
        播放量: "12345",
        完播率: "0.35\r\n后缀",
        点赞量: "500",
      },
    ];
    const back = parseCsv(rowsToCsvText(rows));
    expect(back).toHaveLength(1); // 行没有被撕裂
    expect(back[0]["作品名称"]).toBe("标题第一行 标题第二行");
    expect(back[0]["播放量"]).toBe("12345");
    expect(back[0]["完播率"]).toBe("0.35 后缀");
    expect(back[0]["点赞量"]).toBe("500"); // 所有指标列对齐无错位
  });

  it("sanitizes bare \\r too (转义检查只看 \\n 会漏)", () => {
    const back = parseCsv(rowsToCsvText([{ a: "left\rright", b: "ok" }]));
    expect(back).toHaveLength(1);
    expect(back[0]["a"]).toBe("left right");
    expect(back[0]["b"]).toBe("ok");
  });

  it("round-trips Chinese header names and emoji values", () => {
    const rows = [{ 作品名称: "测试🔥", 播放量: "1万" }];
    const csv = rowsToCsvText(rows);
    const back = parseCsv(csv);
    expect(back[0]["作品名称"]).toBe("测试🔥");
    expect(back[0]["播放量"]).toBe("1万");
  });
});
