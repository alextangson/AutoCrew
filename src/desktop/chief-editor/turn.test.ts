import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversation, getConversation, updateConversationAgent } from "../../storage/conversation-store.js";
import { abortTurn, getTurnStatus } from "../turn-registry.js";
import { CLAUDE_ADAPTER } from "./backends.js";
import { makeHarness, until, type Harness } from "./fake-agent.test-helper.js";
import { runLocalTurn, type LocalTurnInput } from "./turn.js";

let h: Harness;
beforeEach(async () => { h = await makeHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.cleanup(); });

const input = (over: Partial<LocalTurnInput> = {}): LocalTurnInput => ({
  message: "写一篇", backend: "claude", turnId: `t-${Math.random().toString(36).slice(2, 8)}`, clientId: "c1", dataDir: h.dataDir, ...over,
});

describe("本机 agent 一轮：正常路径与持久化（§地基 7 / 12）", () => {
  it("启动前先落盘对话/后端/资料库/轮次，cwd 固定并写好人设，回复与卡片落进对话", async () => {
    let seenBeforePrompt: unknown;
    h.script = async (a) => {
      seenBeforePrompt = h.svc.runs.list()[0];
      a.say("好的，");
      await h.callTool(a, "autocrew_writer", { action: "submit", content_id: "content-1-a" });
      a.say("写完了");
      return { stopReason: "end_turn" };
    };
    h.contents.set("content-1-a", { title: "标题", body: "正文", platform: "wechat", status: "draft" });
    const r = await runLocalTurn(h.svc, input());
    expect(r.ok).toBe(true);
    const data = r.data as { reply: string; conversationId: string; cards: Array<{ type: string }> };
    expect(data.reply).toBe("好的，写完了");
    expect(seenBeforePrompt).toMatchObject({ status: "running", backend: "claude", dataDir: h.dataDir, conversationId: data.conversationId });
    const conv = await getConversation(data.conversationId, h.dataDir);
    expect(conv?.meta.backend).toBe("claude");
    expect(conv?.meta.acpSessionId).toMatch(/^sess-/);
    expect(conv?.messages.at(-1)?.content).toBe("好的，写完了");
    expect(data.cards[0].type).toBe("agent_draft");
    expect(fs.readFileSync(path.join(h.home, "CLAUDE.md"), "utf-8")).toContain("网页对话框里回复创始人");
    expect(h.svc.runs.list()[0].status).toBe("done");
    expect(h.svc.active).toBeNull();
  });

  it("会话令牌只在本轮有效：轮次结束即撤销", async () => {
    h.script = async () => ({ stopReason: "end_turn" });
    await runLocalTurn(h.svc, input());
    expect(h.svc.bindingFor(`Bearer ${h.agents[0].mcp!.token}`)).toBeNull();
    expect(h.agents[0].killed).toBeGreaterThan(0);
  });
});

describe("边界 1：没装 / 没登录，绝不走内置引擎", () => {
  it("适配器没装：报原因+修法", async () => {
    vi.spyOn(CLAUDE_ADAPTER, "launch").mockReturnValue(null);
    const r = await runLocalTurn(h.svc, input());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("npm install");
    expect(String(r.error)).toContain("不会自动改用内置引擎");
    expect(h.agents).toHaveLength(0);
  });

  it("认证失败：标未登录、给修法；下一次成功后清掉", async () => {
    h.script = async () => { throw new Error("Internal error: Failed to authenticate: OAuth session expired"); };
    const r = await runLocalTurn(h.svc, input());
    expect(String(r.error)).toContain("在终端运行 `claude`");
    expect(h.svc.statuses(true, h.dataDir).backends.find((b) => b.id === "claude")?.state).toBe("not_logged_in");
    h.script = async () => ({ stopReason: "end_turn" });
    await runLocalTurn(h.svc, input());
    expect(h.svc.authFailed.has("claude")).toBe(false);
  });
});

describe("边界 2：停止", () => {
  it("ACP cancel → 宽限后杀进程组；回复列出停之前已完成的写动作", async () => {
    const turnId = "t-stop";
    h.script = async (a) => {
      await h.callTool(a, "autocrew_content", { action: "update", id: "content-1-a" });
      return a.untilCancelled();
    };
    const running = runLocalTurn(h.svc, input({ turnId }));
    await until(() => (h.svc.active?.writes.length ?? 0) > 0);
    expect(abortTurn(turnId, "c1")).toBe("settling");
    const r = await running;
    const data = r.data as { reply: string; stopReason: string };
    expect(data.stopReason).toBe("aborted");
    expect(data.reply).toContain("停之前已完成的写动作：autocrew_content update");
    expect(h.agents[0].cancelled).toBe(1);
    await until(() => h.agents[0].killed > 0);
  });
});

