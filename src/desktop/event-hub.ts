/**
 * 引擎事件总线（P1 一期）——经营面板的读模型数据源（PRD-v4 §7.3-1）。
 * 只承载真实事件；观测层：任何失败吞掉，绝不影响执行层。
 * 事件落盘 <dataDir>/events.jsonl（重启可回放，时间戳全真实）；
 * broadcast 由 main.ts 注入（本模块 electron-free，可测）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

export type EngineEventRole = "scout" | "writer" | "review" | "analyst" | "publisher" | "system";

export interface EngineEvent {
  ts: string;
  role: EngineEventRole;
  /** 事件类型标识（work / transition / adoption / publish_receipt / …），过滤用 */
  kind: string;
  /** 人话一行——工作日志的唯一展示字段 */
  label: string;
  contentId?: string;
}

type Broadcast = (e: EngineEvent) => void;

let broadcast: Broadcast = () => {};

export function initEventHub(b: Broadcast): void {
  broadcast = b;
}

export async function emitEngineEvent(e: Omit<EngineEvent, "ts">, dataDir?: string): Promise<EngineEvent> {
  const full: EngineEvent = { ts: new Date().toISOString(), ...e };
  try {
    const dir = getDataDir(dataDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "events.jsonl"), JSON.stringify(full) + "\n", "utf-8");
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
