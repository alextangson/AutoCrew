/**
 * 引擎事件总线（P1 一期）——经营面板的读模型数据源（PRD-v4 §7.3-1）。
 * 只承载真实事件；观测层：任何失败吞掉，绝不影响执行层。
 * 事件落盘 <dataDir>/events.jsonl（重启可回放，时间戳全真实）；
 * broadcast 由 main.ts 注入（本模块 electron-free，可测）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

/** editor = 剪辑师（视频生产线入职，视频 spec §8.4）；与 chat-router 的席位名同一套 */
export type EngineEventRole = "scout" | "writer" | "review" | "analyst" | "publisher" | "editor" | "system";

export interface EngineEvent {
  ts: string;
  role: EngineEventRole;
  /** 事件类型标识（work / transition / adoption / publish_receipt / run_done / …），过滤用 */
  kind: string;
  /** 人话一行——工作日志的唯一展示字段 */
  label: string;
  contentId?: string;
  /** 任务归属（IA v4.2 任务动态带）：同一 chat turn / 调度批次的事件共享一个 runId，前端按此聚合成任务卡 */
  runId?: string;
  /**
   * 自动回流事件（kind="metrics_pull"）的结构化载荷（回流 spec §4.4）：
   * label 是给人看的一行话，这里是给前端看的——据此定位是哪家平台、要不要刷那一行。
   */
  metricsPull?: { platform: string; status: string; rowCount?: number };
}

type Broadcast = (e: EngineEvent) => void;

let broadcast: Broadcast = () => {};

export function initEventHub(b: Broadcast): void {
  broadcast = b;
}

export interface EmitOptions {
  /**
   * 落 events.jsonl 吗？缺省 true = 今天的行为。
   * `false` 用于**只报「变了」**的推送（引擎健康 kind:"engine_health"）：每次模型调用都记一行
   * 会把工作日志淹掉，而那条推送的全部价值就是让前端重拉一次通道。
   */
  persist?: boolean;
}

export async function emitEngineEvent(
  e: Omit<EngineEvent, "ts">,
  dataDir?: string,
  opts: EmitOptions = {},
): Promise<EngineEvent> {
  const full: EngineEvent = { ts: new Date().toISOString(), ...e };
  try {
    if (opts.persist !== false) {
      const dir = getDataDir(dataDir);
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(path.join(dir, "events.jsonl"), JSON.stringify(full) + "\n", "utf-8");
    }
  } catch {
    /* 观测层不得破坏执行层 */
  }
  try {
    broadcast(full);
  } catch {
    /* 同上 */
  }
  return full;
}

export async function readRecentEvents(dataDir?: string, limit = 50): Promise<EngineEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(getDataDir(dataDir), "events.jsonl"), "utf-8");
  } catch {
    return [];
  }
  const events: EngineEvent[] = [];
  for (const line of raw.split("\n").filter(Boolean).slice(-limit * 2)) {
    try {
      const parsed = JSON.parse(line) as EngineEvent;
      if (parsed && typeof parsed.ts === "string" && typeof parsed.label === "string") events.push(parsed);
    } catch {
      /* 坏行跳过 */
    }
  }
  return events.slice(-limit);
}