describe("边界 2：停止时仍在执行的命令", () => {
  it("如实说「可能已部分生效」，不说成没做任何事（真机回归）", async () => {
    const turnId = "t-stop-inflight";
    h.script = async (a) => {
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "Terminal", kind: "execute", rawInput: { command: "echo start > s.txt && sleep 120" } });
      return a.untilCancelled();
    };
    const running = runLocalTurn(h.svc, input({ turnId }));
    await until(() => (h.svc.active?.inFlight.size ?? 0) > 0);
    abortTurn(turnId, "c1");
    const data = (await running).data as { reply: string };
    expect(data.reply).toContain("停止时仍在执行、可能已部分生效：Terminal：echo start > s.txt && sleep 120");
  });
});

describe("边界 2：停止时还在等权限的命令", () => {
  it("没获准就没跑，不算「可能已部分生效」（真机回归）", async () => {
    const turnId = "t-stop-perm";
    h.script = async (a) => {
      a.handlers.onUpdate({ sessionUpdate: "tool_call", toolCallId: "tc9", title: "sleep 60", kind: "execute" });
      void a.handlers.requestPermission({ title: "sleep 60", toolCallId: "tc9", options: [{ optionId: "y", kind: "allow_once" }, { optionId: "n", kind: "reject_once" }] });
      return a.untilCancelled();
    };
    const running = runLocalTurn(h.svc, input({ turnId }));
    await until(() => h.svc.asks.pending().length === 1);
    abortTurn(turnId, "c1");
    const data = (await running).data as { reply: string };
    expect(data.reply).not.toContain("可能已部分生效");
  });
});

describe("边界 3 / 4：对话锁与全局一个 agent", () => {
  it("同对话第二个请求被拒；别的对话也被拒且不排队", async () => {
    const conv = await createConversation("x", h.dataDir, undefined, { backend: "claude" });
    let release!: () => void;
    h.script = () => new Promise((r) => { release = () => r({ stopReason: "end_turn" }); });
    const first = runLocalTurn(h.svc, input({ conversationId: conv.id }));
    await until(() => h.agents.length === 1 && typeof release === "function");
    const same = await runLocalTurn(h.svc, input({ conversationId: conv.id, clientId: "c2" }));
    expect(same.error).toBe("这段对话正在跑，等它结束或先点停止");
    const other = await runLocalTurn(h.svc, input({ clientId: "c3" }));
    expect(String(other.error)).toContain("已有一个本机 agent 在跑");
    release();
    expect((await first).ok).toBe(true);
  });
});

describe("边界 5：刷新 / 断线后重新挂上", () => {
  it("进行中轮次与待处理卡可查询；轮次状态 running", async () => {
    const turnId = "t-refresh";
    h.script = async (a) => {
      await a.handlers.requestPermission({ title: "Bash echo hi", options: [{ optionId: "a", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] });
      return { stopReason: "end_turn" };
    };
    const running = runLocalTurn(h.svc, input({ turnId }));
    await until(() => h.svc.asks.pending().length === 1);
    const view = h.svc.pendingView({ dataDir: h.dataDir, clientId: "c1" });
    expect(view.running).toMatchObject({ turnId, status: "running", owner: true });
    expect(view.asks[0]).toMatchObject({ kind: "permission", title: "允许本机 agent 执行？" });
    expect((await getTurnStatus(turnId)).status).toBe("running");
    h.svc.asks.answer(view.asks[0].id, "allow");
    await running;
  });
});

describe("边界 6：守护进程重启", () => {
  it("残留轮标中断、清进程组、对话留痕；重发时续原 session", async () => {
    const conv = await createConversation("旧消息", h.dataDir, undefined, { backend: "claude" });
    await updateConversationAgent(conv.id, { acpSessionId: "sess-old" }, h.dataDir);
    h.svc.runs.put({ turnId: "t-old", clientId: "c", conversationId: conv.id, dataDir: h.dataDir, backend: "claude", message: "旧消息", status: "running", startedAt: "2026-09-28T00:00:00Z", pid: 4242, command: "node adapter" });
    const killed: number[] = [];
    await h.svc.recoverOnStartup((pid) => { killed.push(pid); return true; });
    expect(killed).toEqual([4242]);
    expect(h.svc.runs.get("t-old")?.status).toBe("interrupted");
    expect((await getConversation(conv.id, h.dataDir))?.messages.at(-1)?.content).toContain("被中断了");
    h.script = async (a) => { a.say("新回复"); return { stopReason: "end_turn" }; };
    const r = await runLocalTurn(h.svc, input({ conversationId: conv.id }));
    expect(h.agents[0].loaded).toEqual(["sess-old"]);
    // 续会话时适配器重放的历史不算本轮输出（真机回归）
    expect((r.data as { reply: string }).reply).toBe("新回复");
  });

  it("续不上就新开，并在回复里说一句「已新开」", async () => {
    const conv = await createConversation("x", h.dataDir, undefined, { backend: "claude" });
    await updateConversationAgent(conv.id, { acpSessionId: "sess-gone" }, h.dataDir);
    // loadFails 要在 loadSession 之前生效：包一层 spawn，构造后立刻设置
    const orig = h.svc.deps.spawnAgent;
    h.svc.deps.spawnAgent = (l, c, hd) => { const a = orig(l, c, hd); (a as unknown as { loadFails: boolean }).loadFails = true; return a; };
    const r = await runLocalTurn(h.svc, input({ conversationId: conv.id }));
    expect((r.data as { reply: string }).reply).toContain("已新开");
  });
});

describe("边界 7：卡片没人理", () => {
  it("权限卡 10 分钟（测试缩短）没应答按拒绝，并告诉 agent", async () => {
    await h.cleanup();
    h = await makeHarness({ askTtlMs: 30 });
    let chosen: string | null = "x";
    h.script = async (a) => {
      chosen = await a.handlers.requestPermission({ title: "Bash rm", options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }] });
      return { stopReason: "end_turn" };
    };
    await runLocalTurn(h.svc, input());
    expect(chosen).toBe("no");
    expect(h.events.some((e) => e.type === "ask_resolved" && (e.ask as { status: string }).status === "expired")).toBe(true);
  });
});

