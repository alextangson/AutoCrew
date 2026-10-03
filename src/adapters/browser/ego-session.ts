/**
 * ego lite 通道 —— 数据回流的唯一浏览器连接层（规格 docs/2026-10-03-metrics-pull-on-ego-lite-spec.md）。
 *
 * 机制：后端起 `ego-browser nodejs` 子进程（脚本走 stdin），在 Agent 自己的 TaskSpace 里打开平台后台页，
 * `page.fetch()` 在页面里带登录态请求内部接口，响应原样交回（PageFetchResponse 形状）。
 * 登录态永远留在 ego lite 的 profile，AutoCrew 不提取/不存储 cookie。
 *
 * 一次抓取 = 一个 EgoSession = 一个 TaskSpace；每步一个短命子进程（约 0.1s 启动），按 spaceId 续用同一个
 * TaskSpace。会话有总超时：任何一步超出就杀子进程、记失败；收尾（closeTarget）不受总超时约束，
 * 超时/异常路径也照样 `finish({ keep: [] })`。
 *
 * 输出不是预期 JSON = 通道故障（EgoChannelError），调用方零写入、状态可见，绝不当空数据。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EGO_RESULT_MARKER,
  EGO_SPACE_MARKER,
  evalScript,
  fetchScript,
  finishScript,
  interceptScript,
  openScript,
  pingScript,
} from "./ego-scripts.js";
import type { PullStatus } from "./pull-types.js";

/** 单次抓取总超时：开页 + 登录探测 + 翻页（≤20 页 × 间隔）都在这里面 */
export const EGO_RUN_TIMEOUT_MS = 120_000;
/** 收尾关 TaskSpace 的独立超时：总超时用完了也要关得掉 */
const FINISH_TIMEOUT_MS = 15_000;
/** 单次页面内 fetch 的超时（ego 侧），总超时仍是硬上限 */
const FETCH_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 30_000;

/** 页面内 fetch 的原始结果——判定权归调用方，这里不替它解析 JSON */
export interface PageFetchResponse {
  httpStatus: number;
  /** 跟随重定向后的最终 URL（登录跳转的正向证据） */
  finalUrl: string;
  contentType: string;
  bodyText: string;
}

export interface PageFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** 已序列化的请求体（JSON 字符串） */
  body?: string;
}

/** 通道层故障：状态码与脱敏错误码在抛出处就定好，classifyThrown 原样采信 */
export class EgoChannelError extends Error {
  constructor(
    readonly status: Exclude<PullStatus, "ok">,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EgoChannelError";
  }
}

export interface EgoRunOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** spawn 本身失败（如 ENOENT） */
  spawnError?: string;
}

/** 子进程执行器注入点：测试塞假的，不碰真 ego lite */
export type EgoRunner = (script: string, timeoutMs: number) => Promise<EgoRunOutput>;

/** `ego-browser` 在哪：先 PATH，再 ~/.local/bin（launchd 起的服务 PATH 常不含它） */
export function resolveEgoBinary(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, ".local", "bin"));
  for (const dir of dirs) {
    const candidate = path.join(dir, "ego-browser");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 下一个
    }
  }
  return null;
}

/**
 * 默认执行器：脚本走 stdin；超时整组 SIGKILL 并立刻返回——不等它自己醒，
 * 也不等孙进程攥着的 stdout 关掉（只杀子进程时 close 事件可能永远不来）。
 */
export function spawnEgoRunner(binary: string | null = resolveEgoBinary()): EgoRunner {
  return (script, timeoutMs) =>
    new Promise((resolve) => {
      if (!binary) {
        resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, spawnError: "ENOENT" });
        return;
      }
      const child = spawn(binary, ["nodejs"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
      // 按 Buffer 收、最后整体解码：逐块 String() 会把跨块的中文拆成乱码，JSON 却仍合法（静默坏数据）
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const text = () => ({ stdout: Buffer.concat(outChunks).toString("utf8"), stderr: Buffer.concat(errChunks).toString("utf8") });
      let settled = false;
      const finish = (r: EgoRunOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        finish({ ...text(), exitCode: null, timedOut: true });
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => outChunks.push(d));
      child.stderr.on("data", (d: Buffer) => errChunks.push(d));
      child.on("error", (err) =>
        finish({ ...text(), exitCode: null, timedOut: false, spawnError: (err as NodeJS.ErrnoException).code ?? "spawn_failed" }),
      );
      child.on("close", (code) => finish({ ...text(), exitCode: code, timedOut: false }));
      child.stdin.on("error", () => {});
      child.stdin.end(script);
    });
}

type EgoPayload = Record<string, unknown> & { spaceId?: number };

