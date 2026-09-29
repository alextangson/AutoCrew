import { describe, expect, it } from "vitest";
import { choiceLabel, changedSinceSend, controlState, DEFAULT_SETTINGS, enteringNewConversation, settingsFromServer, settingsPayload, snapshotFromSave } from "./conv-settings";

describe("对话级设置（v1.1）", () => {
  it("U2：适配器没上报 → 只有「默认」且不可点", () => {
    expect(controlState("claude", [])).toEqual({ hidden: false, disabled: true, items: [{ value: "default", label: "默认" }] });
  });
  it("U13：内置引擎的强度 / 权限控件隐藏", () => {
    expect(controlState("builtin", [{ value: "high", label: "High" }]).hidden).toBe(true);
  });
  it("上报了清单就用它，没有 default 时补一个「默认」", () => {
    expect(controlState("claude", [{ value: "high", label: "High" }]).items.map((c) => c.value)).toEqual(["default", "high"]);
  });
  it("U5：「本对话都允许」来自服务端内存态；全部放行来自落盘设置", () => {
    expect(settingsFromServer({}, true).permissionMode).toBe("conversation");
    expect(settingsFromServer({ permissionMode: "bypass" }, false).permissionMode).toBe("bypass");
    expect(settingsFromServer(undefined, false)).toEqual({ model: "default", effort: "default", permissionMode: "ask" });
    expect(settingsPayload({ model: "sonnet", effort: "high", permissionMode: "conversation" })).toEqual({ model: "sonnet", effort: "high", permission_mode: "conversation" });
  });
});

describe("评审 v1.1 前端回归", () => {
  it("P1-2：从有对话切到没有对话（任何入口）就重置设置；新对话首轮拿到 id 不重置", () => {
    expect(enteringNewConversation("conv-1-a", undefined)).toBe(true);
    expect(enteringNewConversation(undefined, "conv-1-a")).toBe(false);
    expect(enteringNewConversation(undefined, undefined)).toBe(false);
  });
  it("P2-4：保存后用回执刷新快照，之后重建不会退回旧值", () => {
    const snap = snapshotFromSave({ ok: true, data: { settings: { permissionMode: "bypass" }, conversationAllow: false } });
    expect(settingsFromServer(snap!.meta, snap!.conversationAllow).permissionMode).toBe("bypass");
    expect(snapshotFromSave({ ok: false })).toBeNull();
  });
  it("P2-5：首轮进行中改过设置，拿到 id 后要补存", () => {
    expect(changedSinceSend(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, permissionMode: "conversation" })).toBe(true);
    expect(changedSinceSend(DEFAULT_SETTINGS, DEFAULT_SETTINGS)).toBe(false);
    expect(changedSinceSend(null, DEFAULT_SETTINGS)).toBe(false);
  });
});

describe("bug C 窄右栏", () => {
  it("默认档触发器只写「默认」，不带适配器的长名", () => {
    expect(choiceLabel([{ value: "default", label: "Default (recommended)" }], "default")).toBe("默认");
    expect(choiceLabel([{ value: "sonnet", label: "Sonnet 5" }], "sonnet")).toBe("Sonnet 5");
  });
});
