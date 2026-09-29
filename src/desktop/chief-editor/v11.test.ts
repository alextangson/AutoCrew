/** v1.1 对话交互改进（spec「## v1.1」边界 U1–U13 的后端部分） */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversation, getConversation, TITLE_EDIT_MAX } from "../../storage/conversation-store.js";
import { saveTopic, saveContent, getTopic } from "../../storage/local-store.js";
import { executeTopicCreate } from "../../tools/topic-create.js";
import { buildDispatchContext, parseDispatch } from "../dispatch-context.js";
import { runPersistedChatTurn } from "../chat-persist.js";
import { abortTurn } from "../turn-registry.js";
import { CLAUDE_ADAPTER } from "./backends.js";
import { makeHarness, until, type Harness } from "./fake-agent.test-helper.js";
import { agentAnswerHandler, agentSettingsHandler, conversationRenameHandler } from "./ipc-handlers.js";
import { CHIEF_EDITOR_PERSONA, ensurePersona } from "./persona.js";
import { classifyPublishAction } from "./publish-gate.js";
import { toolDisplayName } from "./tool-names.js";
import { runLocalTurn, type LocalTurnInput } from "./turn.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { await h.cleanup(); });
const input = (over: Partial<LocalTurnInput> = {}): LocalTurnInput => ({
  message: "go", backend: "claude", turnId: `t-${Math.random().toString(36).slice(2, 8)}`, clientId: "c1", dataDir: h.dataDir, ...over,
});
const perm = (a: { handlers: { requestPermission: (r: never) => Promise<string | null> } }) =>
  a.handlers.requestPermission({ title: "Bash echo", toolCallId: "tc", options: [{ optionId: "y", kind: "allow_once" }, { optionId: "n", kind: "reject_once" }] } as never);

describe("U1 轮次进行中改设置，下一轮生效", () => {
  it("本轮用开头读定的设置；改完后下一轮才设新模型", async () => {
    const conv = await createConversation("x", h.dataDir, undefined, { backend: "claude" });
    let release!: () => void;
    h.script = () => new Promise((r) => { release = () => r({ stopReason: "end_turn" }); });
    const running = runLocalTurn(h.svc, input({ conversationId: conv.id }));
    await until(() => typeof release === "function");
    await agentSettingsHandler({ conversation_id: conv.id, model: "sonnet", _dataDir: h.dataDir });
    release();
    await running;
    expect(h.agents[0].configSet).toEqual([]);
    h.script = async () => ({ stopReason: "end_turn" });
    await runLocalTurn(h.svc, input({ conversationId: conv.id }));
    expect(h.agents[1].configSet).toEqual([["model", "sonnet"]]);
  });
});

describe("U2 适配器没上报就不编造", () => {
  it("没跑过、没上报：清单为空（前端显示「默认」不可点）；跑过一次才有，重启后也记得", async () => {
    expect(h.svc.statuses(true, h.dataDir).backends.find((b) => b.id === "claude")).not.toHaveProperty("models");
    await runLocalTurn(h.svc, input());
    const claude = h.svc.statuses(true, h.dataDir).backends.find((b) => b.id === "claude") as unknown as { models: unknown[]; efforts: unknown[] };
    expect(claude.models).toHaveLength(2);
    expect(fs.existsSync(path.join(h.home, "reported.json"))).toBe(true);
  });
});

describe("U3 选的模型不可用", () => {
  it("清单里没有 → 报错点名，不偷换；适配器拒绝 → 同样点名", async () => {
    const r = await runLocalTurn(h.svc, input({ newSettings: { model: "opus-gone" } }));
    expect(String(r.error)).toContain("模型「opus-gone」现在不可用");
    expect(h.agents[0].prompts).toHaveLength(0);
    const orig = h.svc.deps.spawnAgent;
    h.svc.deps.spawnAgent = (l, c, hd) => { const a = orig(l, c, hd); (a as unknown as { rejectConfig: string }).rejectConfig = "sonnet"; return a; };
    const r2 = await runLocalTurn(h.svc, input({ newSettings: { model: "sonnet" } }));
    expect(String(r2.error)).toContain("模型「sonnet」设置失败");
  });
});

describe("U4 全部放行", () => {
  it("shell/文件不弹卡直接放行；发布删除类业务审批照样弹卡", async () => {
    let chosen: string | null = null;
    let reply: Record<string, unknown> = {};
    h.script = async (a) => {
      chosen = await perm(a as never);
      reply = await h.callTool(a, "autocrew_content", { action: "delete", id: "content-1-a" });
      abortTurn(h.svc.active!.turnId, "c1");
      return a.untilCancelled();
    };
    await runLocalTurn(h.svc, input({ newSettings: { permissionMode: "bypass" } }));
    expect(chosen).toBe("y");
    expect(reply.code).toBe("approval_required");
  });
});