/** ego-browser 非 TTY 时把脚本的 console 输出转到 stderr（0.5.1 实测），两路都找；取最后一行 */
function findLine(out: EgoRunOutput, marker: string): string | undefined {
  return `${out.stdout}\n${out.stderr}`.split("\n").reverse().find((l) => l.startsWith(marker));
}

/** 子进程正常跑完并给出了结果行 = 脚本自己处理了 TaskSpace 收尾 */
function reportedCleanly(out: EgoRunOutput): boolean {
  return !out.timedOut && !out.spawnError && out.exitCode === 0 && findLine(out, EGO_RESULT_MARKER) !== undefined;
}

function reportedSpaceId(out: EgoRunOutput): number | null {
  const line = findLine(out, EGO_SPACE_MARKER);
  const id = line ? Number(line.slice(EGO_SPACE_MARKER.length)) : NaN;
  return Number.isInteger(id) ? id : null;
}

/**
 * 子进程输出 → 结果对象。判定顺序：起不来 → 超时 → 找不到结果行 → 结果行坏 → 脚本内报错。
 * 脚本内报错的 message 只用于归类（classifyThrown），永不进 errorCode。
 */
export function parseEgoOutput(out: EgoRunOutput): EgoPayload {
  if (out.spawnError) {
    const missing = out.spawnError === "ENOENT";
    throw new EgoChannelError("browser_unreachable", missing ? "ego_missing" : "ego_spawn_failed", `ego-browser 起不来:${out.spawnError}`);
  }
  if (out.timedOut) throw new EgoChannelError("timeout", "ego_timeout", "ego lite 子进程超时,已杀掉");
  const line = findLine(out, EGO_RESULT_MARKER);
  if (!line) {
    if (out.exitCode !== 0) throw new EgoChannelError("browser_unreachable", "ego_unreachable", `ego-browser 退出码 ${out.exitCode}`);
    throw new EgoChannelError("error", "ego_bad_output", "ego-browser 没有给出结果行");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(line.slice(EGO_RESULT_MARKER.length));
  } catch {
    throw new EgoChannelError("error", "ego_bad_output", "ego-browser 结果行不是 JSON");
  }
  if (typeof payload !== "object" || payload === null || typeof (payload as { ok?: unknown }).ok !== "boolean") {
    throw new EgoChannelError("error", "ego_bad_output", "ego-browser 结果行缺 ok 字段");
  }
  const p = payload as EgoPayload & { ok: boolean; stage?: string; error?: string };
  if (p.ok) {
    // 结果行说成功、进程却没正常退出（被杀 / 崩溃）：不采信，如实报异常（AGENTS.md：外部调用失败要可见）
    if (out.exitCode !== 0) throw new EgoChannelError("error", "ego_abnormal_exit", `ego-browser 结果后异常退出(${out.exitCode})`);
    return p;
  }
  if (p.stage === "connect") throw new EgoChannelError("browser_unreachable", "ego_unreachable", `连不上 ego lite:${p.error ?? ""}`);
  throw new Error(`ego 脚本内异常:${p.error ?? "unknown"}`);
}

export interface EgoSessionOptions {
  runner?: EgoRunner;
  /** 总超时（毫秒），默认 EGO_RUN_TIMEOUT_MS */
  totalTimeoutMs?: number;
  /** TaskSpace 名字前缀里的平台标识（ego lite 里看得出是谁开的） */
  label: string;
  now?: () => number;
}

/** 抖音旁听结果 */
export interface InterceptResult {
  matched: number;
  bodies: string[];
  domText: string | null;
}

/**
 * 一次抓取的会话。能力面与旧 CDP 会话对齐：openTab / eval / fetch / closeTarget / close，
 * 抓取器的判定逻辑不用改。tab 的 targetId/sessionId 都是 TaskSpace 的 spaceId。
 */
export class EgoSession {
  private readonly runner: EgoRunner;
  private readonly deadline: number;
  private readonly now: () => number;
  private readonly spaceName: string;
  /** 同一会话多次开页(公众号超时重开)各用一个新名字:taskSpace(name) 遇同名会复用 */
  private opened = 0;

  constructor(opts: EgoSessionOptions) {
    this.runner = opts.runner ?? spawnEgoRunner();
    this.now = opts.now ?? Date.now;
    this.deadline = this.now() + (opts.totalTimeoutMs ?? EGO_RUN_TIMEOUT_MS);
    this.spaceName = `autocrew-数据回流-${opts.label}-${this.now()}`;
  }

  private remaining(): number {
    const left = this.deadline - this.now();
    if (left <= 0) throw new EgoChannelError("timeout", "ego_timeout", "单次抓取总超时");
    return left;
  }

  private async exec(script: string, timeoutMs = this.remaining()): Promise<EgoPayload> {
    return parseEgoOutput(await this.runner(script, timeoutMs));
  }

