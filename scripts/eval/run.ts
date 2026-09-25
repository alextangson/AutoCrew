/**
 * 真宿主一次跑（P6-e）：`claude -p` 无头会话，加载创始人真实的个人技能与 MCP 说明，
 * MCP 只挂一个 autocrew 转发器，指向本 trial 的临时守护进程。
 *
 * 子进程环境从干净底子起（只留 HOME/PATH 这类），不继承当前桌面会话注入的
 * CLAUDE_CODE_* / 消息通道 / 会话 id——否则子会话会挂到父会话的通道上。
 * Bash / Write / Edit 被显式拒绝：用户全局设置放行了 Bash(*)，而这里的红线是
 * 生产守护进程与 ~/.autocrew 一律不碰；只读工具与 Skill 保留，但 eval 自己的文件读不到。
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { REPO_ROOT, type Daemon } from "./daemon.js";
import { EVAL_ROOT } from "./world.js";

export const RUN_TIMEOUT_MS = 12 * 60_000;
export const DENIED_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit"];
/**
 * 读拒绝（对 Read / Grep / Glob 都生效）：eval 不许帮模型——试跑时有 trial 翻到了 scripts/eval
 * 里的场景与不变量；另外生产数据目录一律不读，记录目录（seed/transcript/grade/令牌）不给看。
 */
export const DENIED_READS = [
  `${REPO_ROOT}/scripts/eval/**`,
  `${REPO_ROOT}/docs/evals/**`,
  `${os.homedir()}/.autocrew/**`,
  `${EVAL_ROOT}/*/*.*`,
  `${EVAL_ROOT}/*/*-t*/**`,
  `${EVAL_ROOT}/probe/**`,
].map((abs) => `Read(/${abs})`);
const KEEP_ENV = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"];

export interface RunOptions {
  prompt: string;
  trialDir: string;
  daemon: Pick<Daemon, "port" | "dataDir" | "token">;
  maxTurns?: number;
  timeoutMs?: number;
  extraArgs?: string[];
}

export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  transcriptPath: string;
  /** stream-json 的最后一条 result 事件（modelUsage / num_turns / total_cost_usd / session_id） */
  result: Record<string, any> | null;
  args: string[];
  stderrTail: string;
}

function autocrewEnv(d: RunOptions["daemon"]): Record<string, string> {
  return { AUTOCREW_DATA_DIR: d.dataDir, AUTOCREW_PORT: String(d.port), AUTOCREW_TOKEN: d.token };
}

function childEnv(d: RunOptions["daemon"]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KEEP_ENV) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...autocrewEnv(d) };
}

async function writeMcpConfig(o: RunOptions): Promise<string> {
  const file = path.join(o.trialDir, "mcp-config.json");
  const config = {
    mcpServers: {
      autocrew: { command: "node", args: [path.join(REPO_ROOT, "bin", "autocrew.mjs"), "mcp"], env: autocrewEnv(o.daemon) },
    },
  };
  await fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return file;
}

export function claudeArgs(prompt: string, mcpConfig: string, maxTurns?: number, extra: string[] = []): string[] {
  return [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--allowedTools", "mcp__autocrew__*",
    "--disallowedTools", [...DENIED_TOOLS, ...DENIED_READS].join(","),
    "--permission-mode", "acceptEdits",
    "--no-session-persistence",
    ...(maxTurns ? ["--max-turns", String(maxTurns)] : []),
    ...extra,
  ];
}

/** 从 stream-json 里取最后一条 result 事件 */
export function lastResultEvent(raw: string): Record<string, any> | null {
  let found: Record<string, any> | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      if (event.type === "result") found = event;
    } catch { /* 半行 */ }
  }
  return found;
}

export async function runClaude(o: RunOptions): Promise<RunOutcome> {
  const mcpConfig = await writeMcpConfig(o);
  const args = claudeArgs(o.prompt, mcpConfig, o.maxTurns, o.extraArgs);
  const transcriptPath = path.join(o.trialDir, "transcript.jsonl");
  const out = createWriteStream(transcriptPath);
  const started = Date.now();
  const child = spawn("claude", args, { cwd: REPO_ROOT, env: childEnv(o.daemon), stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stderr = "";
  child.stdout!.pipe(out);
  child.stderr!.on("data", (d) => { stderr = (stderr + String(d)).slice(-4000); });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* 已退 */ }
  }, o.timeoutMs ?? RUN_TIMEOUT_MS);
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  clearTimeout(timer);
  await new Promise<void>((resolve) => out.end(resolve));
  const raw = await fs.readFile(transcriptPath, "utf-8");
  const result = lastResultEvent(raw);
  if (result) await fs.writeFile(path.join(o.trialDir, "result.json"), JSON.stringify(result, null, 2));
  return { exitCode, timedOut, wallMs: Date.now() - started, transcriptPath, result, args: redactArgs(args), stderrTail: stderr };
}

/** 报告里记命令行：提示词太长只留开头 */
function redactArgs(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === "-p" && a.length > 60 ? `${a.slice(0, 60)}…` : a));
}
