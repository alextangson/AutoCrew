/**
 * 对话确认的请求账与弹窗位（chat-approval §Codex 7、8，E8、E9）。
 *
 * - 请求记录按 request_id 持久化、绑请求内容的哈希：同号同内容 → 回放上次结果，不再弹窗；同号换内容 → request_conflict。
 * - 弹窗位是进程内的一把全局锁：屏幕上同一时间只有一个对话确认窗；它从不和文件归属锁一起拿。
 *   进程重启后弹窗位自然清空；留在 dialog_open 的旧记录（不是本进程这把锁的主人）按作废处理：
 *   先查这件事这一代有没有已经消费（提交了、回执丢了）→ 回放成提交；没有 → 当作没人点。
 */
import crypto from "node:crypto";
import path from "node:path";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import { readRecord, REQUEST_ID_RE, writeRecord } from "../../video/handoff/pull-store.js";

export type RequestState = "dialog_open" | "committed" | "declined" | "timeout" | "unavailable" | "refused";
type Result = Record<string, unknown>;

export interface RequestRecord {
  request_id: string;
  payload_hash: string;
  state: RequestState;
  at: string;
  content_id: string | null;
  item_id: string;
  gen: string;
  decision: string;
  /** 真要提交的那份决定的指纹（选中的组 / 版 + 服务端定下的封面字）：重启后认「是不是这一份提交了」只认它 */
  commit_fp?: string;
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

// ---- 请求号占位：同一个 request_id 同一时间只有一个调用在走（同步占，先于任何 await）----

const claimed = new Set<string>();

export function claimRequest(id: string): boolean {
  if (claimed.has(id)) return false;
  claimed.add(id);
  return true;
}

export function releaseRequest(id: string): void {
  claimed.delete(id);
}

// ---- 弹窗位 ----

let slot: string | null = null;

/** 拿弹窗位：已有窗开着（任何会话、任何条目）→ false */
export function takeSlot(requestId: string): boolean {
  if (slot !== null) return false;
  slot = requestId;
  return true;
}

export function releaseSlot(requestId: string): void {
  if (slot === requestId) slot = null;
}

export const slotHolder = () => slot;

/** 测试专用：模拟服务重启（弹窗位清空） */
export function resetSlotForTest(): void {
  slot = null;
  claimed.clear();
}

// ---- 先查账 ----

export type Prior = { kind: "new" } | { kind: "replay"; result: Result } | { kind: "conflict" } | { kind: "busy" };

const EXPIRED: Result = { ok: false, code: "confirm_timeout", error: "上次弹窗没等到结果（服务中途重启过），这次什么都没记：换一个 request_id 再确认。" };

const ELSEWHERE: Result = { ok: false, code: "already_handled", error: "这件事已在别处处理（做的不是这次弹窗里的那个决定），这次什么都没记：重新 list 看现在的样子" };

/**
 * 上一个进程留下的 dialog_open：这件事这一代的消费记录和这次要提交的决定逐项一致（动作 + 选中对象 + 封面字）
 * = 提交了只是回执丢了；记了别的决定 = 已在别处处理；什么都没记 = 当作没人点。
 */
async function settleOrphan(dataDir: string, rec: RequestRecord): Promise<Result> {
  const log = rec.content_id ? (await readProductionDocOrEmpty(rec.content_id, dataDir)).inbox_log ?? [] : [];
  const mine = log.filter((e) => e.item_id === rec.item_id && e.gen === rec.gen && !e.pending);
  const done = rec.commit_fp ? mine.find((e) => e.action === rec.decision && e.fp === rec.commit_fp) : undefined;
  const result = done ? { ...done.result, ok: true, status: "confirmed", item_id: rec.item_id, gen: rec.gen } : mine.length ? ELSEWHERE : EXPIRED;
  await writeRequest(dataDir, { ...rec, state: done ? "committed" : mine.length ? "refused" : "timeout", result });
  return result;
}

export async function priorRequest(dataDir: string, id: string, hash: string): Promise<Prior> {
  const rec = await readRequest(dataDir, id);
  if (!rec) return { kind: "new" };
  if (rec.payload_hash !== hash) return { kind: "conflict" };
  if (rec.state !== "dialog_open") return { kind: "replay", result: { ...(rec.result ?? {}), replayed: true } };
  if (slot === id) return { kind: "busy" };
  return { kind: "replay", result: { ...(await settleOrphan(dataDir, rec)), replayed: true } };
}
