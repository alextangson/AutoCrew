/**
 * `autocrew_video match{aroll_path, request_id}`：认稿（P6 §12.4-B，§13.4-B）。
 *
 * 「只读」= 不改任何业务状态（稿件、认领、交接、锁）；允许受控的临时产物（转写临时目录）
 * 和服务端自己的回执记录。回执由服务端签发并保存，确认（confirm）只认回执里的候选。
 *
 * 标定前一律保守：不输出 `proposed`。有把握的结果也按 `ambiguous` 交给弹窗让创始人从前三名里选；
 * 全部低分是 `no_confident_match`。转写失败绝不把 L1 弱命中升级成强命中，降级原因进 flags。
 */
import path from "node:path";
import { draftHash } from "../../../storage/draft-hash.js";
import { isVideoPlatform } from "../../../storage/stage-guard.js";
import { readProjectRegistry, resolveContentProject } from "../../../storage/content-project.js";
import { CONTENT_STATUS_LABEL, getContent, getTopic, listContents, type Content } from "../../../storage/local-store.js";
import { reviewValid } from "./acceptance.js";
import { readArollInput } from "./aroll-input.js";
import { matchL1, type L1Hit } from "./match-l1.js";
import { MIN_SPEECH_CHARS, scoreTranscript, speechChars } from "./match-l2.js";
import { ASR_WARMUP_WHERE } from "../asr.js";
import { pullDeps } from "./pull-deps.js";
import { arollLockOf, lastRevokeAt, newId, pullDir, readRecord, REQUEST_ID_RE, requestFile, writeRecord } from "./pull-store.js";
import { handoffFail, type HandoffResult } from "./types.js";

export const RECEIPT_TTL_MS = 30 * 60_000;
export const ALGO_VERSION = "l1-nfkc-suffix/1+l2-idf-bigram-window/1";
/** 未标定的临时下限：低于它算低分。标定集定阈值之前只用来区分「全部低分」，不开放 proposed */
export const L2_PROVISIONAL_FLOOR = 0.3;
export const DIALOG_TOP_N = 3;
const MAX_RECEIPT_CANDIDATES = 10;

export type MatchStatus = "proposed" | "ambiguous" | "no_confident_match" | "no_candidate" | "already_handed_off";
export type MatchFlag = "asr_unavailable" | "no_speech" | "low_quality_transcript" | "l1_only";

export interface ReceiptCandidate {
  content_id: string;
  project_id: string;
  binding_revision: number;
  draft_hash: string;
  platform: string;
  title: string;
  layer: "l1" | "l2";
  score: number;
  evidence: string;
  unreviewed_import?: true;
  possibly_old_version?: true;
}

export interface MatchReceipt {
  receipt_id: string;
  request_id: string;
  library_id: string | null;
  aroll_path: string;
  aroll_sha256: string;
  aroll_size: number;
  aroll_mtime_ms: number;
  status: MatchStatus;
  flags: MatchFlag[];
  candidates: ReceiptCandidate[];
  algo_version: string;
  calibrated: false;
  issued_at: string;
  expires_at: string;
}

export function receiptFile(dataDir: string, receiptId: string): string {
  if (!/^rcpt-[a-z0-9-]+$/.test(receiptId)) throw new Error("receipt_id 不合法");
  return pullDir(dataDir, "receipts", `${receiptId}.json`);
}

export async function readReceipt(dataDir: string, receiptId: string): Promise<MatchReceipt | null> {
  return readRecord<MatchReceipt>(receiptFile(dataDir, receiptId));
}

type Eligible = { ok: true; unreviewed: boolean } | { ok: false; reason: string };

/** 候选范围：已绑定项目、视频平台、未进回收站、可交接状态、审稿 accepted；导入稿例外（§13.4-B） */
export function eligibility(c: Content, dataDir: string): Eligible {
  if (!resolveContentProject(c.id, dataDir)) return { ok: false, reason: "未迁移到项目（v2）：走 Claude 推送旧路（project_migration_required）" };
  if (c.status !== "draft_ready" && c.status !== "approved") return { ok: false, reason: `状态是「${CONTENT_STATUS_LABEL[c.status] ?? c.status}」` };
  if (reviewValid(c)) return { ok: true, unreviewed: false };
  // 导入稿没审稿记录：draft_ready 或创始人在看板认过（approved，信号更强）都进候选
  if (c.writingSource?.kind === "manual_import") return { ok: true, unreviewed: true };
  return { ok: false, reason: "这一版还没通过审稿" };
}

async function oldTitles(c: Content, dataDir: string): Promise<string[]> {
  const titles = (c.versions ?? []).map((v) => v.title ?? "").filter((t) => t && t !== c.title);
  const topic = c.topicId ? await getTopic(c.topicId, dataDir).catch(() => null) : null;
  if (topic?.title && topic.title !== c.title) titles.push(topic.title);
  return titles;
}

