/** 写作手册页的数据形状与纯函数（spec 2026-10-13 §4、§5）：只摆数，样本不够就不比。 */

export interface DiffHunk { before: string[]; after: string[] }
export interface PlaybookVersion {
  version: number; at: string; author: "founder" | "agent"; kind: "seed" | "edit" | "rollback";
  founder_words?: string; reason?: string; based_on?: number; rolled_back_to?: number;
}
export interface PlaybookProposalView {
  id: string; kind: "lesson" | "revision"; based_on: number; gen: string; reason: string; founder_words: string; at: string;
  origin: { content_id: string; version: number } | null; diff: DiffHunk[];
}
export interface PlaybookView { id: string; name: string; current: number; text: string; versions: PlaybookVersion[]; proposals: PlaybookProposalView[] }

export interface SnapshotSummary { count: number; bounce2s: number | null; shares_per_1k: number | null; favorites_per_1k: number | null }
export interface VersionStats {
  version: number; finalized: number; in_progress: number; pre_switch_rounds: number; label: string | null;
  rounds: { median: number | null; min: number | null; max: number | null };
  publish: { published: number; d3: SnapshotSummary; d7: SnapshotSummary; label: string | null };
}
export interface PlaybooksData { ok: true; playbooks: PlaybookView[]; stats: { by_playbook: Record<string, VersionStats[]>; unattributed: number; min_sample: number } }

const AUTHOR: Record<PlaybookVersion["author"], string> = { founder: "创始人", agent: "AI" };
const KIND: Record<PlaybookVersion["kind"], string> = { seed: "初始版本", edit: "修订", rollback: "回滚" };

export function versionLabel(v: PlaybookVersion): string {
  const what = v.kind === "rollback" ? `回滚到第 ${v.rolled_back_to} 版` : KIND[v.kind];
  return `第 ${v.version} 版 · ${AUTHOR[v.author]} · ${what}`;
}

const num = (v: number | null) => (v === null ? "—" : String(v));

/** 定稿 / 轮数一行：样本不够只摆数并标出来 */
export function roundsLine(s: VersionStats | undefined): string {
  if (!s) return "还没有稿用过这一版";
  const parts = [`已定稿 ${s.finalized} 条`, `进行中 ${s.in_progress} 条`];
  if (s.finalized) parts.push(`改稿轮数中位数 ${num(s.rounds.median)}（最少 ${num(s.rounds.min)}，最多 ${num(s.rounds.max)}）`);
  if (s.pre_switch_rounds) parts.push(`换体裁前 ${s.pre_switch_rounds} 轮（不计）`);
  if (s.label) parts.push(s.label);
  return parts.join(" · ");
}

const snap = (name: string, x: SnapshotSummary) =>
  x.count ? `${name}（${x.count} 条）：2 秒跳出 ${num(x.bounce2s)}%，每千播分享 ${num(x.shares_per_1k)}，每千播收藏 ${num(x.favorites_per_1k)}` : `${name}：没有那天的快照`;

export function publishLine(s: VersionStats | undefined): string {
  if (!s?.publish.published) return "还没有发布的抖音作品";
  const p = s.publish;
  return [`已发布 ${p.published} 条`, snap("D+3", p.d3), snap("D+7", p.d7), ...(p.label ? [p.label] : [])].join(" · ");
}

export function statsFor(data: PlaybooksData, id: string, version: number): VersionStats | undefined {
  return data.stats.by_playbook[id]?.find((s) => s.version === version);
}

export function updatedAt(p: PlaybookView): string {
  return p.versions.find((v) => v.version === p.current)?.at ?? "";
}

/** 浏览器端的请求号：网络重试复用同一个，服务端按它幂等 */
export const newRequestId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).replace(/[^A-Za-z0-9_-]/g, "");
