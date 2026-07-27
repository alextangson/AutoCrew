/**
 * 视频状态机（设计 spec §2.2 迁移表）。
 *
 * phase（在哪一步）与 state（这一步怎么样了）正交拆开——混成一个枚举就会出现
 * 「render_failed」这种既是阶段又是结果的值，重试时无从知道该重投哪一步（codex #4/#5）。
 *
 * 表就是法律：**只列合法迁移，其余一律拒绝且可见**。写盘前一律过 assertTransition，
 * 让「状态怎么跳到那儿去的」永远有答案。
 */
import type { VideoPhase, VideoRunState } from "./types.js";

export interface VideoStateRef {
  phase: VideoPhase;
  state: VideoRunState;
}

/** 阶段推进顺序；索引即先后，只许前进或停留（重试停在原 phase） */
export const VIDEO_PHASE_ORDER: readonly VideoPhase[] = [
  "ingest",
  "transcribe",
  "cut",
  "assemble",
  "render",
  "review",
  "done",
] as const;

/**
 * 合法状态边（spec §2.2，2026-07-27 v2.1 修正后）：
 *   idle→queued(投递)｜queued→running(claim)
 *   running→awaiting_human(人工门)｜queued(阶段自动接续或同阶段回收重排)｜failed｜blocked
 *   awaiting_human→queued(人工确认推进)｜done(审片确认)｜awaiting_human(审片打回，见回退白名单)
 *   failed→queued(重试 failedPhase)｜blocked→queued(阻因消除)｜done→queued(重开，见回退白名单)
 *
 * 人工门只有两个：transcribe 完 → cut 选段、render 完 → review 审片（spec §3）。
 * assemble 完自动接 render、ingest 完自动接 transcribe——这两处不停人工门。
 */
export const VIDEO_STATE_TRANSITIONS: Record<VideoRunState, readonly VideoRunState[]> = {
  idle: ["queued"],
  queued: ["running"],
  running: ["awaiting_human", "failed", "blocked", "queued"],
  awaiting_human: ["queued", "done", "awaiting_human"],
  blocked: ["queued"],
  failed: ["queued"],
  done: ["queued"],
} as const;

/**
 * 允许**顺带推进 phase** 的状态边。不在此列的边（如 failed→queued 重试、
 * running→failed）phase 必须原地不动，否则重试会重投错阶段。
 */
export const PHASE_ADVANCING_EDGES: readonly string[] = [
  "idle->queued", // 首次投递：ingest → transcribe
  "running->awaiting_human", // 阶段产物落地，交给下一个人工门
  "running->queued", // 阶段自动接续（仅限 AUTO_CHAIN_PHASES 列出的相邻对）
  "awaiting_human->queued", // 人工确认，推进下一 phase
  "awaiting_human->done", // review 确认收尾
] as const;

/** running→queued 允许顺带推进的相邻阶段对——人工门（cut、review 之前）绝不在此列 */
export const AUTO_CHAIN_PHASES: readonly (readonly [VideoPhase, VideoPhase])[] = [
  ["ingest", "transcribe"],
  ["assemble", "render"],
] as const;

/**
 * 阶段回退白名单：只有这两条显式边允许 phase 倒退（spec §2.2 v2.1）。
 * 打回=审片不满意回去改选段；重开=对已完成内容提交新 cut 直接重组装。
 */
export const PHASE_REGRESSION_EDGES: readonly {
  readonly from: VideoStateRef;
  readonly to: VideoStateRef;
}[] = [
  { from: { phase: "review", state: "awaiting_human" }, to: { phase: "cut", state: "awaiting_human" } },
  { from: { phase: "done", state: "done" }, to: { phase: "assemble", state: "queued" } },
] as const;

function fmt(ref: VideoStateRef): string {
  return `${ref.phase}/${ref.state}`;
}

function phaseIndex(phase: VideoPhase): number {
  return VIDEO_PHASE_ORDER.indexOf(phase);
}

