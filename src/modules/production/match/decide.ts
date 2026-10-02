/**
 * 判定（1b §2.1）：每条池内稿的 L1 等级 + L2 分数 → `{winner?, top3, reason}`，带作业输入快照。纯函数。
 *
 * 自动认（winner）只在两种情况：
 * - L1 强命中（统一定义 `l1Strong`）且池里唯一；
 * - L2 已校准，且有效字数 ≥ 80、目标分 ≥ 下限、比第二名高出 ≥ 差距（池里只有一条时第二名按 0 算，下限仍要过）。
 * 空转写、短转写一律不自动认；校准前 L2 一律不自动认（B17）。
 */
import { l1Strong, matchL1, type L1Kind } from "./l1.js";
import { MIN_SPEECH_CHARS, scoreTranscript, speechChars } from "./l2.js";

/**
 * L2 阈值，2026-09-30 按 `scripts/calibrate-aroll-match.mts` 定值、创始人看过后打开：
 * 资料库 4 条稿 7 个样本（原片 4、成片 3），对自己稿 0.446–0.679，对最像的别条稿 0.067–0.125，差距 0.360–0.589。
 * 下限与差距离两侧实测边缘各留约 0.15。同系列近似稿会压小差距 → 过不了差距就退回候选，不会认错。
 */
export const L2_CALIBRATED = true;
export const L2_FLOOR = 0.3;
export const L2_MARGIN = 0.2;
/**
 * 没有 winner 时，前三名里够得上「像」才给候选（1b §4 / §6）：文件名至少弱命中，或开头转写 ≥ 这个分。
 * 校准里别条稿的最高分 0.125（7 个样本），取略高于它；更低的算「一个也不像」（收件箱计入列头，别处静默跳过）。
 */
export const SUGGEST_MIN = 0.15;

export function looksLike(r: Ranked): boolean {
  return r.l1 !== "none" || (r.l2 ?? 0) >= SUGGEST_MIN;
}

export interface PoolEntry { content_id: string; title: string; old_titles: string[]; round: number; body_hash: string; body: string }
export interface SnapshotEntry { content_id: string; round: number; body_hash: string; title: string }
export interface Snapshot { sha256: string; pool: SnapshotEntry[] }
export interface Ranked { content_id: string; title: string; l1: L1Kind; l2?: number }
export interface MatchDecision { winner: string | null; top3: Ranked[]; reason: string; snapshot: Snapshot; chars?: number; l1_only?: true }

export interface Thresholds { calibrated: boolean; floor: number; margin: number }
export const THRESHOLDS: Thresholds = { calibrated: L2_CALIBRATED, floor: L2_FLOOR, margin: L2_MARGIN };

export function snapshotOf(sha256: string, pool: readonly PoolEntry[]): Snapshot {
  return { sha256, pool: pool.map((p) => ({ content_id: p.content_id, round: p.round, body_hash: p.body_hash, title: p.title })).sort((a, b) => a.content_id.localeCompare(b.content_id)) };
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 转写：有文本；或没有文本 + 原因（没就绪 / 失败 / 超时 / 暂停） */
export type Heard = { text: string } | { text: null; why: string };

export interface DecideInput { fileName: string; sha256: string; pool: readonly PoolEntry[]; heard: Heard }

function l1Kinds(fileName: string, pool: readonly PoolEntry[]): L1Kind[] {
  const loose = matchL1(fileName, pool.map((p) => ({ title: p.title, oldTitles: p.old_titles })));
  return pool.map((p, i) => (l1Strong(fileName, p.title) ? "strong" : loose[i].kind === "none" ? "none" : "weak"));
}

const rank = (r: Ranked) => (r.l2 ?? -1) * 10 + (r.l1 === "strong" ? 2 : r.l1 === "weak" ? 1 : 0) / 10;

function top3(ranked: Ranked[]): Ranked[] {
  return [...ranked].sort((a, b) => rank(b) - rank(a)).slice(0, 3);
}

export function describeTop3(top: readonly Ranked[]): string {
  return top.map((r) => `《${r.title}》${r.l2 !== undefined ? ` ${r.l2}` : ""}${r.l1 === "strong" ? "（文件名对上）" : ""}`).join("、");
}

export function decide(input: DecideInput, t: Thresholds = THRESHOLDS): MatchDecision {
  const snapshot = snapshotOf(input.sha256, input.pool);
  const kinds = l1Kinds(input.fileName, input.pool);
  const ranked: Ranked[] = input.pool.map((p, i) => ({ content_id: p.content_id, title: p.title, l1: kinds[i] }));
  const strong = ranked.filter((r) => r.l1 === "strong");
  if (strong.length === 1) return { winner: strong[0].content_id, top3: top3(ranked), reason: `文件名对上《${strong[0].title}》，池里没有别条对得上`, snapshot };
  const multi = strong.length > 1 ? `文件名同时对得上 ${strong.length} 条稿；` : "";
  if (input.heard.text === null) return { winner: null, top3: top3(ranked), reason: `${multi}${input.heard.why}，只比了文件名`, snapshot, l1_only: true };
  const chars = speechChars(input.heard.text);
  const scores = input.pool.length ? scoreTranscript(input.heard.text, input.pool.map((p) => p.body)) : [];
  ranked.forEach((r, i) => { r.l2 = scores[i]; });
  const top = top3(ranked);
  if (chars < MIN_SPEECH_CHARS) return { winner: null, top3: top, reason: `${multi}${chars === 0 ? "开头没听到人声" : `开头转写太短（${chars} 字）`}，不自动认`, snapshot, chars };
  const [first, second] = top;
  if (!first) return { winner: null, top3: top, reason: "比对池里没有稿", snapshot, chars };
  const gap = Math.round(((first.l2 ?? 0) - (second?.l2 ?? 0)) * 1000) / 1000;
  if (!t.calibrated) return { winner: null, top3: top, reason: `${multi}内容比对还没校准，只给建议（最像《${first.title}》${first.l2}，领先 ${gap}）`, snapshot, chars };
  if ((first.l2 ?? 0) < t.floor) return { winner: null, top3: top, reason: `${multi}最像《${first.title}》，但分数 ${first.l2} 不到 ${t.floor}`, snapshot, chars };
  if (gap < t.margin) return { winner: null, top3: top, reason: `${multi}《${first.title}》只比第二名高 ${gap}（要 ≥ ${t.margin}），分不开`, snapshot, chars };
  return { winner: first.content_id, top3: top, reason: `开头转写对上《${first.title}》（${first.l2}，领先 ${gap}）`, snapshot, chars };
}
