import { describe, expect, it } from "vitest";
import { controlState, settingsFromServer, settingsPayload } from "./conv-settings";

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
