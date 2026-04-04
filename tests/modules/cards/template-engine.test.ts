import { describe, it, expect } from "vitest";
import { renderCard } from "../../../src/modules/cards/template-engine.js";

describe("renderCard", () => {
  describe("comparison-table", () => {
    it("renders with title, table, and row data", () => {
      const html = renderCard("comparison-table", {
        title: "Framework Comparison",
        rows: [
          { name: "React", pros: "Ecosystem", cons: "Complexity" },
          { name: "Vue", pros: "Simplicity", cons: "Smaller community" },
        ],
      });

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Framework Comparison");
      expect(html).toContain("<table>");
      expect(html).toContain("React");
      expect(html).toContain("Ecosystem");
      expect(html).toContain("Complexity");
      expect(html).toContain("Vue");
    });
  });

  describe("key-points", () => {
    it("renders with numbered items", () => {
      const html = renderCard("key-points", {
        items: ["First point", "Second point", "Third point"],
      });

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("First point");
      expect(html).toContain("Second point");
      expect(html).toContain("Third point");
      // Numbered circle markers
      expect(html).toContain(">1<");
      expect(html).toContain(">2<");
      expect(html).toContain(">3<");
    });
  });

  describe("flow-chart", () => {
    it("renders with steps and arrows", () => {
      const html = renderCard("flow-chart", {
        steps: ["Research", "Draft", "Review", "Publish"],
      });

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Research");
      expect(html).toContain("Draft");
      expect(html).toContain("Review");
      expect(html).toContain("Publish");
      // Should have arrows between steps (3 arrows for 4 steps)
      expect(html).toContain("\u2192");
    });
  });

  describe("data-chart", () => {
    it("renders with title and bar values", () => {
      const html = renderCard("data-chart", {
        title: "Monthly Revenue",
        items: [
          { label: "Jan", value: 100 },
          { label: "Feb", value: 200 },
          { label: "Mar", value: 150 },
        ],
      });

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("Monthly Revenue");
      expect(html).toContain("Jan");
      expect(html).toContain("Feb");
      expect(html).toContain("Mar");
      // Bar with max value should be 100%
      expect(html).toContain('width: 100%');
      // Bar with 100/200 = 50%
      expect(html).toContain('width: 50%');
    });
  });

  describe("aspect ratio", () => {
    it("defaults to 9:16 (1080x1920)", () => {
      const html = renderCard("key-points", { items: ["A"] });

      expect(html).toContain("width: 1080px");
      expect(html).toContain("height: 1920px");
    });

    it("uses 16:9 dimensions (1920x1080)", () => {
      const html = renderCard("key-points", { items: ["A"] }, { aspectRatio: "16:9" });

      expect(html).toContain("width: 1920px");
      expect(html).toContain("height: 1080px");
    });

    it("uses 1:1 dimensions (1080x1080)", () => {
      const html = renderCard("key-points", { items: ["A"] }, { aspectRatio: "1:1" });

      expect(html).toContain("width: 1080px");
      expect(html).toContain("height: 1080px");
    });
  });

  describe("error handling", () => {
    it("throws on unknown template", () => {
      expect(() =>
        renderCard("nonexistent" as never, {})
      ).toThrow("Unknown card template");
    });
  });
});
