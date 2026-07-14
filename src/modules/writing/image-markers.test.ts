import { describe, it, expect } from "vitest";
import { addImageMarker, removeImageMarker, countImageMarkers } from "./image-markers.js";

describe("image markers", () => {
  it("addImageMarker appends one slot", () => {
    const out = addImageMarker("第一段。", "一只猫");
    expect(countImageMarkers(out)).toBe(1);
    expect(out).toContain("[IMAGE: 一只猫]");
    expect(out).toMatch(/^第一段。/);
  });

  it("removeImageMarker drops the Nth slot and keeps the rest", () => {
    const body = "A\n\n[IMAGE: 图1]\n\nB\n\n[IMAGE: 图2]\n\nC";
    expect(countImageMarkers(body)).toBe(2);
    const out = removeImageMarker(body, 0);
    expect(countImageMarkers(out)).toBe(1);
    expect(out).toContain("[IMAGE: 图2]");
    expect(out).not.toContain("[IMAGE: 图1]");
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out).toContain("C");
  });

  it("removeImageMarker out of range returns unchanged", () => {
    const body = "A\n\n[IMAGE: 图1]";
    expect(removeImageMarker(body, 5)).toBe(body);
  });
});
