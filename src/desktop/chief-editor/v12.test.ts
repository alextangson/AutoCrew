/** v1.2 对话体验（spec「## v1.2」边界 X1–X9 的后端部分） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversation, deleteConversation, getConversation } from "../../storage/conversation-store.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
import { abortTurn } from "../turn-registry.js";
import * as backends from "./backends.js";
import { makeHarness, until, type Harness } from "./fake-agent.test-helper.js";
import { CHIEF_EDITOR_PERSONA } from "./persona.js";
import { routeRetryToAgent } from "./retry-route.js";
import { runLocalTurn, type LocalTurnInput } from "./turn.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.cleanup(); });
const input = (over: Partial<LocalTurnInput> = {}): LocalTurnInput => ({
  message: "go", backend: "claude", turnId: `t-${Math.random().toString(36).slice(2, 8)}`, clientId: "c1", dataDir: h.dataDir, ...over,
});
type Log = { type: string; data: { items: Array<Record<string, unknown>>; durationMs?: number; stopped?: boolean; unresolved?: number } };
const logOf = (r: Record<string, unknown>) => (r.data as { cards: Log[] }).cards.find((c) => c.type === "agent_worklog");

describe("过程折叠：思考、工具、过渡文字进「已处理」块，最终回复在外", () => {
  it("思考并成一条；工具前的过渡文字收进块；回复只留最后一段；带用时", async () => {
    h.script = async (a) => {
      a.handlers.onUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先看看" } });
      a.handlers.onUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "稿子状态" } });
      a.say("我先读一下稿子。");
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "1", title: "mcp__autocrew__autocrew_content", rawInput: { action: "get" } });
      a.handlers.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed" });
      a.say("稿子已交，状态是待审。");
      return { stopReason: "end_turn" };
    };
    const r = await runLocalTurn(h.svc, input());
    expect((r.data as { reply: string }).reply).toBe("稿子已交，状态是待审。");
    const log = logOf(r)!;
    expect(log.data.items.map((i) => [i.kind ?? "tool", i.name])).toEqual([["thought", "先看看稿子状态"], ["note", "我先读一下稿子。"], ["tool", "读取稿件"]]);
    expect(typeof log.data.durationMs).toBe("number");
  });
  it("X3：只有回复没有过程 → 不出块", async () => {
    h.script = async (a) => { a.say("你好"); return { stopReason: "end_turn" }; };
    const r = await runLocalTurn(h.svc, input());
    expect(logOf(r)).toBeUndefined();
  });
  it("X2：被停止 → 块标 stopped，写动作在外面列出", async () => {
    const turnId = "t-x2";
    h.script = async (a) => {
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "1", title: "Terminal", kind: "execute", rawInput: { command: "echo a" } });
      a.handlers.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed" });
      return a.untilCancelled();
    };
    const running = runLocalTurn(h.svc, input({ turnId }));
    await until(() => (h.svc.active?.writes.length ?? 0) > 0);
    abortTurn(turnId, "c1");
    const r = await running;
    expect(logOf(r)!.data.stopped).toBe(true);
    expect((r.data as { reply: string }).reply).toContain("停之前已完成的写动作");
  });
  it("X1：进行中刷新，快照里带着已有的过程", async () => {
    let release!: () => void;
    h.script = async (a) => {
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "1", title: "mcp__autocrew__autocrew_status" });
      return new Promise((r) => { release = () => r({ stopReason: "end_turn" }); });
    };
    const running = runLocalTurn(h.svc, input());
    await until(() => typeof release === "function");
    expect((h.svc.pendingView({ dataDir: h.dataDir }).running as { worklog: unknown[] }).worklog).toHaveLength(1);
    release();
    await running;
  });
});

describe("失败处理", () => {
  it("X6：失败后同一动作重试成功 → 失败标已解决、成功标 recovered，外面不报未解决", async () => {
    h.script = async (a) => {
      for (const [id, status] of [["1", "failed"], ["2", "completed"]] as const) {
        a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: id, title: "mcp__autocrew__autocrew_scout", rawInput: { action: "perspective" } });
        a.handlers.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: id, status, ...(status === "failed" ? { rawOutput: "引文对不上" } : {}) } as never);
      }
      return { stopReason: "end_turn" };
    };
    const log = logOf(await runLocalTurn(h.svc, input()))!;
    expect(log.data.items[0]).toMatchObject({ status: "failed", resolved: true });
    expect(log.data.items[1]).toMatchObject({ status: "done", recovered: true });
    expect(log.data.unresolved).toBeUndefined();
  });
  it("没解决的失败：块上记未解决数", async () => {
    h.script = async (a) => {
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "1", title: "Terminal", kind: "execute", rawInput: { command: "ls /nope" } });
      a.handlers.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "failed", rawOutput: "no such file" } as never);
      return { stopReason: "end_turn" };
    };
    expect(logOf(await runLocalTurn(h.svc, input()))!.data.unresolved).toBe(1);
  });
  it("人设：读错误、同一动作最多重试 2 次、说不清就讲清哪步失败，不装成功", () => {
    expect(CHIEF_EDITOR_PERSONA).toContain("最多重试 2 次");
    expect(CHIEF_EDITOR_PERSONA).toContain("绝不把没成功的事说成成功");
  });
});

async function agentDraft(convId?: string) {
  const turnId = "t-origin";
  if (convId) h.svc.runs.put({ turnId, clientId: "c", conversationId: convId, dataDir: h.dataDir, backend: "claude", message: "写", status: "interrupted", startedAt: "" });
  const c = await saveContent({ title: "［生成中断］FDE 会消失", body: "", platform: "douyin" } as never, h.dataDir);
  await updateContent(c.id, { claim: { host: "chief-editor", session: turnId, employee: "writer", at: "", leaseUntil: "", lastWriteAt: "", machine: "m", bindingRevision: 1, token: "x" } } as never, h.dataDir);
  return c;
}

describe("重试回到原写手（v1.2 §4）", () => {
  it("本机 agent 写的稿：「继续写《…》」发回原对话，同一个本机后端接着写", async () => {
    const conv = await createConversation("写 FDE", h.dataDir, undefined, { backend: "claude" });
    const c = await agentDraft(conv.id);
    const r = await routeRetryToAgent(c.id, h.dataDir);
    expect(r).toMatchObject({ ok: true, routed: "local", conversationId: conv.id });
    await until(() => h.svc.active === null && h.agents.length === 1);
    expect(h.agents[0].prompts[0]).toContain("继续写《FDE 会消失》");
    const msgs = (await getConversation(conv.id, h.dataDir))!.messages;
    expect(msgs.at(-2)?.content).toBe("继续写《FDE 会消失》");
  });
  it("内置引擎写的稿 → 交回原来的内置重试", async () => {
    const c = await saveContent({ title: "内置写的", body: "", platform: "douyin" } as never, h.dataDir);
    expect(await routeRetryToAgent(c.id, h.dataDir)).toBeNull();
  });
  it("X7：原对话已删 → 新开一段，气泡说明", async () => {
    const conv = await createConversation("写 FDE", h.dataDir, undefined, { backend: "claude" });
    const c = await agentDraft(conv.id);
    await deleteConversation(conv.id, h.dataDir);
    const r = await routeRetryToAgent(c.id, h.dataDir);
    expect(String(r?.message)).toContain("原对话已删除，新开了一段");
    expect(r).not.toHaveProperty("conversationId");
    await until(() => h.svc.active === null && h.agents.length === 1);
  });
  it("X8：本机后端不可用（没装 / 代理没开）→ 报原因与修法，不改走内置（「上次未登录」只是提示，见 review-v12 P2-9）", async () => {
    const c = await agentDraft();
    vi.spyOn(backends.CLAUDE_ADAPTER, "launch").mockReturnValueOnce(null);
    const r = await routeRetryToAgent(c.id, h.dataDir);
    expect(r).toMatchObject({ ok: false });
    expect(String(r?.error)).toContain("不会改用内置引擎");
    vi.spyOn(backends, "proxyUnreachable").mockResolvedValue("代理 127.0.0.1:8787 连不上");
    expect(String((await routeRetryToAgent(c.id, h.dataDir))?.error)).toContain("连不上");
    expect(h.agents).toHaveLength(0);
  });
  it("X9：已有 agent 在跑 → 明说，不排队", async () => {
    const c = await agentDraft();
    let release!: () => void;
    h.script = () => new Promise((r) => { release = () => r({ stopReason: "end_turn" }); });
    const running = runLocalTurn(h.svc, input());
    await until(() => typeof release === "function");
    const r = await routeRetryToAgent(c.id, h.dataDir);
    expect(String(r?.error)).toContain("已有一个本机 agent 在跑");
    release();
    await running;
  });
});
