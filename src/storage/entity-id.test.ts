import { describe, expect, it } from "vitest";
import { isCampaignId, isContentId, isPipelineId, isSafeFilename, isTopicId } from "./entity-id.js";

describe("filesystem entity id validation", () => {
  it("accepts generated and simple fixture ids", () => {
    expect(isContentId("content-1720000000000-a1b2c3")).toBe(true);
    expect(isContentId("content-nope")).toBe(true);
    expect(isContentId("legacy-one")).toBe(true);
    expect(isTopicId("topic-1")).toBe(true);
    expect(isPipelineId("pipeline-daily-1")).toBe(true);
    expect(isCampaignId("campaign-1720000000000-a1b2c3")).toBe(true);
  });

  it.each(["../../secret", "content/secret", "content\\secret", "content-../secret", "content_1", "content-"])(
    "rejects unsafe content id %s",
    (id) => expect(isContentId(id)).toBe(false),
  );

  it("rejects traversal in the other filesystem-backed ids", () => {
    expect(isTopicId("../topic-1")).toBe(false);
    expect(isPipelineId("pipeline-1/../../secret")).toBe(false);
    expect(isCampaignId("../campaign-1")).toBe(false);
  });

  it("allows only a single safe filename segment", () => {
    expect(isSafeFilename("cover-final.png")).toBe(true);
    expect(isSafeFilename("../cover.png")).toBe(false);
    expect(isSafeFilename("nested/cover.png")).toBe(false);
    expect(isSafeFilename("nested\\cover.png")).toBe(false);
  });
});
