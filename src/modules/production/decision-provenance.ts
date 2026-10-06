/**
 * 决定的来源（spec 2026-10-06 chat-approval §Codex 10）：对话里经系统弹窗确认的、对话里转述的「还要改」。
 *
 * 为什么不放进参数：参数是调用方填的，模型能写；来源只能由服务端自己的对话确认流程在调用链上挂上（AsyncLocalStorage），
 * 写决定时顺手带进同一次 push，不事后补。网页 / 工作台的决定不挂，照旧是 "founder"。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface DecisionProvenance {
  source: "chat-dialog" | "chat-reported";
  /** 创始人在对话里的原话（chat-reported 时是 agent 转述，未经核验） */
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
