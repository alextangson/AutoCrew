/**
 * 真实调用的健康回执出口（P2 spec §4.1「runLoop 每次真实调用成功/失败写 live」）。
 *
 * 为什么是一个 setter 而不是 import：engine 层**不许**依赖 desktop 层（MCP 与 dsh 也跑
 * 同一份引擎，它们没有 IPC 通道也没有 SSE）。所以引擎只管把「哪个端点、哪个岗位、
 * 成没成」喊出来，接不接、往哪落由装配方（desktop/server.ts）决定；没人接 = 什么都不发生。
 *
 * 观测层纪律：sink 抛错一律吞掉——健康记录写不进去不该让写稿失败。
 */

export interface EngineLiveRecord {
  /** 端点 id（config.activeProvider.id；备用腿是备用端点的 id） */
  providerId: string;
  ok: boolean;
  /** 岗位名（writer/reviewer/scout/analytics/main/chat/probe） */
  role: string;
  /** 这次调用归属的任务/运行 id（run-log 的 runId），定位用 */
  jobId?: string;
  /** 失败原因原文（翻译在消费侧做——引擎层不认识 UI 的口径） */
  error?: string;
  /**
   * 仅失败时有：是不是线路级故障（P6 §3.9 熔断只认这种）。false = 请求本身的错
   * （400 内容过滤/超长、404 模型名），线路是通的，不该连坐同一条线上的别的调用。
   */
  lineFault?: boolean;
}

export type EngineHealthSink = (record: EngineLiveRecord) => void;

/**
 * 一次回退或熔断跳过（P6 §3.9）：装配方据此给 `engine-health.json` 的 `fallbacks` 计数。
 * `to:"none"` = 没有端点接手；`skipped` = 熔断跳过、没发请求。逐条明细在 run-log。
 */
export interface EngineFallbackRecord {
  from: string;
  to: string;
  reason: string;
  skipped: boolean;
}

export type EngineFallbackSink = (record: EngineFallbackRecord) => void;

let sink: EngineHealthSink | undefined;
let fallbackSink: EngineFallbackSink | undefined;

/** 装配口：传 undefined 卸载（测试收尾用） */
export function setEngineHealthSink(next?: EngineHealthSink): void {
  sink = next;
}

export function recordEngineLive(record: EngineLiveRecord): void {
  if (!sink) return;
  try {
    sink(record);
  } catch {
    /* 观测层不得破坏执行层 */
  }
}

/** 装配口（回退计数）：传 undefined 卸载 */
export function setEngineFallbackSink(next?: EngineFallbackSink): void {
  fallbackSink = next;
}

export function recordEngineFallback(record: EngineFallbackRecord): void {
  if (!fallbackSink) return;
  try {
    fallbackSink(record);
  } catch {
    /* 观测层不得破坏执行层 */
  }
}
