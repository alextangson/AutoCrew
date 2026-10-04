/**
 * Codex 审稿的运行器与输出校验（实现规格 · Codex 审稿）。专用，不和生图共用代码：
 * `codex exec` 只读沙箱、--skip-git-repo-check，提示词走 stdin；stdout / stderr 分开收、各有上限；8 分钟超时。
 * 输出必须是严格 JSON：三项结论 + 最多 8 条建议；「不过」必须逐字引原文，引文在稿里找不到就算非法。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const REVIEW_TIMEOUT_MS = 8 * 60_000;
export const OUTPUT_CAP = 256 * 1024;
export const MAX_ADVISORIES = 8;

export interface CodexRunOutput { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }
export type CodexRunner = (prompt: string, opts: { timeoutMs: number }) => Promise<CodexRunOutput>;

export interface ReviewVerdict { verdict: "pass" | "fail"; reason: string; quotes: string[] }
export interface ReviewResult { main_line: ReviewVerdict; payoff: ReviewVerdict; opening: ReviewVerdict; advisories: Array<{ text: string; quote?: string }> }
export interface ReviewFailure { code: string; message: string; detail?: string }

function capped(chunks: Buffer[], size: { n: number }, chunk: Buffer): void {
  if (size.n >= OUTPUT_CAP) return;
  const room = OUTPUT_CAP - size.n;
  chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
  size.n += Math.min(room, chunk.length);
}

/** 默认运行器：真的拉起本机 codex。cwd 是一个空临时目录，只读沙箱里它碰不到资料库 */
export const runCodexExec: CodexRunner = async (prompt, { timeoutMs }) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-codex-review-"));
  const lastFile = path.join(cwd, "last-message.txt");
  try {
    const run = await new Promise<CodexRunOutput>((resolve) => {
      const child = spawn("codex", ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-o", lastFile, "-"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [], err: Buffer[] = [];
      const outSize = { n: 0 }, errSize = { n: 0 };
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.stdout.on("data", (c: Buffer) => capped(out, outSize, c));
      child.stderr.on("data", (c: Buffer) => capped(err, errSize, c));
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: (e as NodeJS.ErrnoException).code ?? e.message }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut }); });
      child.stdin.on("error", () => { /* 子进程先退出时写管道会 EPIPE：结果由 close 事件交代 */ });
      child.stdin.end(prompt);
    });
    // 最后一条消息单独落文件（-o）：stdout 里可能夹着进度文字，有文件就以文件为准
    const last = await fs.readFile(lastFile, "utf8").catch(() => "");
    return last.trim() ? { ...run, stdout: last.slice(0, OUTPUT_CAP) } : run;
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
};

const tail = (s: string, n = 600) => (s.length > n ? `…${s.slice(-n)}` : s).trim();

/** 进程层面的失败：没装、超时、没登录、非零退出。null = 进程正常结束，接着看输出 */
export function classifyRun(run: CodexRunOutput): ReviewFailure | null {
  if (run.spawnError) {
    return run.spawnError === "ENOENT"
      ? { code: "codex_missing", message: "找不到 codex 命令：本机没装 Codex CLI，或它不在 PATH 里" }
      : { code: "codex_spawn_failed", message: `codex 启动失败：${run.spawnError}` };
  }
  if (run.timedOut) return { code: "codex_timeout", message: `Codex 审稿超过 ${REVIEW_TIMEOUT_MS / 60_000} 分钟没跑完，已停掉`, detail: tail(run.stderr) };
  if (run.code === 0) return null;
  const text = `${run.stderr}\n${run.stdout}`;
  if (/not logged in|log ?in|unauthori[sz]ed|\b401\b/i.test(text)) return { code: "codex_not_logged_in", message: "Codex 没登录：在终端跑 codex login 后再审", detail: tail(text) };
  return { code: "codex_failed", message: `codex 退出码 ${run.code}`, detail: tail(text) };
}

const squash = (s: string) => s.replace(/\s+/g, "");

function verdictOf(raw: unknown, name: string, body: string, errors: string[]): ReviewVerdict | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") { errors.push(`缺少 ${name}`); return null; }
  if (o.verdict !== "pass" && o.verdict !== "fail") { errors.push(`${name}.verdict 只能是 pass 或 fail`); return null; }
  if (typeof o.reason !== "string" || !o.reason.trim()) { errors.push(`${name}.reason 不能为空`); return null; }
  const quotes = Array.isArray(o.quotes) ? o.quotes.filter((q): q is string => typeof q === "string" && q.trim() !== "") : [];
  if (o.verdict === "fail" && !quotes.length) errors.push(`${name} 判不过却没有逐字引原文`);
  for (const q of quotes) if (!squash(body).includes(squash(q))) errors.push(`${name} 的引文在稿里找不到：「${q.slice(0, 30)}」`);
  return { verdict: o.verdict, reason: o.reason.trim(), quotes };
}

function advisoriesOf(raw: unknown, body: string, errors: string[]): ReviewResult["advisories"] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { errors.push("advisories 必须是数组"); return []; }
  if (raw.length > MAX_ADVISORIES) errors.push(`advisories 最多 ${MAX_ADVISORIES} 条，给了 ${raw.length} 条`);
  const out: ReviewResult["advisories"] = [];
  for (const a of raw.slice(0, MAX_ADVISORIES)) {
    const o = a as Record<string, unknown> | null;
    if (!o || typeof o.text !== "string" || !o.text.trim()) { errors.push("每条建议要有 text"); continue; }
    const quote = typeof o.quote === "string" && o.quote.trim() ? o.quote : undefined;
    if (quote && !squash(body).includes(squash(quote))) errors.push(`建议的引文在稿里找不到：「${quote.slice(0, 30)}」`);
    out.push({ text: o.text.trim(), ...(quote ? { quote } : {}) });
  }
  return out;
}

/** 严格校验 Codex 的最后输出；不合格回原因（用于重试一次时告诉它） */
export function parseReview(stdout: string, body: string): { ok: true; result: ReviewResult } | { ok: false; error: string } {
  const start = stdout.indexOf("{"), end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "输出里没有 JSON 对象" };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>; } catch (e) { return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }; }
  const errors: string[] = [];
  const main = verdictOf(parsed.main_line, "main_line", body, errors);
  const payoff = verdictOf(parsed.payoff, "payoff", body, errors);
  const opening = verdictOf(parsed.opening, "opening", body, errors);
  const advisories = advisoriesOf(parsed.advisories, body, errors);
  if (errors.length || !main || !payoff || !opening) return { ok: false, error: errors.join("；") };
  return { ok: true, result: { main_line: main, payoff, opening, advisories } };
}

let template: string | null = null;
export async function buildReviewPrompt(body: string, rules: string[], angle: string): Promise<string> {
  template ??= await fs.readFile(new URL("./codex-review-prompt.md", import.meta.url), "utf8");
  return template
    .replace("{{RULES}}", () => rules.length ? rules.map((r) => `- ${r}`).join("\n") : "（档案里还没有规则）")
    .replace("{{ANGLE}}", () => angle || "（这篇没记立意）")
    .replace("{{BODY}}", () => body);
}
