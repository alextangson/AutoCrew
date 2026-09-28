import { describe, expect, it } from "vitest";
import { applyAgentEvent, parsePending, type AskView } from "./agent-asks";

const ask = (over: Partial<AskView> = {}): AskView => ({
  id: "ask-1", kind: "approval", turnId: "t", conversationId: "conv-1-a", status: "pending", expiresAt: "", title: "批准「推送到公众号草稿箱」？", detail: "《标题》", ...over,
});

describe("待处理卡（边界 5 / 7，§地基 9）", () => {
  it("刷新后从 agent:pending 重放卡片与进行中的轮次", () => {
    const p = parsePending({ ok: true, data: { asks: [ask(), { junk: 1 }], running: { turnId: "t", conversationId: "conv-1-a", status: "awaiting_approval" } } });
    expect(p.asks).toHaveLength(1);
    expect(p.running).toEqual({ turnId: "t", conversationId: "conv-1-a", status: "awaiting_approval" });
  });

  it("SSE 事件：重复不重复加，落定（含别的标签页应答、超时）即移除，别的对话的卡不进来", () => {
    let list: AskView[] = [];
    list = applyAgentEvent(list, { type: "ask", ask: ask() }, "conv-1-a");
    list = applyAgentEvent(list, { type: "ask", ask: ask() }, "conv-1-a");
    expect(list).toHaveLength(1);
    list = applyAgentEvent(list, { type: "ask", ask: ask({ id: "ask-2", conversationId: "conv-2-b" }) }, "conv-1-a");
    expect(list).toHaveLength(1);
    list = applyAgentEvent(list, { type: "ask_resolved", ask: ask({ status: "expired" }) }, "conv-1-a");
    expect(list).toHaveLength(0);
  });
});
