/**
 * 对话拍板的请求账（chat-approval §Codex 7，E8）：按 request_id 持久化、绑请求内容的哈希。
 * 同号同内容 → 回放上次结果；同号换内容 → request_conflict。同一个请求号同一时间只有一个调用在走（同步占位）。
 * 只记有结果的请求：提交后、记账前进程死掉，重试会再交 decideItem，它按「这件事这一代 + 同一决定指纹」回放已消费的结果，不会记两次。
 */
import crypto from "node:crypto";
import path from "node:path";
import { readRecord, REQUEST_ID_RE, writeRecord } from "../../video/handoff/pull-store.js";

type Result = Record<string, unknown>;

export interface RequestRecord {
  request_id: string;
  payload_hash: string;
  state: "committed" | "refused";
  at: string;
  item_id: string;
  decision: string;
  result: Result;
}

export const isRequestId = (id: string) => REQUEST_ID_RE.test(id);

export function payloadHash(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  return crypto.createHash("sha256").update(JSON.stringify(keys.map((k) => [k, payload[k]]))).digest("hex").slice(0, 32);
}

function requestPath(dataDir: string, id: string): string {
  if (!isRequestId(id)) throw new Error("request_id 只能是 1–100 位字母、数字、-、_");
  return path.join(dataDir, "review-chat", "requests", `${id}.json`);
}

export const readRequest = (dataDir: string, id: string) => readRecord<RequestRecord>(requestPath(dataDir, id));
export const writeRequest = (dataDir: string, rec: RequestRecord) => writeRecord(requestPath(dataDir, rec.request_id), rec);

const claimed = new Set<string>();

/** 同步占住请求号（任何 await 之前调）：同号并发的第二个调用直接 busy */
export function claimRequest(id: string): boolean {
  if (claimed.has(id)) return false;
  claimed.add(id);
  return true;
}

export function releaseRequest(id: string): void {
  claimed.delete(id);
}

export type Prior = { kind: "new" } | { kind: "replay"; result: Result } | { kind: "conflict" };

export async function priorRequest(dataDir: string, id: string, hash: string): Promise<Prior> {
  const rec = await readRequest(dataDir, id);
  if (!rec) return { kind: "new" };
  if (rec.payload_hash !== hash) return { kind: "conflict" };
  return { kind: "replay", result: { ...rec.result, replayed: true } };
}
