import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConversation } from "../../storage/conversation-store.js";
import { LocalSessionAuth } from "../server-auth.js";
import { abortTurn } from "../turn-registry.js";
import { makeHarness, until, type Harness } from "./fake-agent.test-helper.js";
import { runLocalTurn, type LocalTurnInput } from "./turn.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.cleanup(); });

const input = (over: Partial<LocalTurnInput> = {}): LocalTurnInput => ({
  message: "发出去", backend: "claude", turnId: `t-${Math.random().toString(36).slice(2, 8)}`, clientId: "c1", dataDir: h.dataDir, ...over,
});
const DRAFT = { title: "标题", body: "正文", platform: "wechat", status: "publish_ready" };
const publishCalls = () => h.mcpCalls.filter((c) => (c.request.params as { name: string }).name === "autocrew_publish");

describe("§地基 2：发布类动作执行前审批", () => {
  it("先回 approval_required 不执行；批准后系统发一句继续，agent 带 id 重调才执行；id 只能用一次", async () => {
    h.contents.set("content-1-a", DRAFT);
    const replies: Record<string, unknown>[] = [];
    h.script = async (a, text) => {
      if (text.includes("没有获批")) return { stopReason: "end_turn" };
      const m = text.match(/已批准 approval_id=(ask-[\w-]+)/);
      const args = { action: "wechat_mp_draft", content_id: "content-1-a", ...(m ? { approval_id: m[1] } : {}) };
      replies.push(await h.callTool(a, "autocrew_publish", args));
      if (m) replies.push(await h.callTool(a, "autocrew_publish", args));
      return { stopReason: "end_turn" };
    };
    const running = runLocalTurn(h.svc, input());
    await until(() => h.svc.asks.pending().length === 1);
    expect(replies[0]).toMatchObject({ code: "approval_required" });
    expect(publishCalls()).toHaveLength(0);
    expect(h.svc.active?.status).toBe("awaiting_approval");
    h.svc.asks.answer(h.svc.asks.pending()[0].id, "allow");
    await until(() => h.svc.asks.pending().length === 1);
    expect(publishCalls()).toHaveLength(1);
    expect((publishCalls()[0].request.params as { arguments: Record<string, unknown> }).arguments.approval_id).toBeUndefined();
    expect(replies[2]).toMatchObject({ code: "approval_required" }); // 同一个 id 第二次用：失效
    h.svc.asks.answer(h.svc.asks.pending()[0].id, "deny");
    await running;
    expect(h.agents[0].prompts[1]).toMatch(/已批准 approval_id=ask-/);
    expect(h.agents[0].prompts[2]).toContain("没有获批");
  });

  it("agent 还在说话时审批就被批了：收尾后照样补发「已批准」那句（真机回归）", async () => {
    h.contents.set("content-1-a", DRAFT);
    h.script = async (a, text) => {
      if (text.startsWith("已批准")) return { stopReason: "end_turn" };
      await h.callTool(a, "autocrew_content", { action: "delete", id: "content-1-a" });
      h.svc.asks.answer(h.svc.asks.pending()[0].id, "allow");
      return { stopReason: "end_turn" };
    };
    await runLocalTurn(h.svc, input());
    expect(h.agents[0].prompts).toHaveLength(2);
    expect(h.agents[0].prompts[1]).toMatch(/^已批准 approval_id=ask-/);
  });

  it("边界 8：批准后稿件又被改过，指纹不符，要求重新确认", async () => {
    h.contents.set("content-1-a", DRAFT);
    let retry: Record<string, unknown> = {};
    h.script = async (a, text) => {
      const m = text.match(/已批准 approval_id=(ask-[\w-]+)/);
      if (!m) { await h.callTool(a, "autocrew_publish", { action: "wechat_mp_draft", content_id: "content-1-a" }); return { stopReason: "end_turn" }; }
      h.contents.set("content-1-a", { ...DRAFT, body: "批准后改过的正文" });
      retry = await h.callTool(a, "autocrew_publish", { action: "wechat_mp_draft", content_id: "content-1-a", approval_id: m[1] });
      return { stopReason: "end_turn" };
    };
    const running = runLocalTurn(h.svc, input());
    await until(() => h.svc.asks.pending().length === 1);
    h.svc.asks.answer(h.svc.asks.pending()[0].id, "allow");
    await until(() => Object.keys(retry).length > 0);
    expect(retry).toMatchObject({ code: "approval_required" });
    expect(String(retry.error)).toContain("原审批已失效");
    expect(publishCalls()).toHaveLength(0);
    abortTurn(h.svc.active!.turnId, "c1");
    await running;
  });
});

