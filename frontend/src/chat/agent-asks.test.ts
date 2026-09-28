import { describe, expect, it } from "vitest";
import { applyAgentEvent, mergeCards, parsePending, type AskView } from "./agent-asks";

const ask = (over: Partial<AskView> = {}): AskView => ({
  id: "ask-1", kind: "approval", turnId: "t", conversationId: "conv-1-a", status: "pending", expiresAt: "", title: "批准「推送到公众号草稿箱」？", detail: "《标题》", ...over,
});

describe("待处理卡（边界 5 / 7，§地基 9）", () => {
  it("刷新后从 agent:pending 重放卡片与进行中的轮次", () => {
    const p = parsePending({ ok: true, data: { asks: [ask(), { junk: 1 }], running: { turnId: "t", conversationId: "conv-1-a", status: "awaiting_approval" } } });
    expect(p.asks).toHaveLength(1);
    expect(p.running).toMatchObject({ turnId: "t", conversationId: "conv-1-a", status: "awaiting_approval", owner: false });
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

describe("评审 P2-13 / P2-14：本轮卡片与发起方", () => {
  it("快照与 SSE 卡片按 callId 合并不重复", () => {
    const snap = parsePending({ data: { running: { turnId: "t", conversationId: "c", owner: true, cards: [{ type: "agent_text", callId: "a", data: {} }] } } });
    expect(snap.running?.owner).toBe(true);
    const merged = mergeCards(snap.running!.cards, [{ type: "agent_text", callId: "a", data: {} }, { type: "agent_draft", callId: "b", data: { contentId: "x" } }, { junk: 1 }]);
    expect(merged.map((c) => c.callId)).toEqual(["a", "b"]);
  });
  it("没带 owner 的快照按旁观处理（不是自己的轮不接管）", () => {
    expect(parsePending({ data: { running: { turnId: "t", conversationId: "c" } } }).running?.owner).toBe(false);
  });
});
