import { describe, expect, it } from "vitest";
import { workbuddyPrompt } from "./workbuddy";

describe("复制给 WorkBuddy", () => {
  it("措辞与服务端一致（创始人认过）", () => {
    expect(workbuddyPrompt("FDE 会消失", "content-1-a")).toBe("通过 autocrew MCP 调用 autocrew_content get 读取《FDE 会消失》（id: content-1-a），总结这篇现在在哪一步、卡在哪，然后等我指示，先不要改任何东西。");
  });
});
