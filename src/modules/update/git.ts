/** 跑 git：带超时、不弹凭证输入；失败带上 stderr 原文，调用方决定怎么说人话。 */
import { execFile } from "node:child_process";

export interface GitResult { ok: boolean; stdout: string; stderr: string; timedOut?: boolean }
export type GitRunner = (args: string[], opts?: { timeoutMs?: number }) => Promise<GitResult>;

export function gitRunner(cwd: string): GitRunner {
  return (args, opts = {}) => new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    }, (err, stdout, stderr) => {
      const killed = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")), ...(killed ? { timedOut: true } : {}) });
    });
  });
}

export function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
