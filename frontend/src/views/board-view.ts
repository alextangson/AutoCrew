/**
 * 剪辑看板的页面模型（纯函数）：一眼回答「这条视频在哪一步」「现在要我做什么」。
 * 步骤条、「现在轮到你」卡的种类、Codex 一行、文件清单、刷新失败提示都从这里出，组件只管画。
 */
import { clockLabel, durationText, relativeLabel } from "../time-format";
import { boardAnomalies, currentStep, heartbeatStale, type FinalCutCard, type ProjectReview } from "./project-board";

export const STEPPER = ["交接", "剪辑", "成片", "封面", "发布"] as const;
export type StepState = "done" | "current" | "todo";
export type NowKind = "pre_handoff" | "no_handoff" | "cutting" | "final_review" | "covers" | "ready";

const PRE_HANDOFF = new Set(["draft_ready", "approved"]);

/** 「现在轮到你」卡该画哪一种；异常（剪辑中却没有有效交接）优先 */
export function nowKind(status: string, review: ProjectReview | null): NowKind {
  if (PRE_HANDOFF.has(status)) return "pre_handoff";
  if (boardAnomalies(status, review).includes("no_handoff") || !review) return "no_handoff";
  return currentStep(review);
}

const STEP_INDEX: Record<NowKind, number> = { pre_handoff: 0, no_handoff: 0, cutting: 1, final_review: 2, covers: 3, ready: 4 };
/** 步骤条：之前的打勾、当前的强调、之后的淡掉 */
export function stepperStates(kind: NowKind): Array<{ label: string; state: StepState }> {
  const at = STEP_INDEX[kind];
  return STEPPER.map((label, i) => ({ label, state: i < at ? "done" : i === at ? "current" : "todo" }));
}

/** Codex 一行：「Codex · 3 分钟前：<结果>」+ 下一步；超过 30 分钟没报告给一行安静的提醒 */
export function codexLine(review: ProjectReview, now: number): { text: string; next: string | null; stale: string | null } {
  const beat = review.execution?.heartbeat;
  // 只在轮到 Codex 干活（剪辑中）时提醒；成片待审、封面、待发布都是在等创始人，Codex 本来就不会报进度
  const stale = currentStep(review) === "cutting" && heartbeatStale(review, now) ? "超过 30 分钟没有报告进度，可以去 Codex 看看它是不是卡住了" : null;
  if (!beat?.reported_at) return { text: "Codex 还没报告过进度", next: null, stale };
  return { text: `Codex · ${relativeLabel(beat.reported_at, now)}：${beat.result}`, next: beat.next_action || null, stale };
}

const join = (root: string | undefined, p: string) => (p.startsWith("/") || !root ? p : `${root.replace(/\/$/, "")}/${p}`);

export type FileRow = { label: string; path: string | null; target: string; missingText: string };
/** 折叠区「文件」：原片、成片、封面文件夹、项目文件夹，各带具体路径和访达目标 */
export function boardFiles(review: ProjectReview): FileRow[] {
  const root = review.project?.project_root ?? undefined, card = review.final_cut;
  return [
    { label: "原片", path: review.handoff?.aroll_path ?? null, target: "aroll", missingText: "还没交接原片" },
    { label: "成片", path: card ? join(root, card.path) : null, target: card?.sha256 ?? "", missingText: "还没有成片" },
    { label: "封面文件夹", path: root ? join(root, "05-cover") : null, target: "covers_dir", missingText: "还没有项目文件夹" },
    { label: "项目文件夹", path: root ?? null, target: "project_root", missingText: "还没有项目文件夹" },
  ];
}

/** 成片那一行的说明：「8 分 43 秒 · 今天 17:50 从剪映导出 · 草稿「…」」 */
export function finalCutMeta(card: FinalCutCard, now: number = Date.now()): string {
  const parts = [durationText(card.duration_ms)];
  if (card.exported_at) parts.push(`${clockLabel(card.exported_at, now)}${card.external ? " 从剪映导出" : " 进了项目"}`);
  if (card.jianying_draft) parts.push(`草稿「${card.jianying_draft}」`);
  // §13.4-F.3：指纹前 8 位，创始人拿它对「通过的就是这一份」
  if (card.sha8 || card.sha256) parts.push(`指纹 ${card.sha8 || card.sha256.slice(0, 8)}`);
  return parts.join(" · ");
}

/** 文件名太长就从中间省略，保住开头和扩展名 */
export function middleEllipsis(name: string, max = 36): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const keep = max - 1, tail = Math.min(12, Math.floor(keep / 2));
  return `${chars.slice(0, keep - tail).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** 15 秒刷新失败：明说，不装作数据是新的 */
export function refreshFailedLine(reason: string, lastOkAt: number | null, now: number): string {
  const last = lastOkAt ? `（上次更新 ${relativeLabel(new Date(lastOkAt).toISOString(), now)}）` : "";
  return `看板更新失败：${reason}${last}`;
}

/** 打回原话必填 */
export function rejectNoteError(note: string): string | null {
  return note.trim() ? null : "写一句原话再打回，Codex 按这个出下一版";
}