describe("边界 12：适配器崩溃", () => {
  it("该轮报错并附脱敏后的最后几行", async () => {
    h.script = async (a) => {
      a.crash("booting\nAuthorization: Bearer abcdefabcdefabcdefabcdefabcdefabcdef\npanic: unexpected token in JSON");
      return new Promise(() => {});
    };
    const r = await runLocalTurn(h.svc, input());
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("适配器进程退出了");
    expect(String(r.error)).toContain("panic: unexpected token in JSON");
    expect(String(r.error)).not.toContain("abcdefabcdef");
    const conv = await getConversation((r.data as { conversationId: string }).conversationId, h.dataDir);
    expect(conv?.messages.at(-1)?.content).toContain("⚠️");
  });
});

describe("线路：必须经过创始人的代理（2026-09-29）", () => {
  const settingsWith = (body: string) => {
    const file = path.join(h.home, "settings.json");
    fs.writeFileSync(file, body);
    return file;
  };
  const withSettings = (body: string) => { h.svc.deps.claudeSettingsPath = settingsWith(body); };

  it("代理开着：ANTHROPIC_BASE_URL 带进 agent 环境，别的令牌不带；工具说明按需加载强制打开", async () => {
    const net = await import("node:net");
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      withSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, GITHUB_PERSONAL_ACCESS_TOKEN: "gho_x" } }));
      const r = await runLocalTurn(h.svc, input());
      expect(r.ok).toBe(true);
      expect(h.launches[0].env).toEqual({ ENABLE_TOOL_SEARCH: "true", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
      // 同一份线路变量也写进最高优先级的会话 settings：项目 settings 盖不掉代理
      const meta = h.agents[0].meta[0] as { claudeCode: { options: { settings: { env: Record<string, string> } } } };
      expect(meta.claudeCode.options.settings.env).toEqual({ ENABLE_TOOL_SEARCH: "true", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
    } finally {
      server.close();
    }
  });

  it("代理没开：当场说连不上，不起 agent、不直连", async () => {
    withSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }));
    const r = await runLocalTurn(h.svc, input());
    expect(JSON.stringify(r)).toContain("连不上代理");
    expect(h.agents).toHaveLength(0);
  });

  it("settings 坏了：报错，不起 agent", async () => {
    withSettings("{ not json");
    const r = await runLocalTurn(h.svc, input());
    expect(JSON.stringify(r)).toContain("不知道该走哪条代理");
    expect(h.agents).toHaveLength(0);
  });

  it("代理是 Headroom：会话里除了 AutoCrew 还挂上 headroom 的 MCP", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => res.end(JSON.stringify({ service: "headroom-proxy" })));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      withSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: base } }));
      h.svc.deps.findHeadroomBin = () => "/x/headroom";
      const r = await runLocalTurn(h.svc, input());
      expect(r.ok).toBe(true);
      expect(h.agents[0].mcp?.extra).toEqual([{ name: "headroom", command: "/x/headroom", args: ["mcp", "serve", "--proxy-url", base] }]);
    } finally {
      server.close();
    }
  });
});
