/**
 * 数据 ↔ 稿件的手动决定（数据页规格 §F.34–36）。
 *
 * outcomes.jsonl 是平台数据的原始流水，一个字不改；人手做的「关联到… / 和上一行是同一条 / 拆开」
 * 单独记在 <工作区>/outcome-links.json。自动匹配每次读的时候现算，手动决定永远盖过它（§36）。
 * 撤销 = 删掉那一条决定，这条作品就回到自动匹配。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";

export type LinkOp = "link" | "merge" | "split";

export interface LinkDecision {
  id: string;
  at: string;
  op: LinkOp;
  /** 作品键（见 data-rows.workKey）——这次决定管到的平台作品 */
  works: string[];
  /** op=link：挂到哪条稿件 */
  contentId?: string;
  /** op=merge：和哪条作品算同一条视频 */
  target?: string;
}

const FILE = "outcome-links.json";

function filePath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), FILE);
}

function isDecision(v: unknown): v is LinkDecision {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.at === "string" && (d.op === "link" || d.op === "merge" || d.op === "split")
    && Array.isArray(d.works) && d.works.every((w) => typeof w === "string");
}

/** 文件不在 = 还没有任何手动决定；文件坏了要报出来，不能当成「没有决定」悄悄让自动匹配盖回去 */
export async function readDecisions(dataDir?: string): Promise<LinkDecision[]> {
  let raw: string;
  try { raw = await fs.readFile(filePath(dataDir), "utf-8"); } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }
  const json = JSON.parse(raw) as { decisions?: unknown };
  if (!Array.isArray(json.decisions)) throw new Error(`${FILE} 格式不对：没有 decisions 列表`);
  return json.decisions.filter(isDecision);
}

async function writeDecisions(decisions: LinkDecision[], dataDir?: string): Promise<void> {
  await writeJsonAtomic(filePath(dataDir), { version: 1, decisions });
}

let chain: Promise<unknown> = Promise.resolve();
/** 同进程串行：两次点击挨得近也不会互相覆盖 */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export interface NewDecision { op: LinkOp; works: string[]; contentId?: string; target?: string }

export function validateDecision(d: NewDecision): string | null {
  if (!["link", "merge", "split"].includes(d.op)) return "不认识的操作";
  if (!Array.isArray(d.works) || d.works.length === 0 || !d.works.every((w) => typeof w === "string" && w)) return "没有指明是哪几条作品";
  if (d.op === "link" && !d.contentId) return "关联要指明稿件";
  if (d.op === "merge" && !d.target) return "合并要指明和哪一条是同一条";
  if (d.op === "merge" && d.works.includes(d.target!)) return "不能和自己合并";
  return null;
}

export function addDecision(input: NewDecision, dataDir?: string): Promise<LinkDecision> {
  const bad = validateDecision(input);
  if (bad) return Promise.reject(new Error(bad));
  return serial(async () => {
    const all = await readDecisions(dataDir);
    const d: LinkDecision = {
      id: randomUUID(), at: new Date().toISOString(), op: input.op, works: [...new Set(input.works)],
      ...(input.op === "link" ? { contentId: input.contentId } : {}),
      ...(input.op === "merge" ? { target: input.target } : {}),
    };
    await writeDecisions([...all, d], dataDir);
    return d;
  });
}

/** 撤销一条决定；找不到 = 已经撤过了，明说 */
export function removeDecision(id: string, dataDir?: string): Promise<{ removed: boolean }> {
  return serial(async () => {
    const all = await readDecisions(dataDir);
    const rest = all.filter((d) => d.id !== id);
    if (rest.length === all.length) return { removed: false };
    await writeDecisions(rest, dataDir);
    return { removed: true };
  });
}
