/**
 * 封面组（spec 2026-09-30-review-inbox §6）：一组 = 一个版本，成对只按显式记录，不猜。纯函数，零 I/O。
 *
 * - 成员关系单独存（组 ↔ 事实，带历史，不删）：同一 sha 被用进新组 = 新增一条成员关系，旧组不动（Codex 9）。
 * - 「有效组」只有一个选择器（Codex 11）：本轮、没被「这组不要了」作废、成员事实仍 accepted 且字节没被替换。
 *   列表、工作台、批准、推导、对账、30 组上限都走它。
 * - 统一准入（§6.2，Codex 12）：只有 `05-cover/vNNN/` 与 `05-cover/final/` 收为正式组；其余目录按比例找到的只做候选。
 *   迁移：已收为 accepted、来自其他目录、且不属于有效批准的封面 → 转候选并写原因；属于有效批准的不动。只改标签，不动文件。
 */
import path from "node:path";
import { newId } from "../../storage/production-store.js";
import { strayCoverReason } from "./plain-reason.js";
import type { CoverGroup, CoverMember, CoverRatio, Fact, ProductionDoc } from "../../storage/production-types.js";

export const MAX_COVER_GROUPS = 30;
const VERSION_DIR = /^v0*(\d+)$/i;

export interface GroupKey { label: string; version?: number }

/** 项目内相对路径 → 它属于哪个正式组；不在 vNNN/ 或 final/ 顶层 → null（只能做候选） */
export function admittedGroupKey(rel: string | undefined): GroupKey | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.length !== 3 || parts[0] !== "05-cover") return null;
  const m = VERSION_DIR.exec(parts[1]);
  if (m) { const version = Number(m[1]); return { label: versionLabelOf(version), version }; }
  return parts[1] === "final" ? { label: "final" } : null;
}

export const versionLabelOf = (v: number) => `v${String(v).padStart(3, "0")}`;

const retiredIds = (doc: ProductionDoc): Set<string> =>
  new Set(doc.decisions.filter((d) => d.type === "cover_group_retire" && d.group_id).map((d) => d.group_id!));

export interface GroupView {
  group: CoverGroup;
  /** 每个比例下的活成员 */
  slots: Record<CoverRatio, Fact[]>;
  /** 两个比例各恰好一张 */
  complete: boolean;
  /** 某个比例不止一张：说不清用哪张，不能挑 */
  ambiguous: boolean;
  /** 最近一次成员变动的时间：「比已批更新的组」按它比 */
  at: string;
  /** 这组的默认封面字（成员事实报上来的字） */
  text: string;
  /** 这组有文件被覆盖了（说给创始人听的原因）；没有 = null */
  broken: string | null;
}

/** 成员活着：事实 accepted、sha 没换；这一组自己那份文件没被覆盖（有自己路径的成员按自己的，旧成员按事实的） */
function liveCover(doc: ProductionDoc, m: CoverMember): Fact | null {
  const f = doc.facts.find((x) => x.id === m.fact_id);
  if (!f || f.kind !== "cover" || f.state !== "accepted" || f.sha256 !== m.sha256 || f.ratio !== m.ratio) return null;
  return (m.path ? m.replaced_at : f.replaced_at) ? null : f;
}

function viewOf(doc: ProductionDoc, g: CoverGroup, members: CoverMember[]): GroupView | null {
  const slots: Record<CoverRatio, Fact[]> = { "3:4": [], "4:3": [] };
  let at = g.at;
  for (const m of members.filter((x) => x.group_id === g.id)) {
    const f = liveCover(doc, m);
    if (!f || slots[m.ratio].some((x) => x.id === f.id)) continue;
    slots[m.ratio].push(f);
    if (m.at > at) at = m.at;
  }
  if (!slots["3:4"].length && !slots["4:3"].length) return null;
  const text = [...slots["3:4"], ...slots["4:3"]].map((f) => f.text ?? "").find(Boolean) ?? "";
  const gone = members.filter((m) => m.group_id === g.id && m.path && m.replaced_at).map((m) => m.ratio);
  const broken = gone.length ? `这组的 ${[...new Set(gone)].join("、")} 文件被换过了，这组不完整了` : null;
  return { group: g, slots, complete: slots["3:4"].length === 1 && slots["4:3"].length === 1, ambiguous: slots["3:4"].length > 1 || slots["4:3"].length > 1, at, text, broken };
}

