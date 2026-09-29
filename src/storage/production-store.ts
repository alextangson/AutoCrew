/**
 * production.json 的读写（spec §2.2）：每条内容一份，按 revision 乐观并发。
 * 时间线 timeline.jsonl 是审计投影（带单调 seq），不是第二份真相。
 *
 * 写入方只有两处：`ProductionService`（持文件归属事务 + 稿件写锁）与稿件写锁里的认稿钩子
 * （`local-store` 的 transition / 正文写口）。两处都在同一把稿件写锁里，revision 再挡跨进程写。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentFile, isMissing } from "./content-project.js";
import { writeJsonAtomicMkdir } from "./json-atomic.js";
import { resolveDataDir } from "./storage-roots.js";
import { emptyProductionDoc, type Decision, type ProductionDoc, type TimelineEvent } from "./production-types.js";

/** 推导表版本：升级时同样先影子后启用（§4.1） */
export const DERIVE_VERSION = 1;

export class ProductionConflictError extends Error {
  constructor(contentId: string, expected: number, actual: number) {
    super(`production_conflict: ${contentId} 的制作记录已被别处改过（期望 revision ${expected}，实际 ${actual}），请重试`);
  }
}

/** 正文哈希：批准只绑正文，不绑标题（§2.4） */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

export function productionFile(contentId: string, dataDir?: string): string {
  return contentFile(contentId, dataDir, "production.json");
}

function timelineFile(contentId: string, dataDir?: string): string {
  return contentFile(contentId, dataDir, "timeline.jsonl");
}

/** 工作区服务目录：字节索引、事务日志、启用版本、对账报告 */
export function productionServiceDir(dataDir?: string, ...segments: string[]): string {
  return path.join(resolveDataDir(dataDir), "production", ...segments);
}

export async function readProductionDoc(contentId: string, dataDir?: string): Promise<ProductionDoc | null> {
  let raw: string;
  try { raw = await fs.readFile(productionFile(contentId, dataDir), "utf8"); }
  catch (e) { if (isMissing(e)) return null; throw e; }
  const doc = JSON.parse(raw) as ProductionDoc;
  if (doc.schema !== 1 || !Array.isArray(doc.facts)) throw new Error(`production_invalid: ${contentId} 的 production.json 形状不对`);
  return { ...emptyProductionDoc(), ...doc };
}

export async function readProductionDocOrEmpty(contentId: string, dataDir?: string): Promise<ProductionDoc> {
  return (await readProductionDoc(contentId, dataDir)) ?? emptyProductionDoc();
}

/** 乐观写：盘上 revision 必须仍是 `expected`，写入后 revision = expected + 1 */
export async function writeProductionDoc(contentId: string, dataDir: string | undefined, doc: ProductionDoc, expected: number): Promise<ProductionDoc> {
  const current = await readProductionDoc(contentId, dataDir);
  const actual = current?.revision ?? 0;
  if (actual !== expected) throw new ProductionConflictError(contentId, expected, actual);
  // requests / txns 不裁剪（Codex 审 P2）：request_id 重放与事务提交判定都靠它们，裁掉就会把已搬走的请求判成路径不存在
  const next: ProductionDoc = { ...doc, revision: expected + 1 };
  await writeJsonAtomicMkdir(productionFile(contentId, dataDir), next);
  return next;
}

/** 追加时间线（审计投影）：调用方先把 seq 记进 doc 再写 doc，失败了下次重放也不会重号 */
export async function appendTimeline(contentId: string, dataDir: string | undefined, events: TimelineEvent[]): Promise<void> {
  if (!events.length) return;
  await fs.appendFile(timelineFile(contentId, dataDir), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

export async function readTimeline(contentId: string, dataDir?: string, sinceSeq = 0): Promise<TimelineEvent[]> {
  let raw: string;
  try { raw = await fs.readFile(timelineFile(contentId, dataDir), "utf8"); }
  catch (e) { if (isMissing(e)) return []; throw e; }
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as TimelineEvent).filter((e) => e.seq > sinceSeq);
}

/** 给 doc 编下一批时间线事件（改 doc.seq） */
export function stampEvents(doc: ProductionDoc, events: Array<Omit<TimelineEvent, "seq" | "at">>, at = new Date().toISOString()): TimelineEvent[] {
  return events.map((e) => ({ ...e, seq: ++doc.seq, at }));
}

/** 本轮最近一次认稿 / 撤回：有效认稿 = 最后一条是 script_approval（正文哈希另核） */
export function latestScriptDecision(doc: ProductionDoc): Decision | null {
  for (let i = doc.decisions.length - 1; i >= 0; i--) {
    const d = doc.decisions[i];
    if (d.round !== doc.round) continue;
    if (d.type === "script_approval" || d.type === "script_revoke" || d.type === "reopen") return d;
  }
  return null;
}

export function scriptApprovalFor(doc: ProductionDoc, body: string): Decision | null {
  const d = latestScriptDecision(doc);
  return d?.type === "script_approval" && d.body_hash === bodyHash(body) ? d : null;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- 启用版本（§4.1 影子模式）----

/** excluded：启用时对账失败、创始人明确排除的稿——它们留在旧行为（影子），卡片上标出来 */
export interface EnabledMarker { version: number; enabledAt: string; excluded: string[] }

export async function readEnabledMarker(dataDir?: string): Promise<EnabledMarker | null> {
  try { const m = JSON.parse(await fs.readFile(productionServiceDir(dataDir, "enabled.json"), "utf8")) as EnabledMarker; return { ...m, excluded: m.excluded ?? [] }; }
  catch (e) { if (isMissing(e)) return null; throw e; }
}

export async function readEnabledVersion(dataDir?: string): Promise<number | null> {
  return (await readEnabledMarker(dataDir))?.version ?? null;
}

/** 资料库级：本体启用了没有 */
export async function isOntologyEnabled(dataDir?: string): Promise<boolean> {
  return (await readEnabledVersion(dataDir)) === DERIVE_VERSION;
}

/** 这一条是否按本体规则走（启用了、且没被排除） */
export async function isOntologyActive(dataDir: string | undefined, contentId: string): Promise<boolean> {
  const m = await readEnabledMarker(dataDir);
  return m?.version === DERIVE_VERSION && !m.excluded.includes(contentId);
}

export async function writeEnabledVersion(dataDir: string | undefined, version = DERIVE_VERSION, excluded: string[] = []): Promise<void> {
  await writeJsonAtomicMkdir(productionServiceDir(dataDir, "enabled.json"), { version, enabledAt: new Date().toISOString(), excluded } satisfies EnabledMarker);
}

// ---- 冻结（§2.5）----

export const SCRIPT_FROZEN =
  "这条已进剪辑中，正文已冻结：剪辑按冻结那一版做。真要改稿，请创始人在看板卡片上点「重开文稿」（本轮的原片、成片、批准会转入历史）。";

export class ScriptFrozenError extends Error {
  readonly code = "script_frozen";
  constructor() { super(SCRIPT_FROZEN); }
}

export function isFrozen(doc: ProductionDoc | null): boolean {
  return Boolean(doc?.frozen && doc.frozen.round === doc.round);
}
