/**
 * Codex 发起交接的门与重放（P6 §12.4-D，§13.8 #3）。
 *
 * - 带 `confirmation_id` 的交接：确认记录存在、未用过、没作废、没过期（30 分钟），且 content_id、
 *   draft_hash 与当前稿一致；原片哈希在读完原片之后再比（handoff.ts）。
 * - 请求身份重放：同一 request_id + 同一 confirmation_id 在 10 分钟内重试 → 原样返回首次提交冻结的回执，
 *   并**重新交还同一枚令牌**（「回执丢了」的恢复路径）。重放**先于读源文件**：原片已经挪进项目，
 *   Downloads 里的原路径不在了，也不重新生成交接包。
 * - 令牌只存在服务自己的请求记录里（`<dataDir>/video/pull/`），不进项目文件夹、不进交接包。
 */
import { draftHash } from "../../../storage/draft-hash.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { confirmationFile, readConfirmation, type ConfirmationRecord } from "./confirm.js";
import { pullDeps } from "./pull-deps.js";
import { readRecord, requestFile, REQUEST_ID_RE, writeRecord } from "./pull-store.js";
import { handoffFail, type HandoffResult } from "./types.js";

export const REPLAY_WINDOW_MS = 10 * 60_000;

export interface HandoffRequestRecord {
  request_id: string;
  confirmation_id: string;
  content_id: string;
  generation: number;
  manifest_hash: string;
  claim_token: string;
  at: string;
  result: HandoffResult;
}

function requestRecordFile(dataDir: string, requestId: string): string {
  return requestFile(dataDir, "handoff-requests", requestId);
}

export async function saveRequestRecord(dataDir: string, record: HandoffRequestRecord): Promise<void> {
  await writeRecord(requestRecordFile(dataDir, record.request_id), record);
}

/** null = 不是重放，照常往下走 */
export async function requestReplay(dataDir: string, requestId: string, confirmationId: string): Promise<HandoffResult | null> {
  const record = await readRecord<HandoffRequestRecord>(requestRecordFile(dataDir, requestId));
  if (!record) return null;
  if (record.confirmation_id !== confirmationId) {
    return handoffFail("invalid_params", "这个 request_id 已经用在另一份确认上：换一个新的 request_id");
  }
  const content = await getContent(record.content_id, dataDir);
  const live = content?.claim?.token === record.claim_token;
  const fresh = pullDeps().now() - Date.parse(record.at) <= REPLAY_WINDOW_MS;
  if (fresh && live) return { ...record.result, replayed: true, claim_token: record.claim_token };
  return { ...record.result, replayed: true, holder: { content_id: record.content_id, generation: record.generation },
    note: fresh ? "这次交接的认领已经不在原令牌手上（撤回或接管过），不再交还令牌。" : "超过 10 分钟的重放只回持有者和代次，不再交还令牌。" };
}

export function validRequestId(requestId: string | undefined): requestId is string {
  return typeof requestId === "string" && REQUEST_ID_RE.test(requestId);
}

type Checked = { ok: true; value: ConfirmationRecord } | { ok: false; result: HandoffResult };

export async function checkConfirmation(confirmationId: string, content: Content, dataDir: string): Promise<Checked> {
  const record = /^cfm-[a-z0-9-]+$/.test(confirmationId) ? await readConfirmation(dataDir, confirmationId) : null;
  if (!record) return { ok: false, result: handoffFail("confirmation_invalid", "找不到这条确认记录：先 match，再 confirm 让创始人在弹窗里点确认") };
  if (record.used_at) {
    const h = content.video?.handoff;
    return { ok: false, result: handoffFail("confirmation_used", "这条确认已经用过一次", h ? { holder: { content_id: content.id, generation: h.generation } } : {}) };
  }
  if ((record as { voided_at?: string }).voided_at) return { ok: false, result: handoffFail("confirmation_invalid", "这条确认已作废（原片变了），重新 match / confirm") };
  if (pullDeps().now() > Date.parse(record.expires_at)) return { ok: false, result: handoffFail("confirmation_invalid", "确认已过期（30 分钟），重新 confirm") };
  if (record.content_id !== content.id) return { ok: false, result: handoffFail("confirmation_invalid", "确认记录不是这条稿的") };
  if (record.draft_hash !== draftHash(content)) return { ok: false, result: handoffFail("confirmation_invalid", "确认之后稿子改过了，重新 match / confirm") };
  return { ok: true, value: record };
}

export async function markConfirmation(dataDir: string, record: ConfirmationRecord, patch: Record<string, string>): Promise<void> {
  await writeRecord(confirmationFile(dataDir, record.confirmation_id), { ...record, ...patch });
}
