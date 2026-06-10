import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCsv, parseMetricNumber } from "./csv-import.js";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const rows = parseCsv("标题,播放量\n护肤技巧,1234\n汽车保养,5678");
    expect(rows).toHaveLength(2);
    expect(rows[0]["标题"]).toBe("护肤技巧");
    expect(rows[1]["播放量"]).toBe("5678");
  });

  it("strips UTF-8 BOM and handles CRLF", () => {
    const rows = parseCsv("﻿标题,播放量\r\n护肤技巧,1234\r\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]["标题"]).toBe("护肤技巧");
  });

  it("handles quoted fields containing commas", () => {
    const rows = parseCsv('标题,播放量\n"护肤，进阶版",1234');
    expect(rows[0]["标题"]).toBe("护肤，进阶版");
  });

  it("handles escaped quotes inside quoted fields", () => {
    const rows = parseCsv('标题,播放量\n"他说""真香""",99');
    expect(rows[0]["标题"]).toBe('他说"真香"');
  });

  it("skips blank lines", () => {
    const rows = parseCsv("标题,播放量\n护肤,1\n\n汽车,2\n");
    expect(rows).toHaveLength(2);
  });
});

describe("parseMetricNumber", () => {
  it("parses plain numbers and comma separators", () => {
    expect(parseMetricNumber("1234")).toBe(1234);
    expect(parseMetricNumber("1,234")).toBe(1234);
  });
  it("parses 万 and w suffix", () => {
    expect(parseMetricNumber("1.2万")).toBe(12000);
    expect(parseMetricNumber("3.4w")).toBe(34000);
  });
  it("parses percentage as plain number (completionRate semantics)", () => {
    expect(parseMetricNumber("12.3%")).toBe(12.3);
  });
  it("returns undefined for empty or non-numeric", () => {
    expect(parseMetricNumber("")).toBeUndefined();
    expect(parseMetricNumber("-")).toBeUndefined();
    expect(parseMetricNumber(undefined)).toBeUndefined();
  });
});
