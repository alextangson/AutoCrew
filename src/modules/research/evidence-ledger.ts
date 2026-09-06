/**
 * 证据账本（P1 spec §3.3）——**每稿一份**，写手与修订轮共享同一个实例。
 *
 * 存在理由：数字硬门要回答的问题不是「这个数字在某段文字里出现过吗」，而是
 * 「这个数字是**哪条已核验证据**给的」。所以一稿里所有可引用的材料先在这里登记，
 * 拿到稳定 id，正文里的每个数字最终都要能指回一条条目。
 *
 * 三类来源，权重完全不同：
 * - `verified_quote`：简报证据 `ev-N`、定向补证 `ev-T<n>.<i>`、写手查证——**只有这一类算「外部已核验」**；
 * - `own_claim`：我们自己的转写/放行稿片段（`om:` 开头），是第一手但不是外部核验；
 * - `user_claim`：创始人给的 `research` 与选题描述（`user-<n>`），一律按未核验对待。
 *
 * 共享的不只是条目：`budget` 是**同一份** `find_evidence` 次数（每稿 3 次）。
 * 写手用掉 2 次、修订轮只剩 1 次——这正是要的行为（codex #13：两侧各自计数等于没有上限）。
 * 因此一次生成必须只 `createEvidenceLedger()` 一次，然后把同一个实例传给写手和修订。
 */
import type { ResearchBrief } from "./brief-store.js";
import { evidenceRefId } from "./brief-store.js";

export type LedgerSource = "verified_quote" | "own_claim" | "user_claim";

export interface LedgerEntry {
  /** 稳定引用 id：简报 `ev-N`、补证 `ev-T<n>.<i>`、内部语料 `om:...`、用户材料 `user-<n>` */
  id: string;
  source: LedgerSource;
  /** 这条证据支撑什么（一句话）；内部语料/用户材料可省 */
  claim?: string;
  /** 逐字原文。`verified_quote` 已回原页校验过 */
  quote: string;
  /** broker 登记的来源 id（p 开头）——仅补证/写手查证有 */
  sourceId?: string;
  sourceUrl?: string;
  /** 由哪条「证据需求」查来的——仅补证/写手查证有 */
  need?: string;
}

/** 一次定向补证/写手查证的过程记录。找不到也要留痕：落盘后看得出「问过、没有」 */
export interface LookupRecord {
  need: string;
  status: "found" | "empty" | "timeout" | "failed";
  /** 本次查到并登记进账本的条目 id（按登记序） */
  itemIds: string[];
  /** 模型交回的缺口说明，或失败/超时原因 */
  gaps: string[];
  tokens: number;
  turns: number;
  startedAt: string;
  endedAt: string;
}

/** `find_evidence` 的调用次数闸。写手与修订共享同一个实例——用完就是用完 */
export interface LookupBudget {
  readonly max: number;
  used(): number;
  /** 扣一次；配额已耗尽返回 false（不抛——调用方要把它变成给模型的人话） */
  take(): boolean;
}

/** 落盘形态（`Content.evidenceLedger`）：纯 JSON，读侧不依赖任何方法 */
export interface EvidenceLedgerSnapshot {
  entries: LedgerEntry[];
  lookups: LookupRecord[];
  budget: { max: number; used: number };
}

export interface EvidenceLedger {
  /** 不带 id = 代码分配 `led-<n>`；id 已存在则原样返回已有条目（重复播种是幂等的） */
  add(entry: Omit<LedgerEntry, "id"> & { id?: string }): LedgerEntry;
  entries(): readonly LedgerEntry[];
  lookups(): readonly LookupRecord[];
  recordLookup(lookup: LookupRecord): void;
  budget: LookupBudget;
  snapshot(): EvidenceLedgerSnapshot;
}

/** 每稿 `find_evidence` 次数（spec §3.3） */
export const DEFAULT_MAX_LOOKUPS = 3;

function createBudget(max: number, initialUsed = 0): LookupBudget {
  let used = Math.max(0, Math.min(initialUsed, max));
  return {
    max,
    used: () => used,
    take() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
  };
}

/** 只留有值的可选字段：落盘 JSON 里不出现一堆 undefined 键 */
function compact(entry: LedgerEntry): LedgerEntry {
  const out: LedgerEntry = { id: entry.id, source: entry.source, quote: entry.quote };
  if (entry.claim) out.claim = entry.claim;
  if (entry.sourceId) out.sourceId = entry.sourceId;
  if (entry.sourceUrl) out.sourceUrl = entry.sourceUrl;
  if (entry.need) out.need = entry.need;
  return out;
}