describe("U5 始终允许（本对话）", () => {
  it("只作用于这段对话；业务审批不能始终允许；换对话、重启（新实例）回到每次问", async () => {
    let first: string | null = null;
    h.script = async (a) => { const p = perm(a as never); await until(() => h.svc.asks.pending().length === 1); await agentAnswerHandler({ ask_id: h.svc.asks.pending()[0].id, decision: "allow_conversation" }); first = await p; first = (await perm(a as never)) ?? first; return { stopReason: "end_turn" }; };
    const r = await runLocalTurn(h.svc, input());
    expect(first).toBe("y");
    const convId = (r.data as { conversationId: string }).conversationId;
    expect(h.svc.conversationAllowed(convId)).toBe(true);
    // 另一段对话仍然弹卡
    h.script = async (a) => { void perm(a as never); await until(() => h.svc.asks.pending().length === 1); h.svc.asks.answer(h.svc.asks.pending()[0].id, "deny"); return { stopReason: "end_turn" }; };
    await runLocalTurn(h.svc, input());
    // 业务审批拒绝 allow_conversation
    h.script = async (a) => { await h.callTool(a, "autocrew_content", { action: "delete", id: "content-1-a" }); const res = await agentAnswerHandler({ ask_id: h.svc.asks.pending()[0].id, decision: "allow_conversation" }); expect(res.ok).toBe(false); abortTurn(h.svc.active!.turnId, "c1"); return a.untilCancelled(); };
    await runLocalTurn(h.svc, input({ conversationId: convId }));
    const fresh = await makeHarness();
    expect(fresh.svc.conversationAllowed(convId)).toBe(false);
    await fresh.cleanup();
  });
});

describe("U6 改名", () => {
  it("空名不保存；截断到 40 字；后写覆盖", async () => {
    const conv = await createConversation("原名", h.dataDir);
    expect((await conversationRenameHandler({ id: conv.id, title: "   ", _dataDir: h.dataDir })).ok).toBe(false);
    expect((await getConversation(conv.id, h.dataDir))?.meta.title).toBe("原名");
    await conversationRenameHandler({ id: conv.id, title: "长".repeat(60), _dataDir: h.dataDir });
    expect(Array.from((await getConversation(conv.id, h.dataDir))!.meta.title)).toHaveLength(TITLE_EDIT_MAX);
    await Promise.all([conversationRenameHandler({ id: conv.id, title: "A", _dataDir: h.dataDir }), conversationRenameHandler({ id: conv.id, title: "B", _dataDir: h.dataDir })]);
    expect((await getConversation(conv.id, h.dataDir))?.meta.title).toBe("B");
  });
});

describe("U7 / U8 按钮派活", () => {
  it("选题上下文结构化传给模型，历史里存人话；旧消息不迁移", async () => {
    const topic = await saveTopic({ title: "测试", description: "背景说明", tags: [] }, h.dataDir);
    const d = parseDispatch({ kind: "write", title: "测试", platform: "douyin", topic_id: topic.id })!;
    const built = await buildDispatchContext(d, h.dataDir);
    expect(built.ok && built.text).toContain(`灵感库编号：${topic.id}`);
    let sent = "";
    await runPersistedChatTurn({ message: "写抖音稿 ·《测试》", modelPrefix: built.ok ? built.text : "", dataDir: h.dataDir, runTurn: async (p) => { sent = p.message; return { ok: true, data: { reply: "好" } }; } });
    expect(sent).toContain("灵感库编号");
    expect(sent.endsWith("写抖音稿 ·《测试》")).toBe(true);
  });
  it("选题已删：不发，提示选题不存在", async () => {
    const built = await buildDispatchContext({ kind: "write", title: "没了", platform: "douyin", topicId: "topic-gone" }, h.dataDir);
    expect(built).toMatchObject({ ok: false });
    expect(!built.ok && built.error).toContain("已不存在");
  });
});

