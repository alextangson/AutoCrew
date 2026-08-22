/**
 * 子进程原语（设计 spec §4.3 ASR sidecar、§6.1 render CLI、§5 ffmpeg 共用）。
 *
 * 管线里每一次外部调用都经过这里，四条纪律因此只写一遍：
 *
 * 1. **自成进程组 + 杀树**：`detached: true` 让子进程当组长，超时时 `kill(-pid)` 连它
 *    fork 出来的孙子一起收走。ffmpeg/uv/npm 都会再起子进程，只杀父的话孙子会继续吃 CPU
 *    直到天荒地老（渲染尤其贵）。
 * 2. **SIGTERM 先礼后兵**：给 3 秒收尾（ffmpeg 会写完当前帧并关文件），到点再 SIGKILL。
 * 3. **stderr 环形截断 256KB**：崩溃栈动辄几 MB，全量进 job 台账会把 jobs.jsonl 撑爆；
 *    只留尾部——错误原因永远在最后。
 * 4. **spawn 失败不是异常，是结果**：命令不存在（未装 uv / 未装 ffmpeg）是可预期状态，
 *    调用方要把它翻成人话指引，所以 `spawnError` 走返回值而不是 throw。
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { runLoop } from "../../engine/loop.js";

/**
 * 全线 DI 口子。`spawnImpl` 与 `node:child_process.spawn` 签名兼容（测试注入假进程）；
 * `runLoopImpl` 是 V0b 粗剪的模型调用口——测试一律注入假实现，绝不真调模型。
 */
export interface VideoDeps {
  spawnImpl?: typeof spawn;
  nowImpl?: () => number;
  runLoopImpl?: typeof runLoop;
}

export function nowMs(deps?: VideoDeps): number {
  return (deps?.nowImpl ?? Date.now)();
}

export function nowIso(deps?: VideoDeps): string {
  return new Date(nowMs(deps)).toISOString();
}

/** 仓库根：本文件在 src/modules/video/ 下 */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const STDERR_RING_BYTES = 256 * 1024;
const KILL_GRACE_MS = 3000;

// ---------------------------------------------------------------------------
// 缓冲
// ---------------------------------------------------------------------------

interface RingBuffer {
  push(chunk: string): void;
  read(): string;
}

/** 只留尾部；截断过就在开头标一行，免得读的人以为日志本来就这么短 */
function createRingBuffer(limitBytes: number): RingBuffer {
  let text = "";
  let truncated = false;
  return {
    push(chunk) {
      text += chunk;
      if (text.length > limitBytes) {
        text = text.slice(text.length - limitBytes);
        truncated = true;
      }
    },
    read() {
      return truncated ? `…（前面 ${limitBytes} 字节以外的输出已截断）\n${text}` : text;
    },
  };
}

/** 按行切分流式 chunk；最后一段不完整的留着等下一块 */
function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = "";
  return (chunk: string) => {
    pending += chunk;
    let idx = pending.indexOf("\n");
    while (idx !== -1) {
      const line = pending.slice(0, idx).trim();
      pending = pending.slice(idx + 1);
      if (line) onLine(line);
      idx = pending.indexOf("\n");
    }
  };
}

// ---------------------------------------------------------------------------
// 杀树
// ---------------------------------------------------------------------------

/** 先杀进程组（detached 的子进程自成一组），组不在了退回杀单进程 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* 组已消失，或平台不支持组信号：退回单进程 */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* 已退出 */
  }
}

// ---------------------------------------------------------------------------
// runProcess
// ---------------------------------------------------------------------------

export interface RunProcessOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 缺省不超时。超时 = SIGTERM → 3 秒 → SIGKILL，结果里 timedOut=true */
  timeoutMs?: number;
  /** 停机信号：abort 等同于立刻超时（温柔杀，不留孤儿进程） */
  abortSignal?: AbortSignal;
  /** stdout 逐行回调（JSON lines 协议用）。全量 stdout 同样会被环形截断后返回 */
  onStdoutLine?: (line: string) => void;
  stderrLimitBytes?: number;
  spawnImpl?: typeof spawn;
}

export interface RunProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** 命令根本没起来（ENOENT 等）。此时 code 为 null */
  spawnError?: string;
  durationMs: number;
}

interface RunState {
  timedOut: boolean;
  aborted: boolean;
  killTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
}

/** 超时/停机的统一动作：先 TERM，3 秒后 KILL 兜底 */
function scheduleKill(child: ChildProcess, state: RunState): void {
  killTree(child, "SIGTERM");
  state.graceTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
}

export function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const startedAt = Date.now();
  return new Promise<RunProcessResult>((resolve) => {
    const stdoutBuf = createRingBuffer(STDERR_RING_BYTES);
    const stderrBuf = createRingBuffer(opts.stderrLimitBytes ?? STDERR_RING_BYTES);
    const state: RunState = { timedOut: false, aborted: false };
    let settled = false;
    let child: ChildProcess;

    const finish = (partial: Partial<RunProcessResult>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(state.killTimer);
      clearTimeout(state.graceTimer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        code: null,
        signal: null,
        stdout: stdoutBuf.read(),
        stderr: stderrBuf.read(),
        timedOut: state.timedOut,
        aborted: state.aborted,
        durationMs: Date.now() - startedAt,
        ...partial,
      });
    };
    const onAbort = (): void => {
      state.aborted = true;
      scheduleKill(child, state);
    };

    try {
      child = spawnImpl(opts.command, [...opts.args], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      finish({ spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }

    const feedLine = opts.onStdoutLine ? createLineSplitter(opts.onStdoutLine) : null;
    child.stdout?.on("data", (chunk: unknown) => {
      const text = String(chunk);
      stdoutBuf.push(text);
      feedLine?.(text);
    });
    child.stderr?.on("data", (chunk: unknown) => stderrBuf.push(String(chunk)));
    child.on("error", (err: Error) => finish({ spawnError: err.message }));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ code, signal }),
    );

    if (opts.abortSignal?.aborted) onAbort();
    else opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      state.killTimer = setTimeout(() => {
        state.timedOut = true;
        scheduleKill(child, state);
      }, opts.timeoutMs);
    }
  });
}

/** 命令在不在（`<cmd> --version` 起得来就算在）。装没装外部依赖是可见状态，不是异常 */
export async function commandExists(command: string, deps?: VideoDeps): Promise<boolean> {
  const result = await runProcess({
    command,
    args: ["--version"],
    timeoutMs: 10_000,
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  });
  return !result.spawnError;
}

/** stderr 尾部若干行——报错要给「最后发生了什么」，不是开头的 banner */
export function stderrTail(stderr: string, lines = 6): string {
  return stderr
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
}
