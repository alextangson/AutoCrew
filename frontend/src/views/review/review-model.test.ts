/** 「等你拍板」行上直接点的主按钮：只给封面挑组和候选确认 */
import { describe, expect, it } from "vitest";
import { groupRows, quickAction, type InboxItem } from "./review-model";

const item = (over: Partial<InboxItem>): InboxItem => ({
  item_id: "x", gen: "g", type: "candidate", content_id: "c", title: "稿", summary: "s", waiting: null, agent_waiting: false, since: "2026-10-03T00:00:00.000Z", rank: 1, actions: [], detail: {}, ...over,
});

describe("quickAction", () => {
  it("封面挑组 → 用这组（带预填的封面字）；单个候选 → 对，就是它", () => {
    const cover = item({ type: "cover_pick", actions: [{ action: "pick_cover", label: "用这组", role: "primary", params: { group_id: "g1", cover_text: "字" } }] });
    expect(quickAction({ items: [cover] })).toMatchObject({ action: "pick_cover", params: { cover_text: "字" } });
    const cand = item({ actions: [{ action: "confirm_candidate", label: "对，就是它", role: "primary" }, { action: "reject_candidate", label: "不是", role: "secondary" }] });
    expect(quickAction({ items: [cand] })?.action).toBe("confirm_candidate");
  });
  it("成片、带一句话的动作、合成行、被拦的都不给", () => {
    const cut = item({ type: "cut_review", actions: [{ action: "approve_cut", label: "就用这版", role: "primary" }] });
    expect(quickAction({ items: [cut] })).toBeNull();
    const noted = item({ actions: [{ action: "confirm_candidate", label: "对", role: "primary", note: "required" }] });
    expect(quickAction({ items: [noted] })).toBeNull();
    const cand = item({ actions: [{ action: "confirm_candidate", label: "对", role: "primary" }] });
    expect(quickAction({ items: [cand, { ...cand, item_id: "y" }] })).toBeNull();
    expect(quickAction({ items: [{ ...cand, blocked_reason: "等" }] })).toBeNull();
  });
  it("稿子不再合成「N 篇稿子写好了」", () => {
    const d = (id: string) => item({ item_id: `draft:${id}`, type: "draft" });
    expect(groupRows([d("a"), d("b")])).toHaveLength(2);
  });
});
