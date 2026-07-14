import { describe, expect, it } from "vitest";
import { compareVersions, isGenericVersionNote } from "./version-diff";

describe("compareVersions", () => {
  it("summarizes added and removed paragraphs", () => {
    const diff = compareVersions(
      { version: 1, body: "第一段\n\n旧段落", savedAt: "2026-01-01" },
      { version: 2, body: "第一段\n\n新段落\n\n结尾", savedAt: "2026-01-02" },
    );
    expect(diff.added).toEqual(["新段落", "结尾"]);
    expect(diff.removed).toEqual(["旧段落"]);
    expect(diff.summary).toBe("新增 2 段 · 删除 1 段");
  });

  it("labels an empty first version as a generation placeholder", () => {
    const diff = compareVersions(undefined, { version: 1, body: "", savedAt: "2026-01-01" });
    expect(diff.summary).toContain("生成占位");
  });

  it("recognizes legacy generic notes", () => {
    expect(isGenericVersionNote("第 2 版")).toBe(true);
    expect(isGenericVersionNote("AI 修改：开头更直接")).toBe(false);
  });
});