  /** 剩余总时长是否还够再试一步（公众号导航超时重开用） */
  hasTimeLeft(): boolean {
    return this.deadline - this.now() > 0;
  }

  /**
   * 会自己建 TaskSpace 的一步（开页 / 旁听）。子进程没正常收尾（被杀 / 崩溃 / 无结果行）时，
   * 父进程按它先报出的 spaceId 另起子进程 finish（独立超时）；没报出 spaceId 就不猜，把「没能兜底」写进错误码。
   */
  private async execOwning(script: string, timeoutMs = this.remaining()): Promise<EgoPayload> {
    const out = await this.runner(script, timeoutMs);
    try {
      return parseEgoOutput(out);
    } catch (err) {
      if (reportedCleanly(out) || out.spawnError) throw err;
      const spaceId = reportedSpaceId(out);
      if (spaceId !== null) {
        await this.closeTarget(String(spaceId));
        throw err;
      }
      if (err instanceof EgoChannelError) throw new EgoChannelError(err.status, `${err.code}:cleanup_skipped_no_space_id`, err.message);
      throw err;
    }
  }

  async openTab(url: string): Promise<{ targetId: string; sessionId: string }> {
    const timeoutMs = this.remaining();
    this.opened += 1;
    const out = await this.execOwning(openScript({ space: `${this.spaceName}-${this.opened}`, url, timeoutMs: Math.min(timeoutMs, NAV_TIMEOUT_MS) }), timeoutMs);
    if (typeof out.spaceId !== "number") throw new EgoChannelError("error", "ego_bad_output", "开页结果缺 spaceId");
    const id = String(out.spaceId);
    return { targetId: id, sessionId: id };
  }

  async eval(expression: string, sessionId: string, _awaitPromise = false): Promise<unknown> {
    const out = await this.exec(evalScript({ space: Number(sessionId), expression }));
    return out.value;
  }

  async fetch(url: string, init: PageFetchInit, sessionId: string): Promise<PageFetchResponse> {
    const timeout = Math.min(this.remaining(), FETCH_TIMEOUT_MS);
    const out = await this.exec(
      fetchScript({
        space: Number(sessionId),
        url,
        init: { method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }), timeout },
      }),
    );
    const r = out.response as Partial<PageFetchResponse> | undefined;
    if (!r || typeof r.httpStatus !== "number" || typeof r.bodyText !== "string") {
      throw new EgoChannelError("error", "ego_bad_output", "页面内 fetch 返回形状异常(缺 httpStatus/bodyText)");
    }
    return { httpStatus: r.httpStatus, finalUrl: String(r.finalUrl ?? url), contentType: String(r.contentType ?? ""), bodyText: r.bodyText };
  }

  /** 关 TaskSpace：独立超时，不吃总超时（超时路径更要关）；关失败不掩盖抓取结论 */
  async closeTarget(targetId: string): Promise<void> {
    await this.exec(finishScript({ space: Number(targetId) }), FINISH_TIMEOUT_MS).catch(() => {});
  }

  /** 抖音旁听：单个子进程内开页、收包、关 TaskSpace */
  async intercept(p: { url: string; patterns: string[]; waitMs: number; settleMs: number }): Promise<InterceptResult> {
    const out = await this.execOwning(interceptScript({ space: this.spaceName, ...p }));
    if (typeof out.matched !== "number" || !Array.isArray(out.bodies)) {
      throw new EgoChannelError("error", "ego_bad_output", "旁听结果形状异常");
    }
    return {
      matched: out.matched,
      bodies: out.bodies.filter((b): b is string => typeof b === "string"),
      domText: typeof out.domText === "string" ? out.domText : null,
    };
  }

  close(): void {
    // 子进程都是一步一个、跑完即退；TaskSpace 由 closeTarget 关。这里无事可做，保留与旧会话一致的收尾口
  }
}

/** doctor 用：`ego-browser` 在不在、连不连得上 ego lite */
export async function probeEgoLite(
  runner: EgoRunner = spawnEgoRunner(),
  binary: string | null = resolveEgoBinary(),
): Promise<{ binary: string | null; reachable: boolean; reason?: string; fix?: string }> {
  if (!binary) {
    return { binary, reachable: false, reason: "找不到 ego-browser 命令", fix: "安装并打开 ego lite（https://lite.ego.app/），完成首次引导后 ego-browser 会出现在 ~/.local/bin" };
  }
  try {
    await parseEgoOutput(await runner(pingScript(), 20_000));
    return { binary, reachable: true };
  } catch (err) {
    const code = err instanceof EgoChannelError ? err.code : "exception";
    return { binary, reachable: false, reason: `连不上 ego lite（${code}）`, fix: "打开 ego lite 应用并保持运行，再重跑 autocrew doctor" };
  }
}
