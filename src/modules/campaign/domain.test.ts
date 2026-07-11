import { describe, expect, it } from "vitest";
import { allowedCampaignTransitions, canTransitionCampaign, isPromotionChannel } from "./domain.js";

describe("campaign lifecycle", () => {
  it("allows only explicit durable state transitions", () => {
    expect(allowedCampaignTransitions("draft")).toEqual(["planning", "archived"]);
    expect(canTransitionCampaign("ready", "active")).toBe(true);
    expect(canTransitionCampaign("draft", "active")).toBe(false);
    expect(allowedCampaignTransitions("archived")).toEqual([]);
  });

  it("uses an explicit channel allowlist", () => {
    expect(isPromotionChannel("xiaohongshu")).toBe(true);
    expect(isPromotionChannel("paid_ads")).toBe(true);
    expect(isPromotionChannel("../../shell")).toBe(false);
  });
});
