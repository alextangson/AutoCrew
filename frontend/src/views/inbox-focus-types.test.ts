/** Codex 审 fix/board-trash-direct-open：从稿件页去「等你拍板」要带上事项类型；进度区存盘后要换新代次 */
import { describe, expect, it } from "vitest";
import { inboxHref } from "./review/review-api";
import { focusPick } from "./review/inbox-focus";
import { progressKey } from "./card-next";

const items = [
  { item_id: "cand:1", content_id: "c1", type: "candidate" },
  { item_id: "cut:1", content_id: "c1", type: "cut_review" },
  { item_id: "cut:2", content_id: "c2", type: "cut_review" },
];

describe("focusPick", () => {
  it("带类型时打开这条稿的那类事项，不是第一件", () => {
    expect(focusPick(items, "c1", ["cut_review", "sliver"])?.item_id).toBe("cut:1");
    expect(focusPick(items, "c1")?.item_id).toBe("cand:1");
    expect(focusPick(items, "c1", ["cover_pick"])).toBeUndefined();
  });
  it("inboxHref 把类型带进链接", () => {
    expect(inboxHref("c1", ["cut_review", "sliver"])).toBe("#/board?inbox=c1&types=cut_review%2Csliver");
    expect(inboxHref("c1")).toBe("#/board?inbox=c1");
  });
});

describe("progressKey", () => {
  it("存盘（updatedAt 变了）就换 key，让进度区重读拿新代次", () => {
    expect(progressKey("draft_ready", "2026-10-04T10:00:00Z")).not.toBe(progressKey("draft_ready", "2026-10-04T10:05:00Z"));
    expect(progressKey("draft_ready", "t")).not.toBe(progressKey("approved", "t"));
  });
});
