/**
 * 出立意卡前按候选体裁预览范文（spec 2026-10-15 §2.4、§10、§15.9、§15.10、§15.16）。只读。
 * - 最多 3 篇，完整全文，回执带每篇字数和版本；预算不够就少给一篇，绝不截半篇。
 * - 先给完整范文，再给结构卡 / 手法卡；本体裁没有就写明「本体裁无范文」，不拿别的体裁凑数（跨体裁手法卡 any 可以给）。
 * - 近 30 天用过 ≥2 次的往后排：有替补才跳过。使用次数每篇稿只算一次（按稿上锁的范文算，续写不重复计）。
 * - 某篇文件坏了：报在 errors 里、跳过这篇，不当成空库。
 */
import { listContents } from "../../storage/local-store.js";
import { readExemplarManifest, readExemplarText } from "./store.js";
import type { ExemplarEntry, ExemplarGenre, ExemplarPin } from "./types.js";

export const PREVIEW_MAX = 3;
export const PREVIEW_BUDGET_CHARS = 18_000;
export const OVERUSE_WINDOW_DAYS = 30;
export const OVERUSE_COUNT = 2;
const KIND_RANK = { exemplar: 0, structure_card: 1, technique_card: 2, voice_ref: 9 } as const;

/** 近 30 天每篇范文被几篇稿锁过（每篇稿一次；不算正在写的这篇） */
export async function exemplarUsage(excludeContentId: string | undefined, dataDir?: string, now = Date.now()): Promise<Map<string, number>> {
  const since = now - OVERUSE_WINDOW_DAYS * 86_400_000;
  const used = new Map<string, number>();
  for (const c of await listContents(dataDir)) {
    const angle = c.draftPath?.angle;
    if (c.id === excludeContentId || c.deletedAt || !angle?.exemplars?.length) continue;
    const t = Date.parse(angle.exemplars_at ?? angle.at);
    if (!Number.isFinite(t) || t < since) continue;
    for (const id of new Set(angle.exemplars.map((e) => e.id))) used.set(id, (used.get(id) ?? 0) + 1);
  }
  return used;
}