/** 唯一的「有效组」选择器：本轮、没作废、至少一张活成员；按时间从旧到新 */
export function validCoverGroups(doc: ProductionDoc): GroupView[] {
  const retired = retiredIds(doc);
  const members = doc.cover_members ?? [];
  return (doc.cover_groups ?? []).filter((g) => g.round === doc.round && !retired.has(g.id))
    .map((g) => viewOf(doc, g, members)).filter((v): v is GroupView => v !== null)
    .sort((a, b) => a.at.localeCompare(b.at) || a.group.id.localeCompare(b.group.id));
}

export function groupById(doc: ProductionDoc, id: string): GroupView | null {
  return validCoverGroups(doc).find((g) => g.group.id === id) ?? null;
}

/** 本轮同一目录（label）里被「这组不要了」作废过的组：对账不能按目录把它复活（Codex 审 2a-1 P2） */
export function retiredGroupOfLabel(doc: ProductionDoc, label: string): CoverGroup | null {
  const retired = retiredIds(doc);
  const live = (doc.cover_groups ?? []).some((g) => g.round === doc.round && g.label === label && !retired.has(g.id));
  return live ? null : (doc.cover_groups ?? []).find((g) => g.round === doc.round && g.label === label && retired.has(g.id)) ?? null;
}

export function isRetired(doc: ProductionDoc, groupId: string): boolean {
  return retiredIds(doc).has(groupId);
}

/** 这两张（3:4 / 4:3）同属一个有效、完整、没作废的组 → 那个组 */
export function groupOfPair(doc: ProductionDoc, a: Fact, b: Fact): GroupView | null {
  return validCoverGroups(doc).find((g) => g.complete && g.slots["3:4"][0].id === a.id && g.slots["4:3"][0].id === b.id) ?? null;
}

/** 下一个版本号：任何一轮、任何组 / 事实用过的都不再用（盘上的 vNNN 目录不复用） */
export function nextCoverVersion(doc: ProductionDoc): number {
  const used = [...(doc.cover_groups ?? []).map((g) => g.version ?? 0), ...doc.facts.filter((f) => f.kind === "cover").map((f) => f.version ?? 0)];
  return Math.max(0, ...used) + 1;
}

/** 本轮某版本号的组（没作废的） */
export function groupOfVersion(doc: ProductionDoc, version: number): CoverGroup | null {
  const retired = retiredIds(doc);
  return (doc.cover_groups ?? []).find((g) => g.round === doc.round && g.version === version && !retired.has(g.id)) ?? null;
}

/** 本轮含某事实的全部有效组（同一张图可以在几组里） */
export function groupsOfFact(doc: ProductionDoc, factId: string): GroupView[] {
  return validCoverGroups(doc).filter((g) => g.slots["3:4"].some((f) => f.id === factId) || g.slots["4:3"].some((f) => f.id === factId));
}

export function ensureGroup(doc: ProductionDoc, key: GroupKey, init: Pick<CoverGroup, "source" | "by" | "evidence">, at = new Date().toISOString(), id?: string): CoverGroup {
  const retired = retiredIds(doc);
  const hit = (doc.cover_groups ?? []).find((g) => g.round === doc.round && g.label === key.label && !retired.has(g.id));
  if (hit) return hit;
  const g: CoverGroup = { id: id ?? newId("cg"), round: doc.round, ...(key.version ? { version: key.version } : {}), label: key.label, at, ...init };
  doc.cover_groups = [...(doc.cover_groups ?? []), g];
  return g;
}

