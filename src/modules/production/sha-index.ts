/**
 * 字节索引 sha256 → [(content_id, fact_id, kind, state)]（spec §2.2）：放工作区服务目录，可重建。
 * 启动顺序 = 恢复未完成事务 → 重建索引 → 开放写入。重建发现冲突（同一原片是两条稿的 accepted A-roll）
 * 照实报出，不后写覆盖。所有事实写入都在文件归属事务里，索引随之更新。
 */
import { listContents } from "../../storage/local-store.js";
import { productionServiceDir, readProductionDoc } from "../../storage/production-store.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";

export interface IndexEntry { content_id: string; fact_id: string; kind: Fact["kind"]; state: Fact["state"]; round: number }
export interface ShaIndex { entries: Record<string, IndexEntry[]>; conflicts: string[] }

const cache = new Map<string, ShaIndex>();

function indexFile(dataDir: string): string {
  return productionServiceDir(dataDir, "sha-index.json");
}

function entriesOf(contentId: string, doc: ProductionDoc): Array<[string, IndexEntry]> {
  return doc.facts.filter((f) => f.sha256).map((f) => [f.sha256!, { content_id: contentId, fact_id: f.id, kind: f.kind, state: f.state, round: f.round }]);
}

/** 当前轮 accepted A-roll 的归属（独占的唯一依据） */
function arollOwners(list: IndexEntry[], docs: Map<string, number>): IndexEntry[] {
  return list.filter((e) => e.kind === "aroll" && e.state === "accepted" && docs.get(e.content_id) === e.round);
}

export async function rebuildShaIndex(dataDir: string): Promise<ShaIndex> {
  const idx: ShaIndex = { entries: {}, conflicts: [] };
  const rounds = new Map<string, number>();
  for (const c of await listContents(dataDir)) {
    const doc = await readProductionDoc(c.id, dataDir).catch((e: unknown) => {
      idx.conflicts.push(`${c.id}：production.json 读不了（${e instanceof Error ? e.message : String(e)}）`);
      return null;
    });
    if (!doc) continue;
    rounds.set(c.id, doc.round);
    for (const [sha, e] of entriesOf(c.id, doc)) (idx.entries[sha] ??= []).push(e);
  }
  for (const [sha, list] of Object.entries(idx.entries)) {
    const owners = new Set(arollOwners(list, rounds).map((e) => e.content_id));
    if (owners.size > 1) idx.conflicts.push(`原片 ${sha.slice(0, 12)} 同时是 ${[...owners].join("、")} 的 A-roll`);
  }
  cache.set(dataDir, idx);
  await writeJsonAtomicMkdir(indexFile(dataDir), { version: 1, rebuiltAt: new Date().toISOString(), ...idx });
  return idx;
}

export async function shaIndex(dataDir: string): Promise<ShaIndex> {
  return cache.get(dataDir) ?? rebuildShaIndex(dataDir);
}

/** 某条稿的事实变了：替换它在索引里的全部条目并落盘 */
export async function reindexContent(dataDir: string, contentId: string, doc: ProductionDoc): Promise<void> {
  const idx = await shaIndex(dataDir);
  for (const [sha, list] of Object.entries(idx.entries)) {
    const rest = list.filter((e) => e.content_id !== contentId);
    if (rest.length) idx.entries[sha] = rest;
    else delete idx.entries[sha];
  }
  for (const [sha, e] of entriesOf(contentId, doc)) (idx.entries[sha] ??= []).push(e);
  await writeJsonAtomicMkdir(indexFile(dataDir), { version: 1, rebuiltAt: new Date().toISOString(), ...idx });
}

/**
 * 这份原片归别条稿 → 那条稿的 id。本轮 accepted 的是硬归属；重开文稿之后上一轮的原片仍归那条稿（创始人 09-29 默认），
 * 只有创始人明确改挂（`allowHistorical`）才放过历史归属。
 */
export async function arollOwnerElsewhere(dataDir: string, sha: string, contentId: string, opts: { allowHistorical?: boolean } = {}): Promise<string | null> {
  const list = (await shaIndex(dataDir)).entries[sha] ?? [];
  for (const e of list) {
    if (e.content_id === contentId || e.kind !== "aroll" || e.state !== "accepted") continue;
    const doc = await readProductionDoc(e.content_id, dataDir).catch(() => null);
    if (!doc) continue;
    // 创始人明确改挂过（归属已转移）：这条稿不再拥有它
    if (doc.facts.find((f) => f.id === e.fact_id)?.released_to) continue;
    if (doc.round === e.round || !opts.allowHistorical) return e.content_id;
  }
  return null;
}

export function forgetShaIndex(dataDir?: string): void {
  if (dataDir) cache.delete(dataDir);
  else cache.clear();
}
