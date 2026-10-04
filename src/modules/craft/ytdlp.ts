/**
 * yt-dlp 子进程封装（传播方法规格 §12）：execFile 不经 shell，固定 --ignore-config --skip-download --no-playlist，
 * 每次调用都有超时。错误按「限流 / 超时 / 没装 / 其他」分类，交给抓取编排决定重试还是停。
 */
import { execFile } from "node:child_process";

export type YtdlpErrorKind = "rate_limited" | "timeout" | "missing" | "failed";

export class YtdlpError extends Error {
  constructor(readonly kind: YtdlpErrorKind, message: string) {
    super(message);
  }
}

export interface ExecResult { stdout: string; stderr: string }
/** 一次 yt-dlp 调用；失败一律抛 YtdlpError */
export type YtdlpExec = (args: string[], timeoutMs: number) => Promise<ExecResult>;

export const BASE_ARGS = ["--ignore-config", "--skip-download", "--no-playlist"];

export const INSTALL_HINT = "没找到 yt-dlp：macOS 用 brew install yt-dlp，其他系统见 https://github.com/yt-dlp/yt-dlp#installation";

export function isRateLimited(text: string): boolean {
  return /HTTP Error 429|Too Many Requests/i.test(text);
}

function lastLines(text: string, n = 3): string {
  return text.trim().split("\n").slice(-n).join(" | ").slice(0, 400);
}

export function classify(err: Error & { code?: string | number | null; killed?: boolean; signal?: string | null }, stderr: string, timeoutMs: number): YtdlpError {
  if (err.code === "ENOENT") return new YtdlpError("missing", INSTALL_HINT);
  if (err.killed || err.signal === "SIGTERM") return new YtdlpError("timeout", `yt-dlp 超过 ${Math.round(timeoutMs / 1000)} 秒没返回，已终止`);
  if (isRateLimited(stderr)) return new YtdlpError("rate_limited", "YouTube 限流（HTTP 429）");
  return new YtdlpError("failed", lastLines(stderr) || err.message);
}

export function execYtdlp(bin = "yt-dlp"): YtdlpExec {
  return (args, timeoutMs) => new Promise((resolve, reject) => {
    execFile(bin, [...BASE_ARGS, ...args], { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(classify(err, stderr ?? "", timeoutMs));
      else resolve({ stdout, stderr });
    });
  });
}