/** 加成员关系（同组同事实只记一次）；返回是否新加 */
export function addMember(doc: ProductionDoc, group: CoverGroup, fact: Fact, at = new Date().toISOString(), memberPath?: string): boolean {
  if (!fact.sha256 || !fact.ratio) return false;
  if ((doc.cover_members ?? []).some((m) => m.group_id === group.id && m.fact_id === fact.id)) return false;
  const p = memberPath ?? fact.path;
  // 这一组这个位置的文件被覆盖过：不拿新字节补位（这组就是缺这张，等重新成组）
  if (p && (doc.cover_members ?? []).some((m) => m.group_id === group.id && m.path === p && m.replaced_at)) return false;
  doc.cover_members = [...(doc.cover_members ?? []), { group_id: group.id, fact_id: fact.id, sha256: fact.sha256, ratio: fact.ratio, at, ...(p ? { path: p } : {}) }];
  return true;
}

/** 这个比例在这组里已经有活成员了（显式成对时不许同比例挤进来） */
export function slotTaken(doc: ProductionDoc, group: CoverGroup, ratio: CoverRatio, exceptFactId?: string): boolean {
  const v = viewOf(doc, group, doc.cover_members ?? []);
  return Boolean(v?.slots[ratio].some((f) => f.id !== exceptFactId));
}

export interface MigrationChange { fact_id: string; to: "candidate" | "grouped"; reason: string }

/**
 * §6.2 迁移（纯函数，就地改 doc）：本轮 accepted 封面——
 * - 在 vNNN/ 或 final/ → 按目录建组、记成员；
 * - 属于有效批准（`approvedShas`）→ 不动状态，两张同在一个「已批准」组里；
 * - 其余 → 转候选并写原因。只改标签，不动文件。已迁移过（cover_schema=1）不再跑。
 */
export function migrateCoverGroups(doc: ProductionDoc, approvedShas: ReadonlySet<string>): MigrationChange[] {
  if (doc.cover_schema === 1) return [];
  const out: MigrationChange[] = [];
  const covers = doc.facts.filter((f) => f.round === doc.round && f.kind === "cover" && f.state === "accepted").sort((a, b) => a.at.localeCompare(b.at));
  const approved: Fact[] = [];
  for (const f of covers) {
    const key = admittedGroupKey(f.path);
    if (key) {
      // 迁移出来的组 id 固定（读方在内存里迁移时每次都一样，条目 id 与代次才稳定）
      if (addMember(doc, ensureGroup(doc, key, { source: "migration", evidence: `迁移：${key.label} 目录里的封面` }, f.at, `cg-m${doc.round}-${key.label}`), f, f.at)) out.push({ fact_id: f.id, to: "grouped", reason: key.label });
      continue;
    }
    if (f.sha256 && approvedShas.has(f.sha256) && !f.replaced_at) { approved.push(f); continue; }
    // 只改标签（source=migration）：它们不进「等你拍板」，只在卡片上收成一行「以前的封面文件」
    f.state = "candidate";
    f.source = "migration";
    f.evidence = strayCoverReason(f.path);
    out.push({ fact_id: f.id, to: "candidate", reason: f.evidence });
  }
  if (approved.length) {
    const g = ensureGroup(doc, { label: "已批准" }, { source: "migration", evidence: "迁移：已批准的那一组（原目录不在 vNNN/ 或 final/）" }, approved[0].at, `cg-m${doc.round}-approved`);
    for (const f of approved) if (addMember(doc, g, f, f.at)) out.push({ fact_id: f.id, to: "grouped", reason: "已批准" });
  }
  doc.cover_schema = 1;
  return out;
}

/** 读方用：还没迁移的 doc 在内存里按同一条规则迁移（不写盘；对账写盘后读方看到的是同一个结果） */
export function withCoverGroups(doc: ProductionDoc, approvedShas: ReadonlySet<string>): ProductionDoc {
  if (doc.cover_schema === 1) return doc;
  const next = structuredClone(doc);
  migrateCoverGroups(next, approvedShas);
  return next;
}