describe("U9 / U10 删选题", () => {
  it("选题下还有稿件：拒绝并列出稿件", async () => {
    const topic = await saveTopic({ title: "有稿", description: "d", tags: [] }, h.dataDir);
    await saveContent({ title: "稿一", body: "b", platform: "douyin", topicId: topic.id } as never, h.dataDir);
    const r = await executeTopicCreate({ action: "delete", id: topic.id, _dataDir: h.dataDir }) as Record<string, unknown>;
    expect(r.code).toBe("topic_has_drafts");
    expect(String(r.error)).toContain("《稿一》");
    expect((await getTopic(topic.id, h.dataDir))?.deletedAt).toBeFalsy();
  });
  it("删选题走业务审批；审批后选题被改 → 指纹不符，要求重新确认", async () => {
    expect(classifyPublishAction("autocrew_topic", { action: "delete", id: "t1" })).toMatchObject({ topicId: "t1", label: "删除选题" });
    let snapshot = { title: "选题", body: "v1" };
    h.svc.deps.getTopic = async () => snapshot;
    let retry: Record<string, unknown> = {};
    h.script = async (a, text) => {
      const m = /已批准 approval_id=(ask-[\w-]+)/.exec(text);
      if (!m) { await h.callTool(a, "autocrew_topic", { action: "delete", id: "t1" }); return { stopReason: "end_turn" }; }
      snapshot = { title: "选题", body: "v2" };
      retry = await h.callTool(a, "autocrew_topic", { action: "delete", id: "t1", approval_id: m[1] });
      abortTurn(h.svc.active!.turnId, "c1");
      return a.untilCancelled();
    };
    const running = runLocalTurn(h.svc, input());
    await until(() => h.svc.asks.pending().length === 1);
    h.svc.asks.answer(h.svc.asks.pending()[0].id, "allow");
    await running;
    expect(retry.code).toBe("approval_required");
    expect(h.mcpCalls).toHaveLength(0);
  });
});

describe("U11 减负", () => {
  it("只加载本目录（人设 + AutoCrew 技能），不带全局 MCP/插件；人设说明做不到就直说", () => {
    const opts = (CLAUDE_ADAPTER.sessionMeta().claudeCode as { options: Record<string, unknown> }).options;
    expect(opts.settingSources).toEqual(["project"]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(CHIEF_EDITOR_PERSONA).toContain("直说这里做不到");
    ensurePersona(h.home, "claude");
    expect(fs.readlinkSync(path.join(h.home, ".claude", "skills"))).toMatch(/skills$/);
    expect(fs.existsSync(path.join(h.home, ".claude", "skills", "content-review", "SKILL.md"))).toBe(true);
  });
});

describe("U12 工作记录", () => {
  it("工具调用成组、中文名；出错那条带错误；压缩一行；随对话落盘", async () => {
    h.script = async (a) => {
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "1", title: "mcp__autocrew__autocrew_content", rawInput: { action: "get" } });
      a.handlers.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed" });
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "2", title: "Terminal", kind: "execute", rawInput: { command: "ls /nope" } });
      a.handlers.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "2", status: "failed", rawOutput: "ls: /nope: No such file" } as never);
      a.handlers.onUpdate({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" } as never);
      a.say("好了");
      return { stopReason: "end_turn" };
    };
    const r = await runLocalTurn(h.svc, input());
    const log = (r.data as { cards: Array<{ type: string; data: { items: Array<Record<string, string>> } }> }).cards[0];
    expect(log.type).toBe("agent_worklog");
    expect(log.data.items.map((i) => i.name)).toEqual(["读取稿件", "运行命令：ls /nope", "整理了一下上下文"]);
    // 业务审批拦下不画成出错（真机回归）
    expect(toolDisplayName("ls /tmp", undefined, "execute")).toBe("运行命令：ls /tmp");
    expect(log.data.items[1]).toMatchObject({ status: "failed", error: expect.stringContaining("No such file") });
    expect(h.events.some((e) => e.type === "work")).toBe(true);
    expect((r.data as { reply: string }).reply).toBe("好了");
  });
  it("业务审批拦下记成「等你批准」，不画红字（真机回归）", async () => {
    h.script = async (a) => {
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "9", title: "mcp__autocrew__autocrew_topic", rawInput: { action: "delete" } });
      a.handlers.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "9", status: "failed", rawOutput: '{"ok":false,"code":"approval_required"}' } as never);
      return { stopReason: "end_turn" };
    };
    const r = await runLocalTurn(h.svc, input());
    const item = (r.data as { cards: Array<{ data: { items: Array<Record<string, string>> } }> }).cards[0].data.items[0];
    expect(item).toMatchObject({ name: "删除选题", status: "done", note: "等你批准" });
  });
  it("中文工具名：认不出退回原标题", () => {
    expect(toolDisplayName("mcp__autocrew__autocrew_topic", { action: "delete" })).toBe("删除选题");
    expect(toolDisplayName("SomethingNew")).toBe("SomethingNew");
  });
});
