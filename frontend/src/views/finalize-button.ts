/**
 * 稿件页顶栏「定稿」的纯逻辑（2026-10-26）：视频稿写稿段一直给按钮（不看 AI 写没写完、清单出没出），
 * 定过就成「已定稿 · 时刻」；撤回在「更多」里。卡片 / 定稿区原来那两个认稿按钮让位给它。
 */
import { UNDO } from "./board-columns";
import type { CardModel, MoreItem } from "./stage-card-model";

/** script:final_get 回的那份（data:null = 不是视频口播稿，按钮不出现） */
export interface ScriptFinalState {
  status: string;
  approved_at: string | null;
  writing: boolean;
  /** 薄路径的出处情况；非薄路径为 null */
  gaps: { kind: "unsourced" | "none" | "stale"; count: number } | null;
}

export type FinalizeView =
  | { kind: "hidden" }
  | { kind: "button"; disabled: boolean; why?: string; reminder?: string }
  | { kind: "label"; text: string };

const pad = (n: number) => String(n).padStart(2, "0");
export function approvedLabel(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "已定稿";
  return `已定稿 · ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 按钮旁那一行提醒：只提醒，不挡 */
export function gapReminder(g: ScriptFinalState["gaps"]): string | undefined {
  if (!g) return undefined;
  if (g.kind === "none") return "还没出出处清单";
  if (g.kind === "stale") return "出处清单是改稿前的，没出处的地方没重核";
  return g.count > 0 ? `还有 ${g.count} 处没核出处` : undefined;
}

export function finalizeView(s: ScriptFinalState | null, dirty: boolean): FinalizeView {
  if (!s) return { kind: "hidden" };
  if (s.approved_at) return { kind: "label", text: approvedLabel(s.approved_at) };
  if (!s.writing) return { kind: "hidden" };
  const reminder = gapReminder(s.gaps);
  return { kind: "button", disabled: dirty, ...(dirty ? { why: "先保存修改" } : {}), ...(reminder ? { reminder } : {}) };
}

/** 卡片让位：主按钮是认稿的就拿掉；认过的稿「更多」里给「撤回定稿」（代替原来的回到审稿那一项） */
export function withTopbarFinalize(m: CardModel, status: string): CardModel {
  const pr = m.primary;
  const approving = pr && ((pr.run.kind === "next" && pr.run.action === "approve_script") || (pr.run.kind === "transition" && pr.run.status === "approved"));
  const more: MoreItem[] = m.more.filter((x) => !(x.run.kind === "transition" && x.run.status === "approved"));
  if (status === "approved") {
    const undo: MoreItem = { key: "t:reviewing", label: "撤回定稿", run: { kind: "transition", status: "reviewing" }, confirm: { title: "撤回定稿？", body: UNDO.unapprove.body, danger: true } };
    const i = more.findIndex((x) => x.run.kind === "transition" && x.run.status === "reviewing");
    if (i >= 0) more.splice(i, 1, undo); else more.unshift(undo);
  }
  if (!approving && more.length === m.more.length && status !== "approved") return m;
  const primary = approving ? null : pr;
  const tone = approving ? "none" : m.tone;
  return { ...m, primary, more, tone, head: approving ? "定稿在顶栏" : m.head, text: approving ? `看过没问题就点顶栏的「定稿」${pr?.note ? `；${pr.note}` : ""}` : m.text };
}