export function createEvidenceLedger(opts: { maxLookups?: number } = {}): EvidenceLedger {
  return buildLedger({ max: opts.maxLookups ?? DEFAULT_MAX_LOOKUPS, used: 0 });
}

/**
 * 从落盘快照续一本账（P3 spec §5.2）。宿主写稿是**跨调用**的：领包一次、补证三次、
 * 提交若干次，每次都是独立进程调用——账本只能从 `writing-pack.json` 的快照里恢复。
 *
 * 两条续法必须同时成立，缺一条就是静默的数据错：
 * - **id 从快照最大号续**：`led-<n>` 的分配号回到 0 会让新条目撞上旧 id，
 *   而 `add` 遇到已存在的 id 是**返回旧条目**——新证据会被无声吞掉。
 * - **配额从 `used` 续**：不续就是每次调用都重置 3 次额度，等于没有上限（codex #13 同款）。
 */
export function restoreEvidenceLedger(
  snapshot: EvidenceLedgerSnapshot,
  budget?: { max?: number; used?: number },
): EvidenceLedger {
  const entries = snapshot?.entries ?? [];
  const ledger = buildLedger({
    max: budget?.max ?? snapshot?.budget?.max ?? DEFAULT_MAX_LOOKUPS,
    used: budget?.used ?? snapshot?.budget?.used ?? 0,
    seq: maxAutoSeq(entries),
  });
  for (const entry of entries) ledger.add(entry);
  for (const lookup of snapshot?.lookups ?? []) ledger.recordLookup(lookup);
  return ledger;
}

/** 快照里代码自动分配过的最大号（`led-<n>`）——恢复后的分配从它之后继续 */
function maxAutoSeq(entries: readonly LedgerEntry[]): number {
  let max = 0;
  for (const entry of entries) {
    const hit = /^led-(\d+)$/.exec(entry?.id ?? "");
    if (hit) max = Math.max(max, Number(hit[1]));
  }
  return max;
}

function buildLedger(init: { max: number; used: number; seq?: number }): EvidenceLedger {
  const byId = new Map<string, LedgerEntry>();
  const order: string[] = [];
  const lookupLog: LookupRecord[] = [];
  const budget = createBudget(init.max, init.used);
  let seq = init.seq ?? 0;

  return {
    budget,
    add(input) {
      const id = input.id?.trim() || `led-${++seq}`;
      const existing = byId.get(id);
      if (existing) return existing;
      const entry = compact({ ...input, id } as LedgerEntry);
      byId.set(id, entry);
      order.push(id);
      return entry;
    },
    entries: () => order.map((id) => byId.get(id)!),
    lookups: () => lookupLog.slice(),
    recordLookup(lookup) {
      lookupLog.push({ ...lookup, itemIds: [...lookup.itemIds], gaps: [...lookup.gaps] });
    },
    snapshot() {
      return {
        entries: order.map((id) => ({ ...byId.get(id)! })),
        lookups: lookupLog.map((l) => ({ ...l, itemIds: [...l.itemIds], gaps: [...l.gaps] })),
        budget: { max: budget.max, used: budget.used() },
      };
    },
  };
}

// ─── 播种（一稿开工时把已有材料一次性登记进来） ──────────────────────────────

/** 简报证据：id 沿用简报内的 `ev-N`（位置即身份，同版简报永不改写） */
export function seedLedgerFromBrief(ledger: EvidenceLedger, brief: ResearchBrief): void {
  brief.evidence.forEach((ev, i) => {
    if (!ev?.quote?.trim()) return;
    ledger.add({
      id: evidenceRefId(i),
      source: "verified_quote",
      claim: ev.claim,
      quote: ev.quote,
      sourceUrl: ev.sourceUrl,
    });
  });
}

/** 内部语料片段：id 就是 `om:<contentId>:<kind>:<rev>:<idx>`，整段文本即引文 */
export function seedLedgerFromOwnMaterial(
  ledger: EvidenceLedger,
  chunks: { id: string; text: string }[],
): void {
  for (const chunk of chunks) {
    if (!chunk?.text?.trim()) continue;
    ledger.add({ id: chunk.id, source: "own_claim", quote: chunk.text });
  }
}

/** 用户材料（`req.research` / 选题描述）：调用方没给 id 就编 `user-<n>` */
export function seedLedgerFromUserClaims(
  ledger: EvidenceLedger,
  texts: { id: string; text: string }[],
): void {
  texts.forEach((t, i) => {
    if (!t?.text?.trim()) return;
    ledger.add({ id: t.id?.trim() || `user-${i + 1}`, source: "user_claim", quote: t.text });
  });
}
