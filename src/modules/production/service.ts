/**
 * ProductionService（spec §4 / §7）：制作段状态的唯一写入服务。
 *
 * 每次写：文件归属事务（调用方持有）→ 稿件写锁（contentTransaction）→ 读 doc、改、按 revision 写
 * → `refreshProductionProjection` 在同一把锁里投影 status 与冻结 → 追加时间线 → 更新字节索引。
 * 外部不能传目标阶段；status 只由这里投影。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentTransaction, getDataDir, type Content, type ContentTx } from "../../storage/local-store.js";
import { registerProjector } from "../../storage/production-hooks.js";
import { contentRoot, isLayoutV2 } from "../../storage/content-project.js";
import {
  appendTimeline, bodyHash, isFrozen, isOntologyActive, readProductionDocOrEmpty, stampEvents, writeProductionDoc,
} from "../../storage/production-store.js";
import type { ProductionDoc, TimelineEvent } from "../../storage/production-types.js";
import { writeTextAtomicMkdir } from "../../storage/json-atomic.js";
import { deriveExplanation, POST_APPROVAL, type Explanation } from "./explain.js";
import { outsideFileOwnership, withFileOwnership } from "./mutex.js";
import { matchingRegistration, publishReceipts, validCoverApproval, validCutApproval } from "./derive.js";
import { registrationPatch } from "./registration.js";
import { migrateCoverGroups } from "./cover-groups.js";

/** 当前有效封面批准的两张 sha（§6.2 迁移时它们不动） */
export function approvedCoverShas(doc: ProductionDoc, body: string): Set<string> {
  const d = validCoverApproval(doc, body ?? "");
  return new Set([d?.cover_3x4_sha, d?.cover_4x3_sha].filter((x): x is string => Boolean(x)));
}
import { rebuildShaIndex, reindexContent, type ShaIndex } from "./sha-index.js";
import { recoverTxns, type RecoveryOutcome } from "./txn.js";

type NewEvent = Omit<TimelineEvent, "seq" | "at">;

// ---- 启动：恢复未完成事务 → 重建索引 → 开放写入 ----

const ready = new Map<string, Promise<{ recovered: RecoveryOutcome[]; index: ShaIndex }>>();

/** 开放写入之后要跑一次的事（1b §3-5：本轮 pending_match 重新入队）。每个工作区每个钩子只跑一次 */
type ReadyHook = (dataDir: string) => Promise<void>;
const readyHooks: ReadyHook[] = [];
const hooksRan = new Map<string, Set<ReadyHook>>();

export function registerReadyHook(fn: ReadyHook): void {
  readyHooks.push(fn);
}

async function runReadyHooks(dataDir: string): Promise<string[]> {
  const ran = hooksRan.get(dataDir) ?? new Set<ReadyHook>();
  hooksRan.set(dataDir, ran);
  const errors: string[] = [];
  for (const fn of readyHooks.filter((h) => !ran.has(h))) {
    ran.add(fn);
    await fn(dataDir).catch((e: unknown) => { ran.delete(fn); errors.push(e instanceof Error ? e.message : String(e)); });
  }
  return errors;
}

export async function ensureProductionReady(dataDir: string) {
  let p = ready.get(dataDir);
  if (!p) {
    p = withFileOwnership(async () => ({ recovered: await recoverTxns(dataDir), index: await rebuildShaIndex(dataDir) }));
    ready.set(dataDir, p);
    p.catch(() => ready.delete(dataDir));
  }
  const r = await p;
  // 钩子在锁外跑（重新入队只读事实、写本机队列）；失败下次再试，并带回给调用方看
  const hookErrors = await outsideFileOwnership(() => runReadyHooks(dataDir));
  return { ...r, ...(hookErrors.length ? { hookErrors } : {}) };
}

/** 测试 / 重新挂载资料库时忘掉「已就绪」 */
export function resetProductionReady(dataDir?: string): void {
  if (dataDir) { ready.delete(dataDir); hooksRan.delete(dataDir); }
  else { ready.clear(); hooksRan.clear(); }
}

// ---- 投影 ----

function frozenRel(root: string, hash: string): string {
  return isLayoutV2(root) ? `01-script/frozen/${hash}.md` : `frozen/${hash}.md`;
}

/** 进入剪辑中时冻结正文：写冻结副本、记 doc.frozen（§2.5） */
async function freezeIfNeeded(content: Content, doc: ProductionDoc, exp: Explanation, dataDir: string): Promise<boolean> {
  if (exp.phase !== "production" || exp.stage === "待录制" || exp.stage === null || isFrozen(doc)) return false;
  const root = contentRoot(content.id, dataDir);
  const hash = bodyHash(content.body);
  const rel = frozenRel(root, hash);
  await writeTextAtomicMkdir(path.join(root, rel), content.body);
  doc.frozen = { round: doc.round, body_hash: hash, path: rel, at: new Date().toISOString() };
  return true;
}

function currentRegistration(doc: ProductionDoc, content: Content) {
  return matchingRegistration(doc, content.body, validCutApproval(doc, content.body), validCoverApproval(doc, content.body));
}

function projectedStatus(content: Content, exp: Explanation): Content["status"] | null {
  if (content.status === "publishing" || content.status === "archived" || content.deletedAt) return null;
  const target = exp.status ?? (exp.phase === "writing" && POST_APPROVAL.has(content.status) ? "draft_ready" : null);
  return target && target !== content.status ? target : null;
}

