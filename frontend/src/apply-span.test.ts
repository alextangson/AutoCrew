import { describe, it, expect } from "vitest";
import { applySpan } from "./apply-span";

describe("applySpan", () => {
  const body = "第一段。第二段。第三段。";
  it("replaces a middle span", () => {
    expect(applySpan(body, 4, 8, "新的第二段。")).toBe("第一段。新的第二段。第三段。");
  });
  it("replaces the first span", () => {
    expect(applySpan(body, 0, 4, "开头。")).toBe("开头。第二段。第三段。");
  });
  it("replaces the last span", () => {
    expect(applySpan(body, 8, 12, "结尾。")).toBe("第一段。第二段。结尾。");
  });
  it("start === end inserts", () => {
    expect(applySpan(body, 4, 4, "[插入]")).toBe("第一段。[插入]第二段。第三段。");
  });
});
