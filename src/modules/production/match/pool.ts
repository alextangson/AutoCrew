/**
 * 比对池（1b §2）：未删除、未归档、有正文的视频稿。A-roll 比对用有效认稿前后的稿（draft_ready 起，含剪辑中——
 * 多 take 要能被认出来）。正文取冻结副本（有）否则当前正文。
 */
import { listContents, type Content, type ContentStatus } from "../../../storage/local-store.js";
import { bodyHash, readProductionDoc } from "../../../storage/production-store.js";
import { isVideoPlatform } from "../../../storage/stage-guard.js";
import { frozenCopy } from "../service.js";

/** 「draft_ready 起」包括审稿中 / 修订中：写稿段、已有正文、还能被认稿（Codex 审 segB18 P2） */
export const AROLL_POOL_STATUS: ReadonlySet<ContentStatus> = new Set(["draft_ready", "reviewing", "revision", "approved", "editing", "cover_pending"]);

export interface PoolEntry { content_id: string; title: string; old_titles: string[]; round: number; body_hash: string; body: string }

export function inArollPool(c: Content): boolean {
  return isVideoPlatform(c.platform) && !c.deletedAt && AROLL_POOL_STATUS.has(c.status) && Boolean((c.body ?? "").trim());
}

async function entryOf(c: Content, dataDir: string): Promise<PoolEntry> {
  const doc = await readProductionDoc(c.id, dataDir).catch(() => null);
  const frozen = doc ? await frozenCopy(c.id, dataDir, doc) : null;
  const body = frozen ?? c.body ?? "";
  const old = [...new Set((c.versions ?? []).map((v) => v.title ?? "").filter((t) => t && t !== c.title))];
  return { content_id: c.id, title: c.title, old_titles: old, round: doc?.round ?? 1, body_hash: bodyHash(body), body };
}

/** `include`：明确要的那条（agent record 的目标）不在池状态里也算进来 */
export async function arollPool(dataDir: string, include?: string): Promise<PoolEntry[]> {
  const all = await listContents(dataDir);
  const picked = all.filter((c) => inArollPool(c) || (c.id === include && isVideoPlatform(c.platform) && !c.deletedAt && c.status !== "archived"));
  return Promise.all(picked.map((c) => entryOf(c, dataDir)));
}
