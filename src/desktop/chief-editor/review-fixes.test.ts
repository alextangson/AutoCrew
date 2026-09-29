/** Codex 评审（2026-09-28）P1/P2 的回归用例：每条先复现问题，再锁住修法 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversation, getConversation } from "../../storage/conversation-store.js";
import { abortTurn } from "../turn-registry.js";
import * as store from "../../storage/conversation-store.js";
import { makeHarness, until, type Harness } from "./fake-agent.test-helper.js";
import { agentContextBlock } from "./ipc-handlers.js";
import { classifyPublishAction } from "./publish-gate.js";
import { StreamRedactor } from "./redact.js";
import { killRecordedGroup, type ProcRow } from "./run-store.js";
import { runLocalTurn, type LocalTurnInput } from "./turn.js";
import { TEST_BACKENDS } from "./fake-agent.test-helper.js";

// 与后端无关的边界对 Claude / Codex 各跑一遍（阶段 2）
describe.each(TEST_BACKENDS)("后端 %s", (B) => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await h.cleanup(); });
  const input = (over: Partial<LocalTurnInput> = {}): LocalTurnInput => ({
    message: "go", backend: B, turnId: `t-${Math.random().toString(36).slice(2, 8)}`, clientId: "c1", dataDir: h.dataDir, ...over,
  });
  const toolNames = () => h.mcpCalls.map((c) => (c.request.params as { name: string; arguments: Record<string, unknown> }));

  describe("P1-1 所有推到「已发布」的状态入口都要审批", () => {
    it.each([
      [{ action: "update", id: "content-1-a", status: "published" }],
      [{ action: "save", status: "published" }],
      [{ action: "transition", id: "content-1-a", target_status: "published" }],
    ])("autocrew_content %o 被拦", (args) => {
      expect(classifyPublishAction("autocrew_content", args)).toMatchObject({ label: "转入已发布" });
    });
    it("update 带 status=published 经桥不执行，回 approval_required", async () => {
      let reply: Record<string, unknown> = {};
      h.script = async (a) => { reply = await h.callTool(a, "autocrew_content", { action: "update", id: "content-1-a", status: "published" }); abortTurn(h.svc.active!.turnId, "c1"); return a.untilCancelled(); };
      await runLocalTurn(h.svc, input());
      expect(reply.code).toBe("approval_required");
      expect(h.mcpCalls).toHaveLength(0);
    });
  });

  describe("P1-2 目标别名不一致直接拒", () => {
    it("delete {content_id:A, id:B} 不给审批、不执行", async () => {
      expect(classifyPublishAction("autocrew_content", { action: "delete", content_id: "content-1-a", id: "content-2-b" })).toHaveProperty("refuse");
      let reply: Record<string, unknown> = {};
      h.script = async (a) => { reply = await h.callTool(a, "autocrew_content", { action: "delete", content_id: "content-1-a", id: "content-2-b" }); return { stopReason: "end_turn" }; };
      await runLocalTurn(h.svc, input());
      expect(reply.code).toBe("refused");
      expect(h.svc.asks.pending()).toHaveLength(0);
      expect(h.mcpCalls).toHaveLength(0);
    });
    it("执行器认哪个别名，审批就绑哪个", () => {
      expect(classifyPublishAction("autocrew_content", { action: "delete", id: "content-2-b" })).toMatchObject({ targetId: "content-2-b" });
      expect(classifyPublishAction("autocrew_publish", { action: "wechat_mp_draft", content_id: "content-1-a" })).toMatchObject({ targetId: "content-1-a" });
    });
  });

  describe("P1-3 已批未用的 approval_id 不能带进下一轮", () => {
    it("第一轮批了没用就停，第二轮拿同一个 id 重调 → 重新要审批", async () => {
      let approvalId = "";
      h.script = async (a) => {
        await h.callTool(a, "autocrew_content", { action: "delete", id: "content-1-a" });
        approvalId = h.svc.asks.pending()[0].id;
        h.svc.asks.answer(approvalId, "allow");
        abortTurn(h.svc.active!.turnId, "c1");
        return a.untilCancelled();
      };
      const first = await runLocalTurn(h.svc, input());
      const conversationId = (first.data as { conversationId: string }).conversationId;
      let reply: Record<string, unknown> = {};
      h.script = async (a) => { reply = await h.callTool(a, "autocrew_content", { action: "delete", id: "content-1-a", approval_id: approvalId }); abortTurn(h.svc.active!.turnId, "c1"); return a.untilCancelled(); };
      await runLocalTurn(h.svc, input({ conversationId }));
      expect(reply.code).toBe("approval_required");
      expect(toolNames().filter((c) => c.name === "autocrew_content")).toHaveLength(0);
    });
  });

  describe("P1-4 执行前再核一次轮次/令牌", () => {
    it("门里读稿件期间轮次被停 → 不执行", async () => {
      h.contents.set("content-1-a", { title: "t", body: "b", platform: "wechat", status: "publish_ready" });
      let approvalId = "";
      let reply: Record<string, unknown> = {};
      h.script = async (a, text) => {
        const m = /已批准 approval_id=(ask-[\w-]+)/.exec(text);
        if (!m) { await h.callTool(a, "autocrew_content", { action: "delete", id: "content-1-a" }); approvalId = h.svc.asks.pending()[0]?.id ?? approvalId; return { stopReason: "end_turn" }; }
        const orig = h.svc.deps.getContent;
        h.svc.deps.getContent = async (id, dir) => { abortTurn(h.svc.active!.turnId, "c1"); return orig(id, dir); };
        reply = await h.callTool(a, "autocrew_content", { action: "delete", id: "content-1-a", approval_id: m[1] });
        return a.untilCancelled();
      };
      const running = runLocalTurn(h.svc, input());
      await until(() => Boolean(approvalId));
      h.svc.asks.answer(approvalId, "allow");
      await running;
      expect(reply.code).toBe("no_live_turn");
      expect(h.mcpCalls).toHaveLength(0);
    });
  });

  describe("P1-5 正文里的令牌不进 SSE 也不落盘", () => {
    it("跨分块的认领令牌在流和历史里都被挡住", async () => {
      const deltas: string[] = [];
      h.script = async (a) => { a.say("你的令牌是 clm-1790000000"); a.say("000-abcd1234 ，还有 ce_AAAAAAAAAAAA"); return { stopReason: "end_turn" }; };
      const r = await runLocalTurn(h.svc, input({ onDelta: (e) => { if (e.text) deltas.push(e.text); } }));
      const reply = (r.data as { reply: string; conversationId: string }).reply;
      expect(deltas.join("")).not.toMatch(/clm-\d|ce_A/);
      expect(deltas.join("")).toContain("[已隐藏]");
      expect(reply).not.toMatch(/clm-\d|ce_A/);
      const conv = await getConversation((r.data as { conversationId: string }).conversationId, h.dataDir);
      expect(JSON.stringify(conv)).not.toMatch(/clm-1790000000000|ce_AAAA/);
    });
    it("StreamRedactor：最后一段先扣住，finish 才放", () => {
      const s = new StreamRedactor(10);
      expect(s.push("abc clm-17900")).toBe("abc");
      expect(s.push("00000000-zzzz9 end") + s.finish()).toBe(" [已隐藏] end");
    });
  });

  describe("P2-6 本机 agent 不能用 article_path 推草稿", () => {
    it("拒绝，不发审批卡", () => {
      expect(classifyPublishAction("autocrew_publish", { action: "wechat_mp_draft", article_path: "/x.md" })).toHaveProperty("refuse");
    });
  });

  describe("P2-7 按进程组清孤儿", () => {
    it("组长死了组员还活着 → 照样杀整组，确认清干净才算", () => {
      let rows: ProcRow[] = [{ pid: 501, pgid: 500, command: "sleep 120" }];
      const kills: number[] = [];
      expect(killRecordedGroup(500, "node adapter", () => rows, (g) => { kills.push(g); rows = []; })).toBe(true);
      expect(kills).toEqual([500]);
    });
    it("杀不掉就返回 false，记录留待下次启动再清", async () => {
      const rows: ProcRow[] = [{ pid: 501, pgid: 500, command: "sleep 120" }];
      expect(killRecordedGroup(500, "node adapter", () => rows, () => {})).toBe(false);
      h.svc.runs.put({ turnId: "t1", clientId: "c", conversationId: "conv-1-a", dataDir: h.dataDir, backend: B, message: "m", status: "running", startedAt: "", pid: 500, command: "node adapter" });
      h.svc.runs.recoverOnStartup(() => false);
      expect(h.svc.runs.get("t1")).toMatchObject({ status: "interrupted", cleanupPending: true });
      const calls: number[] = [];
      h.svc.runs.recoverOnStartup((pid) => { calls.push(pid); return true; });
      expect(calls).toEqual([500]);
      expect(h.svc.runs.get("t1")?.cleanupPending).toBeUndefined();
    });
    it("组长还在但命令不对 = pid 被复用，不动", () => {
      const kills: number[] = [];
      expect(killRecordedGroup(500, "node adapter", () => [{ pid: 500, pgid: 500, command: "/usr/bin/other" }], (g) => kills.push(g))).toBe(true);
      expect(kills).toEqual([]);
    });
  });

  describe("P2-8 等审批时适配器退出", () => {
    it("立刻结束本轮、作废卡片、解锁，不等 10 分钟", async () => {
      h.script = async (a) => {
        await h.callTool(a, "autocrew_content", { action: "delete", id: "content-1-a" });
        setTimeout(() => a.crash("adapter died"), 20);
        return { stopReason: "end_turn" };
      };
      const r = await runLocalTurn(h.svc, input());
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("适配器进程退出了");
      expect(h.svc.active).toBeNull();
      expect(h.svc.asks.pending()).toHaveLength(0);
    });
  });

  describe("P2-9 同一对话的写入串行", () => {
    it("后台结果与本轮收尾并发写，卡片一张不丢", async () => {
      const conv = await createConversation("x", h.dataDir, undefined, { backend: B });
      const binding = { token: "t", backend: B, dataDir: h.dataDir, conversationId: conv.id, turnId: "gone" };
      await Promise.all([1, 2, 3, 4, 5].map((i) => h.svc.recordCard(null, binding, { type: "agent_text", callId: `c${i}`, data: {} })));
      const saved = await getConversation(conv.id, h.dataDir);
      expect(saved?.messages.filter((m) => m.cards?.length)).toHaveLength(5);
    });
  });

  describe("P2-10 中断恢复带上已入账的卡片与写动作", () => {
    it("恢复留痕里有卡片和写动作摘要", async () => {
      const conv = await createConversation("x", h.dataDir, undefined, { backend: B });
      h.svc.runs.put({ turnId: "t2", clientId: "c", conversationId: conv.id, dataDir: h.dataDir, backend: B, message: "写", status: "running", startedAt: "", cards: [{ type: "agent_draft", callId: "k", data: { contentId: "content-1-a" } }], writes: ["autocrew_writer submit"] });
      await h.svc.recoverOnStartup(() => true);
      const last = (await getConversation(conv.id, h.dataDir))!.messages.at(-1)!;
      expect(last.content).toContain("中断前已完成的写动作：autocrew_writer submit");
      expect(last.cards?.[0]).toMatchObject({ callId: "k" });
    });
  });

  describe("P2-11 / P2-12 落盘失败不丢轮次、不卡锁", () => {
    it("对话写失败：run 不标完成（下次启动补写），全局锁照样释放", async () => {
      vi.spyOn(store, "appendTurn").mockRejectedValueOnce(new Error("ENOSPC"));
      const turnId = "t-persist";
      const r = await runLocalTurn(h.svc, input({ turnId }));
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("没能写进对话");
      expect(h.svc.runs.get(turnId)?.status).toBe("running");
      expect(h.svc.active).toBeNull();
      expect((await runLocalTurn(h.svc, input())).ok).toBe(true);
    });
    it("run 记录写盘抛错（ENOSPC）也不会永久卡住「已有 agent 在跑」", async () => {
      const orig = h.svc.runs.patch.bind(h.svc.runs);
      let n = 0;
      vi.spyOn(h.svc.runs, "patch").mockImplementation((id, p) => { if (p.status === "done" && n++ === 0) throw new Error("ENOSPC"); return orig(id, p); });
      await runLocalTurn(h.svc, input());
      expect(h.svc.active).toBeNull();
      expect((await runLocalTurn(h.svc, input())).ok).toBe(true);
      void fs;
    });
  });

  describe("P2-15 待处理视图按资料库过滤", () => {
    it("别的库请求看不到这边在跑的轮与卡", async () => {
      let release!: () => void;
      h.script = async (a) => { void a.handlers.requestPermission({ title: "x", options: [] }); return new Promise((r) => { release = () => r({ stopReason: "end_turn" }); }); };
      const running = runLocalTurn(h.svc, input());
      await until(() => h.svc.asks.pending().length === 1 && typeof release === "function");
      expect(h.svc.pendingView({ dataDir: "/other/lib" })).toEqual({ running: null, asks: [] });
      expect(h.svc.pendingView({ dataDir: h.dataDir, clientId: "c2" }).running).toMatchObject({ owner: false });
      release();
      await running;
    });
  });

  describe("P2-16 视图上下文进 prompt", () => {
    it("打开的稿件与修改焦点拼在消息前，历史里存原话", async () => {
      const block = agentContextBlock({ contentId: "content-1-a", contentTitle: "标题", platform: "wechat", revisionFocus: { scope: "selection", selection: "第一段" } });
      expect(block).toContain("content-1-a");
      expect(block).toContain("第一段");
      const r = await runLocalTurn(h.svc, input({ message: "改这篇", promptContext: block }));
      expect(h.agents[0].prompts[0]).toBe(`${block}改这篇`);
      const conv = await getConversation((r.data as { conversationId: string }).conversationId, h.dataDir);
      expect(conv?.messages.at(-2)?.content).toBe("改这篇");
    });
  });
});