describe("边界 9：切资料库时 agent 在跑", () => {
  it("MCP 调用仍落在会话绑定的原库；切换器提示后台还在处理旧库", async () => {
    let release!: () => void;
    h.script = async (a) => {
      await h.callTool(a, "autocrew_content", { action: "get", id: "content-1-a" });
      return new Promise((r) => { release = () => r({ stopReason: "end_turn" }); });
    };
    const running = runLocalTurn(h.svc, input());
    await until(() => typeof release === "function");
    expect(h.mcpCalls[0].dataDir).toBe(h.dataDir);
    expect(h.svc.statuses(true, "/some/other/library").running).toMatchObject({ otherLibrary: true });
    release();
    await running;
  });
});

describe("边界 10 / §地基 13：认领被占、卡片脱敏", () => {
  it("claim_held 如实转述占用者，claim_token 不进卡片、SSE", async () => {
    await h.cleanup();
    h = await makeHarness({
      mcpResult: () => ({ ok: false, code: "claim_held", error: "这篇现在记在 codex 名下（还剩 20 分钟），带上它的 claim_token=deadbeefdeadbeefdeadbeefdeadbeef00；", claim_token: "secret-claim-token-value" }),
    });
    let reply: Record<string, unknown> = {};
    h.script = async (a) => { reply = await h.callTool(a, "autocrew_writer", { action: "submit", content_id: "content-1-a" }); return { stopReason: "end_turn" }; };
    const r = await runLocalTurn(h.svc, input());
    // 占用者原样回给 agent（由它转述）；失败不单独成卡，只在工作记录里红字（bug B）
    expect(String(reply.error)).toContain("codex 名下");
    const cards = JSON.stringify((r.data as { cards: unknown[] }).cards);
    expect(cards).not.toContain("secret-claim-token-value");
    expect(JSON.stringify(h.events)).not.toContain("secret-claim-token-value");
  });
});

describe("边界 11：调用迟到 / §地基 4 归属", () => {
  it("进入时属于本轮、停止后才返回 → 记为后台结果追加到对话，不串到下一轮", async () => {
    await h.cleanup();
    let finishCall!: () => void;
    h = await makeHarness();
    h.svc.deps.execMcp = async (request) => {
      await new Promise<void>((r) => { finishCall = r; });
      return { jsonrpc: "2.0", id: request.id, result: { structuredContent: { ok: true, message: "迟到的结果" } } };
    };
    const turnId = "t-late";
    let late!: Promise<unknown>;
    h.script = async (a) => {
      const binding = h.svc.bindingFor(`Bearer ${a.mcp!.token}`)!;
      const { handleAgentMcp } = await import("./mcp-bridge.js");
      late = handleAgentMcp(h.svc, binding, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "autocrew_topic", arguments: { action: "create" } } });
      return a.untilCancelled();
    };
    const running = runLocalTurn(h.svc, input({ turnId }));
    await until(() => typeof finishCall === "function");
    abortTurn(turnId, "c1");
    const r = await running;
    expect((r.data as { cards: unknown[] }).cards).toHaveLength(0);
    finishCall();
    await late;
    const conv = await getConversation((r.data as { conversationId: string }).conversationId, h.dataDir);
    const last = conv!.messages.at(-1)!;
    expect(last.cards?.[0]).toMatchObject({ background: true });
    expect(h.events.some((e) => e.type === "background")).toBe(true);
  });
});

describe("§地基 1：会话令牌只认 /mcp", () => {
  it("/api/* 的鉴权不认识会话令牌", async () => {
    let token = "";
    h.script = async (a) => { token = a.mcp!.token; return { stopReason: "end_turn" }; };
    const running = runLocalTurn(h.svc, input());
    await running;
    const auth = new LocalSessionAuth("boot", new Set(["http://127.0.0.1:4317"]), undefined, undefined, "automation", () => null);
    expect(auth.authenticate({ authorization: `Bearer ${token}` })).toBeNull();
    expect(auth.identify({ authorization: `Bearer ${token}` })).toBeNull();
  });
});