/** 原片已在某条未撤回交接里：只是提示，真正的强制在交接提交里的原片锁 */
async function handedOffHolder(sha: string, all: Content[], dataDir: string): Promise<Record<string, unknown> | null> {
  const lock = await arollLockOf(dataDir, sha);
  if (lock) return { content_id: lock.content_id, generation: lock.generation };
  const hit = all.find((c) => c.video?.handoff?.aroll_sha256 === sha && !(c.video.revoked ?? []).includes(c.video.handoff.hash));
  return hit ? { content_id: hit.id, generation: hit.video!.handoff!.generation, status: hit.status } : null;
}

function candidateOf(c: Content, dataDir: string, unreviewed: boolean): ReceiptCandidate {
  const binding = resolveContentProject(c.id, dataDir)!;
  return {
    content_id: c.id, project_id: binding.project_id, binding_revision: binding.binding_revision,
    draft_hash: draftHash(c), platform: c.platform ?? "", title: c.title, layer: "l1", score: 0, evidence: "",
    ...(unreviewed ? { unreviewed_import: true as const } : {}),
  };
}

function nearMisses(file: string, others: Array<{ c: Content; reason: string }>, titles: string[][]): Array<Record<string, unknown>> {
  const hits = matchL1(file, others.map((o, i) => ({ title: o.c.title, oldTitles: titles[i] })));
  return others
    .map((o, i) => ({ content_id: o.c.id, title: o.c.title, platform: o.c.platform, reason: o.reason, score: hits[i].score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, DIALOG_TOP_N)
    .map(({ score: _s, ...rest }) => rest);
}

interface Scored {
  candidates: ReceiptCandidate[];
  flags: MatchFlag[];
  confident: boolean;
}

function applyL1(cands: ReceiptCandidate[], hits: L1Hit[]): void {
  cands.forEach((c, i) => {
    const h = hits[i];
    c.layer = "l1";
    c.score = h.score;
    c.evidence = h.kind === "none" ? "文件名对不上标题" : `文件名：${h.reason}`;
    if (h.possibly_old_version) c.possibly_old_version = true;
  });
}

export const ASR_WARMUP_ACTION = `请创始人到 ${ASR_WARMUP_WHERE} 点一次（约 1GB），下完再重新 match 就能按开头转写认稿`;

async function scoreCandidates(arollPath: string, cands: ReceiptCandidate[], hits: L1Hit[], bodies: string[], dataDir: string): Promise<Scored> {
  applyL1(cands, hits);
  if (hits.filter((h) => h.kind === "strong").length === 1) return { candidates: cands, flags: [], confident: true };
  const transcriber = pullDeps().transcriber;
  const notReady = transcriber.notReady ? await transcriber.notReady(dataDir) : null;
  const heard = notReady ? { ok: false as const, unavailable: true, reason: `转写没就绪：${notReady}` } : await transcriber.transcribe(arollPath);
  if (!heard.ok) {
    const flags: MatchFlag[] = heard.unavailable ? ["asr_unavailable", "l1_only"] : ["l1_only"];
    cands.forEach((c) => { c.evidence += `；转写失败：${heard.reason}`; });
    return { candidates: cands, flags, confident: false };
  }
  const chars = speechChars(heard.text);
  if (chars === 0) return { candidates: cands, flags: ["no_speech", "l1_only"], confident: false };
  const scores = scoreTranscript(heard.text, bodies);
  cands.forEach((c, i) => {
    c.layer = "l2";
    c.score = scores[i];
    c.evidence = `开头转写相似度 ${scores[i]}（${chars} 字）；${c.evidence}`;
  });
  const low = chars < MIN_SPEECH_CHARS;
  const top = Math.max(...scores);
  return { candidates: cands, flags: low ? ["low_quality_transcript"] : [], confident: !low && top >= L2_PROVISIONAL_FLOOR };
}

export interface MatchInput {
  arollPath: string;
  requestId: string;
}

export async function matchAroll(input: MatchInput, dataDir: string): Promise<HandoffResult> {
  if (!REQUEST_ID_RE.test(input.requestId)) return handoffFail("invalid_params", "match 需要 request_id（1–100 位字母、数字、-、_）");
  const aroll = await readArollInput(input.arollPath);
  if (!aroll.ok) return handoffFail("aroll_invalid", aroll.reason);
  const replayed = await matchReplay(input.requestId, aroll.value.sha256, dataDir);
  if (replayed) return replayed;
  const all = (await listContents(dataDir)).filter((c) => isVideoPlatform(c.platform));
  const holder = await handedOffHolder(aroll.value.sha256, all, dataDir);
  if (holder) {
    return { ok: true, status: "already_handed_off", holder, aroll_sha256: aroll.value.sha256,
      note: "这段原片已经交接过：同一段原片同时只归一条未撤回交接。认错了稿就先撤回那条。" };
  }
  // 交接会拒的文件（没音轨、超 30 分钟）在这里就拒，别让创始人先点完弹窗
  const probed = await pullDeps().probe(aroll.value.path);
  if (!probed.ok) return handoffFail("aroll_invalid", probed.reason);
  const eligible: Array<{ c: Content; unreviewed: boolean }> = [];
  const others: Array<{ c: Content; reason: string }> = [];
  for (const c of all) {
    const e = eligibility(c, dataDir);
    if (e.ok) eligible.push({ c, unreviewed: e.unreviewed });
    else others.push({ c, reason: e.reason });
  }
  const file = path.basename(aroll.value.path);
  if (!eligible.length) {
    const titles = await Promise.all(others.map((o) => oldTitles(o.c, dataDir)));
    return { ok: true, status: "no_candidate", near_misses: nearMisses(file, others, titles),
      note: "没有可交接的视频稿：看 near_misses 里每条为什么交不了；缺审稿或出处要回写稿会话补。" };
  }
  const subjects = await Promise.all(eligible.map(async (e) => ({ title: e.c.title, oldTitles: await oldTitles(e.c, dataDir) })));
  const cands = eligible.map((e) => candidateOf(e.c, dataDir, e.unreviewed));
  const scored = await scoreCandidates(aroll.value.path, cands, matchL1(file, subjects), eligible.map((e) => e.c.body), dataDir);
  return issueReceipt(input, aroll.value, scored, dataDir);
}

async function issueReceipt(input: MatchInput, aroll: { path: string; sha256: string; size: number; mtimeMs: number }, scored: Scored, dataDir: string): Promise<HandoffResult> {
  const now = pullDeps().now();
  const candidates = [...scored.candidates].sort((a, b) => b.score - a.score).slice(0, MAX_RECEIPT_CANDIDATES);
  const receipt: MatchReceipt = {
    receipt_id: newId("rcpt"), request_id: input.requestId, library_id: readProjectRegistry(dataDir)?.library_id ?? null,
    aroll_path: aroll.path, aroll_sha256: aroll.sha256, aroll_size: aroll.size, aroll_mtime_ms: aroll.mtimeMs,
    // 标定前不开放 proposed：有把握也交弹窗让创始人选
    status: scored.confident ? "ambiguous" : "no_confident_match",
    flags: scored.flags, candidates, algo_version: ALGO_VERSION, calibrated: false,
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + RECEIPT_TTL_MS).toISOString(),
  };
  await writeRecord(receiptFile(dataDir, receipt.receipt_id), receipt);
  await writeRecord(requestFile(dataDir, "match-requests", input.requestId), { receipt_id: receipt.receipt_id, aroll_sha256: aroll.sha256 });
  return receiptView(receipt);
}

const CONFIRM_ACTION = "调 autocrew_video confirm{receipt_id, cover_text, target_seconds, request_id}，并告诉创始人去 Mac 上的弹窗选稿、点确认。";

function receiptView(receipt: MatchReceipt, extra: Record<string, unknown> = {}): HandoffResult {
  const warm = receipt.flags.includes("asr_unavailable") ? `转写没就绪，这次只按文件名认：${ASR_WARMUP_ACTION}。现在也可以直接` : "";
  return { ok: true, ...receipt, candidates: receipt.candidates.slice(0, DIALOG_TOP_N), ...extra, next_action: warm + CONFIRM_ACTION };
}

/** §12.6 回执丢失凭请求号取回：同号同原片回原回执，同号换了原片拒 */
async function matchReplay(requestId: string, sha: string, dataDir: string): Promise<HandoffResult | null> {
  const seen = await readRecord<{ receipt_id: string; aroll_sha256: string }>(requestFile(dataDir, "match-requests", requestId));
  if (!seen) return null;
  if (seen.aroll_sha256 !== sha) {
    return handoffFail("request_conflict", "这个 request_id 已经用来认过另一段原片：换一段原片要换新的 request_id");
  }
  const receipt = await readReceipt(dataDir, seen.receipt_id);
  return receipt ? receiptView(receipt, { replayed: true }) : null;
}

/** 回执作废条件（§12.4-B）：过期、候选稿改过、项目迁移、之后有交接被撤回。原片哈希在 confirm 里重算 */
export async function receiptProblem(receipt: MatchReceipt, dataDir: string): Promise<string | null> {
  if (pullDeps().now() > Date.parse(receipt.expires_at)) return "回执已过期（30 分钟），重新 match";
  const revoked = await lastRevokeAt(dataDir);
  if (revoked && revoked > receipt.issued_at) return "签发回执之后有交接被撤回，重新 match";
  for (const cand of receipt.candidates) {
    const c = await getContent(cand.content_id, dataDir);
    if (!c) return `候选稿不存在了：${cand.content_id}`;
    if (draftHash(c) !== cand.draft_hash) return `候选稿「${c.title}」改过了，重新 match`;
    const b = resolveContentProject(c.id, dataDir);
    if (!b || b.project_id !== cand.project_id || b.binding_revision !== cand.binding_revision) return `候选稿「${c.title}」的项目迁移过，重新 match`;
  }
  return null;
}
