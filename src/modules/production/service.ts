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
import { withFileOwnership } from "./mutex.js";
import { publishEvidenceOf } from "./read.js";
import { rebuildShaIndex, reindexContent, type ShaIndex } from "./sha-index.js";
import { recoverTxns, type RecoveryOutcome } from "./txn.js";

type NewEvent = Omit<TimelineEvent, "seq" | "at">;

// ---- 启动：恢复未完成事务 → 重建索引 → 开放写入 ----

const ready = new Map<string, Promise<{ recovered: RecoveryOutcome[]; index: ShaIndex }>>();

export function ensureProductionReady(dataDir: string) {
  let p = ready.get(dataDir);
  if (!p) {
    p = withFileOwnership(async () => ({ recovered: await recoverTxns(dataDir), index: await rebuildShaIndex(dataDir) }));
    ready.set(dataDir, p);
    p.catch(() => ready.delete(dataDir));
  }
  return p;
}

/** 测试 / 重新挂载资料库时忘掉「已就绪」 */
export function resetProductionReady(dataDir?: string): void {
  if (dataDir) ready.delete(dataDir);
  else ready.clear();
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
  const publish = await publishEvidenceOf(content, dataDir, undefined, doc.round_started_at);
  const exp = deriveExplanation({ content, doc, enabled: true, publish });
  // 启用事务进行中（force）或这一条已按本体走，才投影；影子模式 / 被排除的稿什么都不写
  if (!opts.force && !(await isOntologyActive(dataDir, content.id))) return { content, doc, explanation: exp, events: [] };
  const next = structuredClone(doc);
  const pending: NewEvent[] = [];
  if (await freezeIfNeeded(content, next, exp, dataDir)) pending.push({ type: "script_frozen", detail: { body_hash: next.frozen!.body_hash } });
  const target = projectedStatus(content, exp);
  let written = content;
  if (target) {
    // 投影到已发布时盖一次发布时间（只盖一次，取平台上的实际/定时时间）
    const stamp = target === "published" && !content.publishedAt ? { publishedAt: publish.at ?? new Date().toISOString() } : {};
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
    const { value, events } = await fn(next, content);
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