/**
 * 在稿件写锁内把推导结果投影成 status 缓存并冻结正文。未启用本体（影子模式）时什么都不写。
 * 返回写完的 doc 与稿件。
 */
export async function refreshProductionProjection(tx: ContentTx, content: Content, doc: ProductionDoc, dataDir: string, opts: { force?: boolean } = {}): Promise<{ content: Content; doc: ProductionDoc; explanation: Explanation; events: TimelineEvent[] }> {
  // 按本体走的稿，已发布只认本轮的回执与「我发了」决定（§6），不再直接读外部发布记录
  const publish = { verified: false };
  const exp = deriveExplanation({ content, doc, enabled: true, publish });
  // 启用事务进行中（force）或这一条已按本体走，才投影；影子模式 / 被排除的稿什么都不写
  if (!opts.force && !(await isOntologyActive(dataDir, content.id))) return { content, doc, explanation: exp, events: [] };
  const next = structuredClone(doc);
  const pending: NewEvent[] = [];
  if (await freezeIfNeeded(content, next, exp, dataDir)) pending.push({ type: "script_frozen", detail: { body_hash: next.frozen!.body_hash } });
  const target = projectedStatus(content, exp);
  let written = content;
  // 命中 D2 的登记记录落到稿件上（video.final / videoDone / 成片素材），幂等
  const reg = exp.rule === "D2" ? currentRegistration(next, content) : null;
  const regPatch = reg ? await registrationPatch(content, next, reg, dataDir) : null;
  if (regPatch) {
    written = (await tx.write(regPatch)) ?? written;
    pending.push({ type: "registration_projected", detail: { registration_id: reg!.id } });
  }
  if (target) {
    // 投影到已发布时盖一次发布时间（只盖一次，取平台上的实际/定时时间）
    const firstLive = publishReceipts(doc).live.map((w) => w.at).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    const stamp = target === "published" && !content.publishedAt ? { publishedAt: firstLive ?? new Date().toISOString() } : {};
    written = (await tx.write({ status: target, ...stamp })) ?? content;
    pending.push({ type: "stage_projected", detail: { from: content.status, to: target, rule: exp.rule } });
  }
  if (!pending.length) return { content: written, doc, explanation: exp, events: [] };
  const events = stampEvents(next, pending);
  const saved = await writeProductionDoc(content.id, dataDir, next, doc.revision);
  return { content: written, doc: saved, explanation: exp, events };
}

// ---- 写 ----

export interface MutateResult<T> { value: T; doc: ProductionDoc; content: Content; explanation: Explanation }

/**
 * 改一条内容的制作记录：`fn` 在锁内拿到 doc 副本就地改，返回要记的时间线事件与返回值。
 * 调用方必须已持有文件归属事务（record / 重开文稿 / 对账）。
 */
export async function mutateProduction<T>(
  contentId: string, dataDir: string,
  fn: (doc: ProductionDoc, content: Content) => Promise<{ value: T; events: NewEvent[] }> | { value: T; events: NewEvent[] },
): Promise<MutateResult<T>> {
  return contentTransaction(contentId, dataDir, async (tx) => {
    const content = await tx.read();
    if (!content) throw new Error(`Content ${contentId} not found`);
    const doc = await readProductionDocOrEmpty(contentId, dataDir);
    const next = structuredClone(doc);
    // 封面统一准入的迁移（review-inbox §6.2）随第一次写落盘：只改标签，不动文件
    const migrated = migrateCoverGroups(next, approvedCoverShas(next, content.body));
    const { value, events: own } = await fn(next, content);
    const events = [...migrated.filter((m) => m.to === "candidate").map((m) => ({ type: "cover_demoted", detail: { fact_id: m.fact_id, state: "candidate", reason: m.reason } })), ...own];
    const stamped = stampEvents(next, events);
    const saved = await writeProductionDoc(contentId, dataDir, next, doc.revision);
    const refreshed = await refreshProductionProjection(tx, content, saved, dataDir);
    await appendTimeline(contentId, dataDir, [...stamped, ...refreshed.events]);
    await reindexContent(dataDir, contentId, refreshed.doc);
    return { value, doc: refreshed.doc, content: refreshed.content, explanation: refreshed.explanation };
  });
}

/** 只投影不改事实（对账后、启用时逐条刷新） */
export async function refreshContent(contentId: string, dataDir: string, opts: { force?: boolean } = {}): Promise<Explanation> {
  return contentTransaction(contentId, dataDir, async (tx) => {
    const content = await tx.read();
    if (!content) throw new Error(`Content ${contentId} not found`);
    const doc = await readProductionDocOrEmpty(contentId, dataDir);
    const r = await refreshProductionProjection(tx, content, doc, dataDir, opts);
    await appendTimeline(contentId, dataDir, r.events);
    return r.explanation;
  });
}

// 认稿 / 重绑落盘后，storage 在同一把稿件写锁里回调这里投影（不取锁）
registerProjector(async (id, dataDir, tx) => {
  const content = await tx.read();
  if (!content) return;
  const dir = dataDir ?? getDataDir();
  const r = await refreshProductionProjection(tx, content, await readProductionDocOrEmpty(id, dir), dir);
  await appendTimeline(id, dir, r.events);
});

/** 冻结副本存在性自检用（测试 / 诊断） */
export async function frozenCopy(contentId: string, dataDir: string, doc: ProductionDoc): Promise<string | null> {
  if (!doc.frozen) return null;
  return fs.readFile(path.join(contentRoot(contentId, dataDir), doc.frozen.path), "utf8").catch(() => null);
}
