import { describe, expect, it } from "vitest";
import { parseChatTurnResponse } from "./response";

describe("parseChatTurnResponse", () => {
  it("reads the nested chat contract and keeps the camelCase conversation id", () => {
    expect(parseChatTurnResponse({
      ok: true,
      data: {
        reply: "稿件已经开始写了",
        cards: [{ type: "draft", data: { title: "测试" } }],
        conversationId: "conv-1-abc",
      },
    })).toEqual({
      reply: "稿件已经开始写了",
      cards: [{ type: "draft", data: { title: "测试" } }],
      conversationId: "conv-1-abc",
    });
  });

  it("never produces an empty assistant bubble", () => {
    expect(parseChatTurnResponse({ ok: true, data: { reply: "", cards: [] } }).reply)
      .toContain("没有返回可显示的说明");
  });

  it("accepts the legacy top-level response while old clients are still around", () => {
    expect(parseChatTurnResponse({ ok: true, reply: "旧响应", conversation_id: "conv-2-old" }))
      .toMatchObject({ reply: "旧响应", conversationId: "conv-2-old" });
  });
});
