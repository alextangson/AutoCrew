/** 创始人反馈（2026-09-29 下午）：稿件正文不进对话；同一篇一轮只出一张稿件卡 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversation, getConversation } from "../../storage/conversation-store.js";
import { makeHarness, type Harness } from "./fake-agent.test-helper.js";
import { CHIEF_EDITOR_PERSONA } from "./persona.js";
import { runLocalTurn, type LocalTurnInput } from "./turn.js";
import { TEST_BACKENDS } from "./fake-agent.test-helper.js";

// 与后端无关的边界对 Claude / Codex 各跑一遍（阶段 2）
describe.each(TEST_BACKENDS)("后端 %s", (B) => {
  let h: Harness;
  let status = "repair";
  beforeEach(async () => {
    h = await makeHarness({ mcpResult: () => ({ ok: true, content_id: "content-1-a", status }) });
    status = "repair";
  });
  afterEach(async () => { await h.cleanup(); });
  const input = (over: Partial<LocalTurnInput> = {}): LocalTurnInput => ({
    message: "写", backend: B, turnId: `t-${Math.random().toString(36).slice(2, 8)}`, clientId: "c1", dataDir: h.dataDir, ...over,
  });

  describe("反馈 1：稿件正文不贴进对话", () => {
    it("人设要求写完只回简短总结 + 在编辑器打开，绝不贴正文", () => {
      expect(CHIEF_EDITOR_PERSONA).toContain("绝不把稿件正文贴进回复");
      expect(CHIEF_EDITOR_PERSONA).toContain("在编辑器打开这篇");
    });
  });

  describe("反馈 2：同一篇一轮一张稿件卡", () => {
    it("交稿 ×3 + 审稿 ×2 → 只剩一张，显示最新状态", async () => {
      h.script = async (a) => {
        for (const s of ["repair", "awaiting_host_review", "awaiting_host_review"]) { status = s; await h.callTool(a, "autocrew_writer", { action: "submit", content_id: "content-1-a" }); }
        for (const s of ["accepted", "accepted"]) { status = s; await h.callTool(a, "autocrew_review_desk", { action: "submit", content_id: "content-1-a" }); }
        return { stopReason: "end_turn" };
      };
      const r = await runLocalTurn(h.svc, input());
      const drafts = (r.data as { cards: Array<{ type: string; data: { status?: string } }> }).cards.filter((c) => c.type === "agent_draft");
      expect(drafts).toHaveLength(1);
      expect(drafts[0].data.status).toBe("accepted");
    });
    it("编辑器里正开着这篇：不出稿件卡", async () => {
      h.script = async (a) => { await h.callTool(a, "autocrew_writer", { action: "submit", content_id: "content-1-a" }); return { stopReason: "end_turn" }; };
      const r = await runLocalTurn(h.svc, input({ openContentId: "content-1-a" }));
      expect((r.data as { cards: Array<{ type: string }> }).cards.filter((c) => c.type === "agent_draft")).toHaveLength(0);
    });
    it("迟到的结果同样去重：同一篇同一状态不再追加", async () => {
      const conv = await createConversation("x", h.dataDir, undefined, { backend: B });
      const binding = { token: "t", backend: B, dataDir: h.dataDir, conversationId: conv.id, turnId: "gone" };
      const card = { type: "agent_draft", callId: "c1", data: { contentId: "content-1-a", status: "accepted" } };
      await h.svc.recordCard(null, binding, card);
      await h.svc.recordCard(null, binding, { ...card, callId: "c2" });
      expect((await getConversation(conv.id, h.dataDir))!.messages.filter((m) => m.cards?.length)).toHaveLength(1);
    });
  });
});
