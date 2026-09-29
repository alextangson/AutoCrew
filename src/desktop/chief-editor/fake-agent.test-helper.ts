/**
 * 单测用的假 ACP 进程 + 服务装配（真实适配器由 spikes/acp-local-agent 覆盖）。
 * 场景通过 onPrompt 驱动：可以流式吐字、经 MCP 桥调工具、请求权限、模拟崩溃。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalGate } from "../approval-gate.js";
import { resetActiveTurns } from "../turn-registry.js";
import type { AgentHandlers, AgentProcess, ConfigOptionInfo, McpServerSpec, SpawnAgent } from "./acp-process.js";
import type { LaunchSpec } from "./backends.js";
import { handleAgentMcp } from "./mcp-bridge.js";
import { initChiefEditor, resetChiefEditor, type ChiefEditor } from "./service.js";

type Json = Record<string, unknown>;

export class FakeAgent implements AgentProcess {
  pid = undefined;
  command = "fake-agent --acp";
  handlers!: AgentHandlers;
  mcp?: McpServerSpec;
  prompts: string[] = [];
  cancelled = 0;
  killed = 0;
  loadFails = false;
  loaded: string[] = [];
  stderr = "";
  private exit!: (v: { code: number | null; signal: string | null }) => void;
  exited = new Promise<{ code: number | null; signal: string | null }>((r) => { this.exit = r; });
  private cancelWaiters: Array<() => void> = [];

  constructor(public onPrompt: (a: FakeAgent, text: string) => Promise<{ stopReason: string }>) {}

  async initialize() { return { loadSession: true }; }
  /** 适配器上报的配置项（模拟真实 claude-agent-acp 的 model / effort） */
  configOptions: ConfigOptionInfo[] = [
    { id: "model", current: "default", values: [{ value: "default", label: "Default" }, { value: "sonnet", label: "Sonnet" }] },
    { id: "effort", current: "default", values: [{ value: "default", label: "Default" }, { value: "high", label: "High" }] },
  ];
  configSet: Array<[string, string]> = [];
  meta: Record<string, unknown>[] = [];
  rejectConfig?: string;
  async newSession(_cwd: string, mcp: McpServerSpec, meta: Record<string, unknown>) {
    this.mcp = mcp;
    this.meta.push(meta);
    return { sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`, configOptions: this.configOptions };
  }
  async loadSession(id: string, _cwd: string, mcp: McpServerSpec) {
    this.mcp = mcp;
    if (this.loadFails) throw new Error("Resource not found");
    // 真适配器 load 时会把历史重放成 update
    this.say("（历史重放）");
    this.loaded.push(id);
    return { sessionId: id, configOptions: this.configOptions };
  }
  async setConfigOption(_s: string, id: string, value: string) {
    if (this.rejectConfig === value) throw new Error(`model ${value} is not available`);
    this.configSet.push([id, value]);
  }
  async prompt(_s: string, text: string) { this.prompts.push(text); return this.onPrompt(this, text); }
  async cancel() { this.cancelled++; for (const w of this.cancelWaiters.splice(0)) w(); }
  kill() { this.killed++; this.exit({ code: null, signal: "SIGKILL" }); }
  crash(stderr: string) { this.stderr = stderr; this.exit({ code: 1, signal: null }); }
  stderrTail() { return this.stderr; }
  /** 场景用：挂起直到收到 cancel */
  untilCancelled(): Promise<{ stopReason: string }> {
    return new Promise((r) => this.cancelWaiters.push(() => r({ stopReason: "cancelled" })));
  }
  say(text: string) { this.handlers.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }); }
}

export interface Harness {
  svc: ChiefEditor;
  home: string;
  dataDir: string;
  events: Json[];
  mcpCalls: Array<{ request: Json; dataDir: string }>;
  agents: FakeAgent[];
  /** 每次 spawn 收到的启动参数（看代理环境有没有带上） */
  launches: LaunchSpec[];
  gate: ApprovalGate;
  contents: Map<string, { title: string; body: string; platform: string; status: string }>;
  /** 下一次 spawn 用的脚本 */
  script: (a: FakeAgent, text: string) => Promise<{ stopReason: string }>;
  callTool(agent: FakeAgent, name: string, args: Json): Promise<Json>;
  cleanup(): Promise<void>;
}

export async function makeHarness(opts: { launchable?: boolean; askTtlMs?: number; mcpResult?: (req: Json) => Json; claudeSettingsPath?: string } = {}): Promise<Harness> {
  resetActiveTurns();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "chief-editor-home-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chief-editor-data-"));
  const h = { home, dataDir, events: [] as Json[], mcpCalls: [] as Array<{ request: Json; dataDir: string }>, agents: [] as FakeAgent[], launches: [] as LaunchSpec[], gate: new ApprovalGate(), contents: new Map() } as Harness;
  h.script = async () => ({ stopReason: "end_turn" });
  const spawnAgent: SpawnAgent = (launch, _cwd, handlers) => {
    h.launches.push(launch);
    const agent = new FakeAgent((a, t) => h.script(a, t));
    agent.handlers = handlers;
    h.agents.push(agent);
    return agent;
  };
  h.svc = initChiefEditor({
    home,
    mcpUrl: "http://127.0.0.1:4317/mcp",
    spawnAgent,
    // 默认不读这台机器的真 settings：测试不能依赖创始人的代理开没开
    claudeSettingsPath: opts.claudeSettingsPath ?? path.join(home, "no-settings.json"),
    approvals: h.gate,
    emit: (e) => h.events.push(e),
    killGraceMs: 20,
    ...(opts.askTtlMs ? { askTtlMs: opts.askTtlMs } : {}),
    execMcp: async (request, dir) => {
      h.mcpCalls.push({ request, dataDir: dir });
      const body = opts.mcpResult?.(request) ?? { ok: true, message: "done" };
      return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body } };
    },
    getContent: async (id) => h.contents.get(id) ?? null,
  });
  h.callTool = async (agent, name, args) => {
    const binding = h.svc.bindingFor(`Bearer ${agent.mcp!.token}`);
    if (!binding) return { revoked: true };
    const res = await handleAgentMcp(h.svc, binding, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return ((res?.result as Json)?.structuredContent ?? {}) as Json;
  };
  h.cleanup = async () => {
    resetChiefEditor();
    resetActiveTurns();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  };
  return h;
}

/** 等到条件成立（异步事件驱动的场景用） */
export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
