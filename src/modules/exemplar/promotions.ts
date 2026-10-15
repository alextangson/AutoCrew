/**
 * 改稿意见升级成「范文批注」或「写法」的提案（spec 2026-10-15 §6、§15.6、§15.8）。
 * 存 <dataDir>/exemplars/promotions.json，进「等你拍板」。创始人批准后只标成「已批、等人工改」：
 * 不自动改范文、不自动改技能文件（写法在仓库里，要随代码发布才生效）。手册骨架的升级不走这里，走手册提案。
 * 文件读坏了 = 可见错误，不当成没有提案、不覆盖。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { contentHash, exemplarsDir, serializeExemplars } from "./store.js";
import { ExemplarError } from "./types.js";

export type PromotionTarget = "exemplar" | "method";
export type PromotionStatus = "pending" | "approved_pending_manual_apply" | "rejected";

export interface PromotionCite { content_id: string; index: number; founder_words: string }
export interface Promotion {
  id: string;
  target: PromotionTarget;
  /** target=exemplar：给哪篇范文加批注 */
  exemplar_id?: string;
  /** 批注（改前 → 改后片段）或写法的改动全文 */
  text: string;
  reason: string;
  cites: PromotionCite[];
  status: PromotionStatus;
  gen: string;
  at: string;
  decided_at?: string;
  founder_words?: string;
}
interface PromotionFile { schema: 1; items: Promotion[] }

const file = (dataDir?: string) => path.join(exemplarsDir(dataDir), "promotions.json");

export async function readPromotions(dataDir?: string): Promise<Promotion[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ExemplarError("promotions_unreadable", `升级提案读不了：${(e as Error).message}`);
  }
  try {
    const f = JSON.parse(raw) as PromotionFile;
    if (f?.schema !== 1 || !Array.isArray(f.items)) throw new Error("结构不对");
    return f.items;
  } catch (e) {
    throw new ExemplarError("promotions_corrupt", `升级提案 ${file(dataDir)} 解析失败（${(e as Error).message}）：没有覆盖它`);
  }
}

const write = async (items: Promotion[], dataDir?: string) => { assertDataDirWritable(dataDir); await writeJsonAtomicMkdir(file(dataDir), { schema: 1, items }); };

export interface PromotionInput { target: PromotionTarget; exemplar_id?: string; text: string; reason: string; cites: PromotionCite[] }

/** 记一份提案：同样的待批 = duplicate；否决过的同文 = blocked_by_rejected */
export function proposePromotion(x: PromotionInput, dataDir?: string): Promise<{ outcome: "proposed" | "duplicate" | "blocked_by_rejected"; id: string }> {
  return serializeExemplars(dataDir, async () => {
    const items = await readPromotions(dataDir);
    const same = items.find((p) => p.target === x.target && p.exemplar_id === x.exemplar_id && p.text.trim() === x.text.trim() && p.status !== "approved_pending_manual_apply");
    if (same?.status === "rejected") return { outcome: "blocked_by_rejected" as const, id: same.id };
    if (same) return { outcome: "duplicate" as const, id: same.id };
    const id = `wp-${randomUUID()}`;
    const p: Promotion = { id, target: x.target, ...(x.exemplar_id ? { exemplar_id: x.exemplar_id } : {}), text: x.text.trim(), reason: x.reason, cites: x.cites,
      status: "pending", gen: contentHash(JSON.stringify([id, x.text])), at: new Date().toISOString() };
    await write([...items, p], dataDir);
    return { outcome: "proposed" as const, id };
  });
}

/** 创始人批 / 不要：只改状态。gen 对不上 = 内容变过；已定过 = already_handled */
export function decidePromotion(id: string, gen: string, decision: "approve" | "reject", founderWords: string, dataDir?: string): Promise<Promotion> {
  return serializeExemplars(dataDir, async () => {
    const items = await readPromotions(dataDir);
    const p = items.find((x) => x.id === id);
    if (!p) throw new ExemplarError("not_found", `没有这份升级提案：${id}`);
    if (p.status !== "pending") throw new ExemplarError("already_handled", "这份升级提案已经定过了");
    if (p.gen !== gen) throw new ExemplarError("stale", "提案内容和你给创始人看的对不上：重新 list 再给他看");
    Object.assign(p, { status: decision === "approve" ? "approved_pending_manual_apply" : "rejected", decided_at: new Date().toISOString(), founder_words: founderWords });
    await write(items, dataDir);
    return p;
  });
}
