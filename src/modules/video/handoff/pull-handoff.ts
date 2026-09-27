/**
 * Codex 发起交接的门与重放（P6 §12.4-D，§13.8 #3）。
 *
 * - 带 `confirmation_id` 的交接：确认记录存在、未用过、没作废、没过期（30 分钟），且 content_id、
 *   draft_hash 与当前稿一致；原片哈希在读完原片之后再比（handoff.ts）。
 * - 请求身份重放：同一 request_id + 同一 confirmation_id 在 10 分钟内重试 → 原样返回首次提交冻结的回执，
 *   并**重新交还同一枚令牌**（「回执丢了」的恢复路径）。重放**先于读源文件**：原片已经挪进项目，
 *   Downloads 里的原路径不在了，也不重新生成交接包。
 * - 资料库里的请求记录只存令牌哈希；明文令牌存本机私有目录（getConfigDir 下 video/handoff-tokens，0600），
 *   不进资料库、不进项目文件夹、不进交接包。重放只把令牌交还给 codex 宿主（会话号只作诊断，不作凭据）。
 */
import { hashClaimToken, tokenMatches } from "../../../storage/claim-token.js";
import path from "node:path";
import { getConfigDir } from "../../../storage/storage-roots.js";
import fs from "node:fs/promises";
import { draftHash } from "../../../storage/draft-hash.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { confirmationFile, readConfirmation, type ConfirmationRecord } from "./confirm.js";
import { pullDeps } from "./pull-deps.js";
import { readRecord, requestFile, REQUEST_ID_RE, writeRecord } from "./pull-store.js";
import { handoffFail, type HandoffResult } from "./types.js";

export const REPLAY_WINDOW_MS = 10 * 60_000;
/** 与 handoff.ts 的 EDITOR_HOST 同值（那边引用本模块，这里不反向 import） */
const REPLAY_TOKEN_HOST = "codex";

export interface HandoffRequestRecord {
  request_id: string;
  confirmation_id: string;
  content_id: string;
  generation: number;
  manifest_hash: string;
  /** 资料库里只留哈希；明文在本机私有目录 */
  claim_token_hash: string;
  at: string;
  result: HandoffResult;
  /** 提交前先落的请求记录：提交成没成要按稿件上的交接核定（崩在提交与回执之间时，重试靠它重放） */
  pending?: boolean;
}

function requestRecordFile(dataDir: string, requestId: string): string {
  return requestFile(dataDir, "handoff-requests", requestId);
}

/** 本机私有：按资料库+工作区隔开（getConfigDir），不在资料库里 */
function privateTokenFile(dataDir: string, requestId: string): string {
  if (!REQUEST_ID_RE.test(requestId)) throw new Error("request_id 不合法");
  return path.join(getConfigDir(dataDir), "video", "handoff-tokens", `${requestId}.json`);
}

async function savePrivateToken(dataDir: string, requestId: string, token: string): Promise<void> {
  const file = privateTokenFile(dataDir, requestId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify({ request_id: requestId, claim_token: token }), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

async function readPrivateToken(dataDir: string, requestId: string): Promise<string | null> {
  const stored = await readRecord<{ claim_token?: unknown }>(privateTokenFile(dataDir, requestId)).catch(() => null);
  return typeof stored?.claim_token === "string" ? stored.claim_token : null;
}

/** 令牌明文进本机私有目录，资料库记录只存哈希 */
export async function saveRequestRecord(dataDir: string, record: HandoffRequestRecord, token?: string): Promise<void> {
  if (token) await savePrivateToken(dataDir, record.request_id, token);
  await writeRecord(requestRecordFile(dataDir, record.request_id), record);
}

export async function dropRequestRecord(dataDir: string, requestId: string): Promise<void> {
  await fs.rm(requestRecordFile(dataDir, requestId), { force: true });
  await fs.rm(privateTokenFile(dataDir, requestId), { force: true });
}

/** 旧版记录把明文令牌写在资料库里：读到就挪进本机私有目录、记录里换成哈希 */
async function readRequestRecord(dataDir: string, requestId: string): Promise<HandoffRequestRecord | null> {
  const stored = await readRecord<HandoffRequestRecord & { claim_token?: string }>(requestRecordFile(dataDir, requestId));
  if (!stored || typeof stored.claim_token !== "string") return stored;
  const { claim_token: token, ...rest } = stored;
  const record = { ...rest, claim_token_hash: hashClaimToken(token) };
  await saveRequestRecord(dataDir, record, token);
  return record;
}

/**
 * 未定的请求记录：稿件上的当前交接就是这份清单（且没撤回）= 已提交，补记确认已用、转成定稿记录；
 * 否则 = 没提交，删掉记录，这次请求照常走（原片挪动由启动核定处理）。
 */
async function settlePending(dataDir: string, record: HandoffRequestRecord): Promise<HandoffRequestRecord | null> {
  const content = await getContent(record.content_id, dataDir);
  const handoff = content?.video?.handoff;
  const committed = handoff?.hash === record.manifest_hash && !content?.video?.revoked?.includes(record.manifest_hash);
  if (!committed) { await dropRequestRecord(dataDir, record.request_id); return null; }
  const confirmation = await readConfirmation(dataDir, record.confirmation_id);
  if (confirmation && !confirmation.used_at) await markConfirmation(dataDir, confirmation, { used_at: record.at, used_by_request: record.request_id });
  const { pending: _p, ...settled } = record;
  await saveRequestRecord(dataDir, settled);
  return settled;
}

/** null = 不是重放，照常往下走 */
export async function requestReplay(dataDir: string, requestId: string, confirmationId: string, host: string): Promise<HandoffResult | null> {
  const stored = await readRequestRecord(dataDir, requestId);
  if (!stored) return null;
  if (stored.confirmation_id !== confirmationId) {
    return handoffFail("invalid_params", "这个 request_id 已经用在另一份确认上：换一个新的 request_id");
  }
  const record = stored.pending ? await settlePending(dataDir, stored) : stored;
  if (!record) return null;
  const content = await getContent(record.content_id, dataDir);
  const token = await readPrivateToken(dataDir, requestId);
  const live = Boolean(token) && hashClaimToken(token!) === record.claim_token_hash && tokenMatches(content?.claim?.token, token!);
  const fresh = pullDeps().now() - Date.parse(record.at) <= REPLAY_WINDOW_MS;
  // 回执丢了的恢复（§12.6）：同一 request_id + confirmation_id、10 分钟内、认领还在原令牌手上，只交还给 codex 宿主
  if (fresh && live && host === REPLAY_TOKEN_HOST) return { ...record.result, replayed: true, claim_token: token };
  const note = !fresh ? "超过 10 分钟的重放只回持有者和代次，不再交还令牌。"
    : !live ? "这次交接的认领已经不在原令牌手上（撤回、登记或接管过），不再交还令牌。"
      : "令牌只交还给发起这次交接的 Codex，不交给其他宿主。";
  return { ...record.result, replayed: true, holder: { content_id: record.content_id, generation: record.generation }, note };
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
