/**
 * 决定的来源（spec 2026-10-06 chat-approval，修订版）：对话里按创始人原话定的，统一记 `chat`。
 *
 * 为什么不放进参数：参数是调用方填的；来源只由服务端的对话拍板流程在调用链上挂上（AsyncLocalStorage），
 * 写决定时顺手带进同一次 push，不事后补。网页 / 工作台的决定不挂，照旧是 "founder"。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface DecisionProvenance {
  source: "chat";
  /** 创始人在对话里的原话（agent 照抄转述，服务端无法核验） */
  founder_words: string;
  /** 哪个宿主 / 会话发起的（取自 MCP 传输层，不取参数） */
  requested_by: string;
}

const store = new AsyncLocalStorage<DecisionProvenance>();

/** 只给对话确认流程用：在这段调用里写下的决定都带这份来源 */
export function withProvenance<T>(p: DecisionProvenance, fn: () => Promise<T>): Promise<T> {
  return store.run(p, fn);
}

export function currentProvenance(): DecisionProvenance | undefined {
  return store.getStore();
}

/** 合进决定记录的字段：没有挂来源 = 网页 / 工作台，照旧 founder */
export function provenanceFields(): { source: "founder" | DecisionProvenance["source"]; founder_words?: string; requested_by?: string } {
  const p = store.getStore();
  return p ? { source: p.source, founder_words: p.founder_words, requested_by: p.requested_by } : { source: "founder" };
}

/** 对话里定的：`chat`，以及修订前的旧值 chat-dialog / chat-reported（旧记录照旧认） */
export const isChatSource = (source: string | undefined) => source === "chat" || source === "chat-dialog" || source === "chat-reported";
