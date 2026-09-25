/**
 * 引擎熔断（P6 spec §3.9）——死线路不占用等待。
 *
 * 每次模型调用前读 `engine-health.json`（桌面层落的「最后已知状态」）：某条线**最近一次**证据
 * （probe 与 live 取新的那条）是线路级失败、且在 10 分钟内 → 这次不碰它，直接换下一条；
 * 全都熔断 → 立即报 `engine_unavailable`，不再先等一轮超时。窗口过了下一次调用自然再试
 * （半开），成败照常经 health-sink 写回，熔断随之合上或续上。
 *
 * 只读：健康文件的唯一写方是桌面层（src/desktop/engine-health.ts），引擎层不依赖 desktop。
 * 文件缺失/损坏 = 都当健康——观测层不得弄死执行层。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { classifyEngineError } from "./error-kind.js";

export const BREAKER_WINDOW_MS = 10 * 60_000;
const HEALTH_FILE = "engine-health.json";

interface Evidence {
  at?: unknown;
  ok?: unknown;
  error?: unknown;
  lineFault?: unknown;
}

interface ProviderHealth {
  probe?: Evidence | null;
  live?: Evidence | null;
}

/** 熔断全开时抛的错：`code` 与 P5 §6.2 类 A 的 `engine_unavailable` 同名，调用方按它落桌 */
export class EngineUnavailableError extends Error {
  readonly code = "engine_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

/**
 * 线路级故障才进熔断。请求本身的错（上游明确回 4xx 的 400/404/422）换一次调用不一定再犯，
 * 认不出的（unknown）与用户中止也不算——宁可照旧试一次，不拿不确定的证据连坐整条线。
 */
export function isLineFault(err: unknown): boolean {
  const c = classifyEngineError(err);
  if (c.kind === "upstream") return c.status === undefined || c.status >= 500;
  return c.kind !== "unknown" && c.kind !== "aborted";
}

function atMs(e: Evidence | null | undefined): number {
  return e && typeof e.at === "string" ? Date.parse(e.at) : Number.NaN;
}

/** 最近一次证据是窗口内的线路级失败 → 返回原因（熔断）；否则 null（照常尝试） */
export function trippedReason(entry: ProviderHealth | undefined, now: number = Date.now()): string | null {
  const newest = [entry?.probe, entry?.live]
    .filter((e): e is Evidence => Number.isFinite(atMs(e)))
    .sort((a, b) => atMs(b) - atMs(a))[0];
  if (!newest || newest.ok !== false || newest.lineFault === false) return null;
  if (Math.abs(now - atMs(newest)) > BREAKER_WINDOW_MS) return null;
  return typeof newest.error === "string" && newest.error.trim() ? newest.error.trim() : "最近一次调用失败";
}

async function readProviders(dataDir: string): Promise<Record<string, ProviderHealth>> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dataDir, HEALTH_FILE), "utf-8")) as { providers?: unknown };
    const providers = parsed?.providers;
    return providers && typeof providers === "object" ? (providers as Record<string, ProviderHealth>) : {};
  } catch {
    return {};
  }
}

/** 这次调用要跳过哪几条线：端点 id → 原因。没有 dataDir（手工构造的 config）= 不熔断 */
export async function trippedProviders(dataDir: string | undefined, ids: string[], now: number = Date.now()): Promise<Map<string, string>> {
  const tripped = new Map<string, string>();
  if (!dataDir) return tripped;
  const providers = await readProviders(dataDir);
  for (const id of ids) {
    const reason = trippedReason(providers[id], now);
    if (reason) tripped.set(id, reason);
  }
  return tripped;
}

/** 全部熔断：一句话说清哪几条线、为什么、这次没发请求、下一步是什么 */
export function breakerOpenError(tripped: Map<string, string>): EngineUnavailableError {
  const lines = [...tripped].map(([id, reason]) => `${id}：${reason}`).join("；");
  return new EngineUnavailableError(
    `引擎线路都在熔断中（最近 10 分钟内失败过），本次没有发出请求——${lines}。` +
      "修好线路后在设置页点「测试」，或 10 分钟后自动再试",
  );
}
