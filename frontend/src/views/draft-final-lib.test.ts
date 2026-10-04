import { describe, expect, it } from "vitest";
import { finalizeBlock, type DraftPanelData } from "./draft-final-lib";

const base = (over: Partial<DraftPanelData> = {}): DraftPanelData => ({
  status: "draft_ready", draft_hash: "h", review: { status: "none" },
  checklist: { draft_hash: "h", current: true, items: [{ id: "a", status: "sourced", text: "x", evidence_ids: ["ev-d1"] }, { id: "b", status: "unsourced", text: "y", evidence_ids: [] }] },
  finalized: null, ...over,
});

describe("「定了」按钮", () => {
  it("没出处的项都保留了才能点", () => {
    expect(finalizeBlock(base(), new Set(), false)).toContain("1 处没出处");
    expect(finalizeBlock(base(), new Set(["b"]), false)).toBeNull();
  });
  it("清单过期、没清单、没保存都写原因", () => {
    expect(finalizeBlock(base({ checklist: { draft_hash: "old", current: false, items: [] } }), new Set(), false)).toContain("重新出清单");
    expect(finalizeBlock(base({ checklist: null }), new Set(), false)).toContain("还没有定稿清单");
    expect(finalizeBlock(base(), new Set(["b"]), true)).toContain("先保存");
  });
});
