/**
 * 对话拍板的请求账（chat-approval §Codex 7，E8）：按 request_id 持久化、绑请求内容的哈希。
 * 同号同内容 → 回放上次结果；同号换内容 → request_conflict。同一个请求号同一时间只有一个调用在走（同步占位）。
 * 改任何东西之前先落账（pending，带要提交的条目 / 代次 / 决定指纹）：提交后、记结果前进程死掉，
 * 重试按这份绑定去稿件的消费记录里找回结果，不看当前的「等你拍板」列表（Codex 审 b44fff09 P2-2）。
 */
import crypto from "node:crypto";
import path from "node:path";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import { readRecord, REQUEST_ID_RE, writeRecord } from "../../video/handoff/pull-store.js";

type Result = Record<string, unknown>;

/** 要提交的那一件：哪条稿、哪件事、哪一代、什么决定、决定指纹（与 decideItem 的消费记录同一算法） */
export interface Binding { content_id: string; item_id: string; gen: string; decision: string; fp: string }

export interface RequestRecord {
  request_id: string;
  payload_hash: string;
  state: "pending" | "committed" | "failed";
  at: string;
  binding?: Binding;
  result?: Result;
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

const ELSEWHERE: Result = { ok: false, code: "already_handled", error: "这件事已在别处处理（记的不是这次的决定），不用再定：重新 list 看现在的样子" };

/** 落了账但没有结果（中途死掉 / 失败过）：按绑定去消费记录里找。找到同一决定 = 提交了；同一代别的决定 = 已在别处处理；都没有 = null（可以再跑） */
export async function recoverRequest(dataDir: string, rec: RequestRecord): Promise<Result | null> {
  const b = rec.binding;
  if (!b) return null;
  const doc = await readProductionDocOrEmpty(b.content_id, dataDir);
  const mine = (doc.inbox_log ?? []).filter((e) => e.item_id === b.item_id && e.gen === b.gen && !e.pending);
  const done = mine.find((e) => e.action === b.decision && e.fp === b.fp)?.result
    // 决定先写、消费记录后写：崩在两者之间时只有决定在，按请求号认
    ?? (() => { const d = doc.decisions.find((x) => x.request_id === rec.request_id); return d ? { decision: d } : undefined; })();
  if (!done && !mine.length) return null;
  const result = done ? { ...done, ok: true, recorded_as: "chat", item_id: b.item_id, gen: b.gen } : ELSEWHERE;
  await writeRequest(dataDir, { ...rec, state: done ? "committed" : "failed", result });
  return { ...result, replayed: true };
}