/** 未知枚举值（多半来自损坏/降级的 state.json）要在这里被点名，不能靠后面 undefined 崩 */
function unknownValueError(ref: VideoStateRef, label: string): string | null {
  if (phaseIndex(ref.phase) < 0) {
    return `${label}的 phase 未知：${String(ref.phase)}（合法值：${VIDEO_PHASE_ORDER.join("、")}）`;
  }
  if (!(ref.state in VIDEO_STATE_TRANSITIONS)) {
    const all = Object.keys(VIDEO_STATE_TRANSITIONS).join("、");
    return `${label}的 state 未知：${String(ref.state)}（合法值：${all}）`;
  }
  return null;
}

/** done 是终点：状态 done 与阶段 done 必须成对出现，且只能由 review 的人工确认到达 */
function doneRuleError(from: VideoStateRef, to: VideoStateRef): string | null {
  const stateDone = to.state === "done";
  const phaseDone = to.phase === "done";
  if (stateDone !== phaseDone) {
    return `done 只能成对出现：目标 ${fmt(to)} 里 phase 与 state 必须同为 done`;
  }
  if (!stateDone) return null;
  if (from.phase !== "review" || from.state !== "awaiting_human") {
    return `只有 review 的人工确认能收尾到 done，当前是 ${fmt(from)}`;
  }
  return null;
}

/** 非法返回人话原因（含 from/to），合法返回 null——UI 与写盘门共用同一判定 */
export function videoTransitionError(from: VideoStateRef, to: VideoStateRef): string | null {
  const unknown = unknownValueError(from, "来源") ?? unknownValueError(to, "目标");
  if (unknown) return unknown;
  // 原地更新（只改 revisions/stale 等负载字段）恒合法
  if (from.phase === to.phase && from.state === to.state) return null;

  const allowed = VIDEO_STATE_TRANSITIONS[from.state];
  if (!allowed.includes(to.state)) {
    return (
      `视频状态迁移非法：${fmt(from)} → ${fmt(to)}；` +
      `${from.state} 只能去往：${allowed.join("、") || "无（终点状态）"}`
    );
  }
  const doneErr = doneRuleError(from, to);
  if (doneErr) return `视频状态迁移非法：${fmt(from)} → ${fmt(to)}；${doneErr}`;

  if (to.phase === from.phase) return null;
  if (phaseIndex(to.phase) < phaseIndex(from.phase)) {
    const whitelisted = PHASE_REGRESSION_EDGES.some(
      (e) =>
        e.from.phase === from.phase && e.from.state === from.state &&
        e.to.phase === to.phase && e.to.state === to.state,
    );
    if (whitelisted) return null;
    return (
      `视频状态迁移非法：${fmt(from)} → ${fmt(to)}；` +
      `阶段回退只允许「审片打回」与「重开」两条显式边`
    );
  }
  if (!PHASE_ADVANCING_EDGES.includes(`${from.state}->${to.state}`)) {
    return (
      `视频状态迁移非法：${fmt(from)} → ${fmt(to)}；` +
      `${from.state}→${to.state} 这条边不许换阶段（阶段推进只发生在：${PHASE_ADVANCING_EDGES.join("、")}）`
    );
  }
  if (from.state === "running" && to.state === "queued") {
    const chained = AUTO_CHAIN_PHASES.some(([a, b]) => a === from.phase && b === to.phase);
    if (!chained) {
      return (
        `视频状态迁移非法：${fmt(from)} → ${fmt(to)}；` +
        `自动接续只允许 ${AUTO_CHAIN_PHASES.map(([a, b]) => `${a}→${b}`).join("、")}——人工门不可绕过`
      );
    }
  }
  return null;
}

export function canTransition(from: VideoStateRef, to: VideoStateRef): boolean {
  return videoTransitionError(from, to) === null;
}

/** 写盘前的唯一闸门：非法迁移抛错，错误信息自带 from/to 与原因 */
export function assertTransition(from: VideoStateRef, to: VideoStateRef): void {
  const err = videoTransitionError(from, to);
  if (err) throw new Error(err);
}