function ordered(entries: ExemplarEntry[], genre: ExemplarGenre, used: Map<string, number>): ExemplarEntry[] {
  const over = (e: ExemplarEntry) => ((used.get(e.id) ?? 0) >= OVERUSE_COUNT ? 1 : 0);
  const rank = (e: ExemplarEntry) => (e.genre === genre ? 0 : 1) * 10 + KIND_RANK[e.kind];
  return entries.filter((e) => e.kind !== "voice_ref" && (e.genre === genre || e.genre === "any"))
    // 本体裁永远排在跨体裁手法卡前面；用过多次的只让给本体裁的替补（不让 any 卡把它挤掉）
    .sort((a, b) => (a.genre === genre ? 0 : 1) - (b.genre === genre ? 0 : 1) || over(a) - over(b) || rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export interface PreviewEntry { id: string; version: number; title: string; kind: string; genre: string; chars: number; used_30d: number; text: string }
export interface ExemplarPreview {
  genre: ExemplarGenre; entries: PreviewEntry[]; budget_chars: number;
  skipped: Array<{ id: string; reason: string }>; errors: Array<{ id: string; error: string }>; note?: string;
}

/** 按体裁挑最多 3 篇全文 */
export async function previewExemplars(genre: ExemplarGenre, contentId: string | undefined, dataDir?: string, now = Date.now()): Promise<ExemplarPreview> {
  const m = await readExemplarManifest(dataDir);
  const used = await exemplarUsage(contentId, dataDir, now);
  const out: ExemplarPreview = { genre, entries: [], budget_chars: PREVIEW_BUDGET_CHARS, skipped: [], errors: [] };
  let spent = 0;
  for (const e of ordered(m.exemplars, genre, used)) {
    const n = used.get(e.id) ?? 0;
    if (out.entries.length >= PREVIEW_MAX) { out.skipped.push({ id: e.id, reason: n >= OVERUSE_COUNT ? `近 30 天已用 ${n} 次，有替补` : "已够 3 篇" }); continue; }
    let text: string;
    try { text = await readExemplarText(e.id, e.current, dataDir, m); } catch (err) { out.errors.push({ id: e.id, error: (err as Error).message }); continue; }
    const size = Array.from(text).length;
    if (spent + size > PREVIEW_BUDGET_CHARS) { out.skipped.push({ id: e.id, reason: `全文 ${size} 字，放进来会超过 ${PREVIEW_BUDGET_CHARS} 字预算（不截半篇）` }); continue; }
    spent += size;
    out.entries.push({ id: e.id, version: e.current, title: e.title, kind: e.kind, genre: e.genre, chars: size, used_30d: n, text });
  }
  // 结构卡、手法卡不算范文（创始人 2026-10-15）
  if (!out.entries.some((x) => x.genre === genre && x.kind === "exemplar")) {
    out.note = out.entries.some((x) => x.genre === genre)
      ? "本体裁只有结构卡，没有完整范文：立意卡上写明这一点，创始人选卡时知道风险"
      : "本体裁无范文：立意卡上写明「本体裁无范文」，创始人选卡时知道风险";
  }
  return out;
}

/** 续写 / 改稿：按稿上锁的 {id, version} 原样取全文；读不了的逐篇报错，不换别的 */
export async function lockedExemplars(pins: ExemplarPin[], dataDir?: string): Promise<{ entries: PreviewEntry[]; errors: Array<{ id: string; error: string }> }> {
  const m = await readExemplarManifest(dataDir);
  const entries: PreviewEntry[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  for (const p of pins) {
    const e = m.exemplars.find((x) => x.id === p.id);
    try {
      const text = await readExemplarText(p.id, p.version, dataDir, m);
      entries.push({ id: p.id, version: p.version, title: e?.title ?? p.id, kind: e?.kind ?? "exemplar", genre: e?.genre ?? "any", chars: Array.from(text).length, used_30d: 0, text });
    } catch (err) {
      errors.push({ id: p.id, error: (err as Error).message });
    }
  }
  return { entries, errors };
}

/** angle 交来的锁：每篇都要在库里、版本存在、体裁对得上（本体裁或 any） */
export async function validatePins(pins: ExemplarPin[], genre: ExemplarGenre, dataDir?: string): Promise<string | null> {
  const m = await readExemplarManifest(dataDir);
  for (const p of pins) {
    const e = m.exemplars.find((x) => x.id === p.id);
    if (!e || e.kind === "voice_ref") return `范文库里没有 ${p.id}：只能锁 exemplars 预览里给过的`;
    if (!e.versions.some((v) => v.version === p.version)) return `范文 ${p.id} 没有第 ${p.version} 版`;
    if (e.genre !== genre && e.genre !== "any") return `范文 ${p.id} 是 ${e.genre} 体裁的，不能给 ${genre} 凑数`;
    try { await readExemplarText(p.id, p.version, dataDir, m); } catch (err) { return `范文 ${p.id} 第 ${p.version} 版锁不了：${(err as Error).message}`; }
  }
  return null;
}

/** 手册里点名的范文（`bench-…`）有哪些不在库里：降级成看得见的提示，不报错（§ 迁移第 8 项） */
export async function missingExemplarRefs(text: string, dataDir?: string): Promise<Array<{ id: string; note: string }>> {
  const ids = [...new Set(text.match(/\bbench-[a-z0-9-]+/g) ?? [])];
  if (!ids.length) return [];
  const have = new Set((await readExemplarManifest(dataDir)).exemplars.map((e) => e.id));
  return ids.filter((id) => !have.has(id)).map((id) => ({ id, note: "范文库里没有这篇" }));
}
