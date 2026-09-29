/** Codex 评审 v1.1（2026-09-29）P1/P2 后端回归：每条先复现 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversation, getConversation } from "../../storage/conversation-store.js";
import { enqueueConversationWrite } from "../chat-persist.js";
import { makeHarness, until, type Harness } from "./fake-agent.test-helper.js";
import { agentAnswerHandler, agentSettingsHandler, conversationRenameHandler } from "./ipc-handlers.js";
import { runLocalTurn, type LocalTurnInput } from "./turn.js";
import { TEST_BACKENDS } from "./fake-agent.test-helper.js";

// 与后端无关的边界对 Claude / Codex 各跑一遍（阶段 2）
describe.each(TEST_BACKENDS)("后端 %s", (B) => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await h.cleanup(); });
  const input = (over: Partial<LocalTurnInput> = {}): LocalTurnInput => ({
    message: "go", backend: B, turnId: `t-${Math.random().toString(36).slice(2, 8)}`, clientId: "c1", dataDir: h.dataDir, ...over,
  });
  const perm = (a: { handlers: { requestPermission: (r: never) => Promise<string | null> } }) =>
    a.handlers.requestPermission({ title: "Bash echo", toolCallId: "tc", options: [{ optionId: "y", kind: "allow_once" }, { optionId: "n", kind: "reject_once" }] } as never);

  describe("P1-1 写 ACP session id 走串行队列、只补这一个字段", () => {
    it("排在它前面的改名与撤销全部放行都不会被覆盖回去", async () => {
      const conv = await createConversation("原名", h.dataDir, undefined, { backend: B });
      await agentSettingsHandler({ conversation_id: conv.id, permission_mode: "bypass", _dataDir: h.dataDir });
      let release!: () => void;
      const blocker = enqueueConversationWrite(conv.id, () => new Promise<void>((r) => { release = r; }));
      const running = runLocalTurn(h.svc, input({ conversationId: conv.id }));
      await until(() => h.agents.length === 1 && typeof release === "function");
      await new Promise((r) => setTimeout(r, 30));
      void conversationRenameHandler({ id: conv.id, title: "新名", _dataDir: h.dataDir });
      void agentSettingsHandler({ conversation_id: conv.id, permission_mode: "ask", _dataDir: h.dataDir });
      release();
      await blocker;
      await running;
      const meta = (await getConversation(conv.id, h.dataDir))!.meta;
      expect(meta.title).toBe("新名");
      expect(meta.agentSettings?.permissionMode).toBe("ask");
      expect(meta.acpSessionId).toMatch(/^sess-/);
    });
  });

  describe("P2-3 输入框的「本对话都允许」下一轮才生效", () => {
    it("轮次中途改档位，本轮权限卡照样弹；卡上的「始终允许」本轮立刻生效", async () => {
      const conv = await createConversation("x", h.dataDir, undefined, { backend: B });
      let first: Promise<string | null> | null = null;
      let second: string | null = null;
      h.script = async (a) => {
        await agentSettingsHandler({ conversation_id: conv.id, permission_mode: "conversation", _dataDir: h.dataDir });
        first = perm(a as never);
        await until(() => h.svc.asks.pending().length === 1);
        await agentAnswerHandler({ ask_id: h.svc.asks.pending()[0].id, decision: "allow_conversation" });
        await first;
        second = await perm(a as never);
        return { stopReason: "end_turn" };
      };
      await runLocalTurn(h.svc, input({ conversationId: conv.id }));
      expect(second).toBe("y");
      expect(h.svc.asks.pending()).toHaveLength(0);
    });
  });

  describe("P2-6 换模型后用适配器回的新强度清单", () => {
    it("新清单里才有的强度能设上，上报也换成新清单", async () => {
      const orig = h.svc.deps.spawnAgent;
      h.svc.deps.spawnAgent = (l, c, hd) => {
        const a = orig(l, c, hd) as unknown as { afterSet: (id: string, v: string) => unknown; configOptions: unknown };
        a.afterSet = (id) => id === "model" ? [
          { id: "model", current: "sonnet", values: [{ value: "default", label: "Default" }, { value: "sonnet", label: "Sonnet" }] },
          { id: "effort", current: "default", values: [{ value: "default", label: "Default" }, { value: "xhigh", label: "XHigh" }] },
        ] : null;
        return a as never;
      };
      const r = await runLocalTurn(h.svc, input({ newSettings: { model: "sonnet", effort: "xhigh" } }));
      expect(r.ok).toBe(true);
      expect(h.agents[0].configSet).toEqual([["model", "sonnet"], ["effort", "xhigh"]]);
      expect(h.svc.reported.get(B)?.efforts.map((e) => e.value)).toEqual(["default", "xhigh"]);
    });
  });
});
