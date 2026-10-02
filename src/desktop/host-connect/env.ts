/**
 * 一键接入用到的「这台机器」：家目录、可执行文件搜索路径、App 目录、子进程运行器。
 * 全部可注入——测试用临时 HOME + 假的 claude/codex，绝不碰真实的 ~/.claude.json、~/.codex、~/.workbuddy（spec O12）。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { autocrewEntry, repoRoot, stableNodePath } from "../workbuddy-connect.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** missing = 命令不存在；timeout = 超时被结束；其它 = 起不来的原因 */
  failure?: "missing" | "timeout" | string;
}

export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string; input?: string }) => Promise<RunResult>;

export interface HostEnv {
  home: string;
  /** AutoCrew 本机状态目录（令牌在 <dir>/tokens） */
  dataDir?: string;
  /** 找 claude / codex 的目录，按顺序 */
  binDirs: string[];
  /** 找 Claude.app / WorkBuddy.app 的目录 */
  appDirs: string[];
  /** ~/.claude.json（CLAUDE_CONFIG_DIR 设了就在那下面） */
  claudeConfig: string;
  /** ~/.codex（CODEX_HOME 设了就是它） */
  codexHome: string;
  /** 宿主配置里写的转发器命令 */
  forwarder: { command: string; args: string[]; env: Record<string, string> };
  /** 子进程环境（HOME 固定成上面的 home） */
  childEnv: NodeJS.ProcessEnv;
  run: Runner;
  /** 换一份子进程环境的运行器（握手时叠上条目自己的 env） */
  runWith: (childEnv: NodeJS.ProcessEnv) => Runner;
}

export function makeRunner(childEnv: NodeJS.ProcessEnv): Runner {
  return (cmd, args, opts = {}) => new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    const done = (r: RunResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({ code: null, stdout, stderr, failure: "timeout" }); }, opts.timeoutMs ?? 15_000);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => done({ code: null, stdout, stderr, failure: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : err.message }));
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.on("error", () => { /* 子进程先退出了：结果看 close */ });
    child.stdin.end(opts.input ?? "");
  });
}

/** 真实机器上的默认值。PATH 之外补几处常见安装位置：服务进程从 launchd/启动器起时 PATH 往往很短 */
export function defaultHostEnv(env: NodeJS.ProcessEnv = process.env): HostEnv {
  const home = env.HOME || os.homedir();
  const binDirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  // 子进程（claude / codex / 核对用的转发器）不带服务自己的 AUTOCREW_*：宿主真启动时只有条目里写的那几个，
  // 核对要测的就是这个（Codex 评审 P2-1）
  const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries({ ...env, HOME: home }).filter(([k]) => !k.startsWith("AUTOCREW_")));
  // 检测时从补充目录找到的 codex / claude 常是 `#!/usr/bin/env node` 脚本：子进程 PATH 也得有这些目录和当前 node，
  // 否则 env 找不到 node、退出 127（Codex 评审第 2 轮 P2-a）
  childEnv.PATH = [...new Set([...binDirs, path.dirname(process.execPath)])].join(path.delimiter);
  const entry = autocrewEntry(repoRoot(), stableNodePath(), env, "placeholder");
  // 状态目录与端口总是写明：只设了 AUTOCREW_DATA_DIR 时宿主从桌面起的转发器会去默认目录找令牌，结果 401
  const stateDir = path.resolve(env.AUTOCREW_LOCAL_DIR || env.AUTOCREW_DATA_DIR || path.join(home, ".autocrew"));
  const forwarderEnv = { AUTOCREW_LOCAL_DIR: stateDir, AUTOCREW_PORT: String(Number(env.AUTOCREW_PORT) || 4317) };
  return {
    home,
    binDirs: [...new Set(binDirs)],
    appDirs: ["/Applications", path.join(home, "Applications")],
    claudeConfig: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json"),
    codexHome: env.CODEX_HOME || path.join(home, ".codex"),
    forwarder: { command: entry.command as string, args: entry.args as string[], env: forwarderEnv },
    childEnv,
    run: makeRunner(childEnv),
    runWith: makeRunner,
  };
}

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

export function findOnPath(name: string, env: HostEnv): string | null {
  for (const dir of env.binDirs) {
    const file = path.join(dir, name);
    if (executable(file)) return file;
  }
  return null;
}

function versionKey(v: string): number[] {
  return v.split(/[^0-9]+/).filter(Boolean).map(Number);
}

function newerFirst(a: string, b: string): number {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/**
 * Claude 桌面版自带的 claude：`~/Library/Application Support/Claude/claude-code/<版本>/<哈希>/claude.app/Contents/MacOS/claude`
 * （本机实测的布局）。取版本号最大、能执行的那一个；布局变了就找不到，调用方退回直写配置文件。
 */
export function findDesktopClaude(home: string): string | null {
  const root = path.join(home, "Library", "Application Support", "Claude", "claude-code");
  let versions: string[];
  try { versions = readdirSync(root).sort(newerFirst); } catch { return null; }
  for (const v of versions) {
    let builds: string[];
    try { builds = readdirSync(path.join(root, v)); } catch { continue; }
    for (const b of builds) {
      const file = path.join(root, v, b, "claude.app", "Contents", "MacOS", "claude");
      if (executable(file)) return file;
    }
  }
  return null;
}

export function appInstalled(name: string, env: HostEnv): boolean {
  return env.appDirs.some((d) => existsSync(path.join(d, name)));
}
