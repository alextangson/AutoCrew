/**
 * 真实 ACP 适配器进程（spec §接法 / §地基 8）。守护进程是 ACP client：
 * detached 起进程（自成进程组，停止时整组杀）、干净环境（不继承宿主会话的 CLAUDE_* 等变量）、
 * stdio ndJson。单测用 AgentProcess 接口注假进程，这个文件只由 spike 与真机覆盖。
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { LaunchSpec, PermissionOptionLike } from "./backends.js";

export interface SessionUpdateLike {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** usage_update：上下文用量；compaction_update：压缩状态 */
  used?: number;
  size?: number;
  compactionId?: string;
}

export interface AgentHandlers {
  onUpdate(update: SessionUpdateLike): void;
  /** 返回选中的 optionId；null = 取消（按拒绝处理） */
  requestPermission(req: { title: string; kind?: string; toolCallId?: string; options: PermissionOptionLike[] }): Promise<string | null>;
}

export interface McpServerSpec {
  url: string;
  token: string;
}

export interface AgentProcess {
  pid?: number;
  command: string;
  initialize(): Promise<{ loadSession: boolean }>;
  newSession(cwd: string, mcp: McpServerSpec, meta: Record<string, unknown>): Promise<SessionInfo>;
  loadSession(sessionId: string, cwd: string, mcp: McpServerSpec, meta: Record<string, unknown>): Promise<SessionInfo>;
  /** 会话配置项（模型 / 思考强度）：适配器上报的 configOptions 里有才设 */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
  prompt(sessionId: string, text: string): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  /** 整个进程组 SIGKILL */
  kill(): void;
  /** 进程退出时落定（崩溃检测） */
  exited: Promise<{ code: number | null; signal: string | null }>;
  stderrTail(): string;
}

export interface ConfigOptionInfo {
  id: string;
  current?: string;
  values: Array<{ value: string; label: string }>;
}

export interface SessionInfo {
  sessionId: string;
  /** 适配器上报的会话配置项（model / effort 等）；没报就是空数组 */
  configOptions: ConfigOptionInfo[];
}

/** ACP configOptions → 只留 select 类型的 {id, current, values}（没上报就空，不编造） */
export function parseConfigOptions(raw: unknown): ConfigOptionInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o): ConfigOptionInfo[] => {
    const opt = o as { id?: unknown; currentValue?: unknown; options?: unknown };
    if (typeof opt.id !== "string" || !Array.isArray(opt.options)) return [];
    const values = (opt.options as Array<{ value?: unknown; name?: unknown }>).flatMap((v) =>
      typeof v?.value === "string" ? [{ value: v.value, label: typeof v.name === "string" ? v.name : v.value }] : []);
    return [{ id: opt.id, ...(typeof opt.currentValue === "string" ? { current: opt.currentValue } : {}), values }];
  });
}

export type SpawnAgent = (launch: LaunchSpec, cwd: string, handlers: AgentHandlers) => AgentProcess;

const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|TERM|TZ|(https?|no|all)_proxy|(HTTPS?|NO|ALL)_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/;

/** 白名单环境：宿主会话的 ANTHROPIC_BASE_URL / CLAUDE_CODE_* 混进来会让适配器认证失败（spike 实测） */
export function cleanAgentEnv(source: NodeJS.ProcessEnv = process.env, home = os.homedir()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && ENV_KEEP.test(k)) env[k] = v;
  const extra = [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  env.PATH = [...new Set([...(env.PATH ?? "").split(":").filter(Boolean), ...extra])].join(":");
  env.HOME = env.HOME ?? home;
  return env;
}

function mcpServers(mcp: McpServerSpec): acp.McpServer[] {
  return [{ type: "http", name: "autocrew", url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }] }];
}

function toolTitle(p: acp.RequestPermissionRequest): string {
  const call = p.toolCall as { title?: string | null; rawInput?: unknown };
  const raw = call.rawInput && typeof call.rawInput === "object" ? JSON.stringify(call.rawInput) : "";
  return [call.title ?? "工具调用", raw].filter(Boolean).join(" ");
}

export const spawnAcpAgent: SpawnAgent = (launch, cwd, handlers) => {
  const child = spawn(launch.command, launch.args, { cwd, env: cleanAgentEnv(), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString("utf-8")).slice(-8000); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (err) => { stderr += `\n${err.message}`; resolve({ code: -1, signal: null }); });
  });
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  const conn = new acp.ClientSideConnection(() => ({
    async requestPermission(p) {
      const optionId = await handlers.requestPermission({ title: toolTitle(p), kind: p.toolCall.kind ?? undefined, toolCallId: p.toolCall.toolCallId, options: p.options });
      return { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } };
    },
    async sessionUpdate(n) {
      handlers.onUpdate(n.update as unknown as SessionUpdateLike);
    },
  }), stream);
  return {
    pid: child.pid,
    command: [launch.command, ...launch.args].join(" "),
    async initialize() {
      const init = await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } } as acp.ClientCapabilities });
      return { loadSession: Boolean(init.agentCapabilities?.loadSession) };
    },
    async newSession(sessionCwd, mcp, meta) {
      const r = await conn.newSession({ cwd: sessionCwd, mcpServers: mcpServers(mcp), _meta: meta });
      return { sessionId: r.sessionId, configOptions: parseConfigOptions(r.configOptions) };
    },
    async loadSession(sessionId, sessionCwd, mcp, meta) {
      const r = await conn.loadSession({ sessionId, cwd: sessionCwd, mcpServers: mcpServers(mcp), _meta: meta });
      return { sessionId, configOptions: parseConfigOptions((r as { configOptions?: unknown } | null)?.configOptions) };
    },
    async setConfigOption(sessionId, configId, value) {
      await conn.setSessionConfigOption({ sessionId, configId, value } as acp.SetSessionConfigOptionRequest);
    },
    async prompt(sessionId, text) {
      const r = await conn.prompt({ sessionId, prompt: [{ type: "text", text }] });
      return { stopReason: r.stopReason };
    },
    async cancel(sessionId) {
      await conn.cancel({ sessionId });
    },
    kill() {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ }
    },
    exited,
    stderrTail: () => stderr,
  };
};
