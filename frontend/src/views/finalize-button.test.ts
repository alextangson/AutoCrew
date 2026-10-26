/** 顶栏「定稿」按钮的纯逻辑（2026-10-26） */
import { describe, expect, it } from "vitest";
import { approvedLabel, finalizeView, withTopbarFinalize, type ScriptFinalState } from "./finalize-button";
import type { CardModel } from "./stage-card-model";

const base: ScriptFinalState = { status: "drafting", approved_at: null, writing: true, gaps: null };

describe("finalizeView", () => {
  it("没定过、还在写（AI 在写也一样）：给可点的按钮", () => {
    expect(finalizeView(base, false)).toEqual({ kind: "button", disabled: false });
  });
  it("薄路径有没核的出处 / 没清单 / 清单过期：照样能点，旁边一行提醒", () => {
    expect(finalizeView({ ...base, gaps: { kind: "unsourced", count: 3 } }, false)).toEqual({ kind: "button", disabled: false, reminder: "还有 3 处没核出处" });
    expect(finalizeView({ ...base, gaps: { kind: "none", count: 0 } }, false)).toMatchObject({ disabled: false, reminder: "还没出出处清单" });
    expect(finalizeView({ ...base, gaps: { kind: "stale", count: 0 } }, false)).toMatchObject({ disabled: false, reminder: expect.stringContaining("改稿前") });
    expect(finalizeView({ ...base, gaps: { kind: "unsourced", count: 0 } }, false)).toEqual({ kind: "button", disabled: false });
  });
  it("有没保存的改动：灰掉，写「先保存修改」", () => {
    expect(finalizeView(base, true)).toEqual({ kind: "button", disabled: true, why: "先保存修改" });
  });
  it("定过：变成「已定稿 · MM-DD HH:mm」", () => {
    const at = new Date(2026, 9, 26, 9, 5).toISOString();
    expect(finalizeView({ ...base, status: "approved", writing: false, approved_at: at }, false)).toEqual({ kind: "label", text: "已定稿 · 10-26 09:05" });
    expect(approvedLabel("坏的")).toBe("已定稿");
  });
  it("不是视频口播稿（data:null）或已过写稿段又没认稿：不出现", () => {
    expect(finalizeView(null, false)).toEqual({ kind: "hidden" });
    expect(finalizeView({ ...base, status: "editing", writing: false }, false)).toEqual({ kind: "hidden" });
  });
});

describe("withTopbarFinalize", () => {
  const model = (over: Partial<CardModel>): CardModel => ({ tone: "you", head: "现在轮到你", text: "", primary: null, more: [], notes: [], ...over });
  it("卡上的认稿主按钮让位", () => {
    const m = withTopbarFinalize(model({ primary: { label: "稿子没问题", run: { kind: "next", action: "approve_script" } } }), "draft_ready");
    expect(m.primary).toBeNull();
    const legacy = withTopbarFinalize(model({ primary: { label: "稿子没问题，进入制作", run: { kind: "transition", status: "approved" } } }), "reviewing");
    expect(legacy.primary).toBeNull();
  });
  it("认过的稿：「更多」里回到审稿那一项换成「撤回定稿」，要二次确认", () => {
    const m = withTopbarFinalize(model({ more: [{ key: "t:reviewing", label: "让 AI 再审一遍", run: { kind: "transition", status: "reviewing" } }] }), "approved");
    expect(m.more).toHaveLength(1);
    expect(m.more[0]).toMatchObject({ label: "撤回定稿", run: { kind: "transition", status: "reviewing" }, confirm: { danger: true } });
  });
  it("别的主按钮不动", () => {
    const pr = { label: "去看成片", run: { kind: "next" as const, action: "open_cut" as const } };
    expect(withTopbarFinalize(model({ primary: pr }), "editing").primary).toBe(pr);
  });
});
