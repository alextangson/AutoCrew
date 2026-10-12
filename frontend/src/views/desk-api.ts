/** 发布台读模型（服务端 publish-desk.ts 的对应件）：一次读出卡片 + 各平台行 + 进度栏 */
import { authedFetch, SESSION_EXPIRED } from "../transport";
import type { CardPanelData } from "./board-api";
import type { TargetAction, TargetState } from "./publish-targets";

export type MoreAction = "correct_publish" | "add_work_url" | "record_metrics" | "i_published";
export type RowData =
  | { kind: "metrics"; warning?: string; views: number; likes: number | null; comments: number | null; metric_date: string; first_at: string; compare: { text: string; tone: string } }
  | { kind: "note"; text: string; why: string };
export type RowCopy =
  | { kind: "ready"; source: "实发" | "拟发"; title: string; caption: string; tags: string[] }
  | { kind: "missing" | "stale"; text: string };
export interface DeskRow {
  platform: string; label: string; state: TargetState; status: string; tone: string; reason: string | null; url: string | null;
  slot_id: string | null; campaigns: string[]; work_id: string | null;
  times: { scheduled_at: string | null; submitted_at: string | null; observed_at: string | null; public_at: string | null };
  when: string | null; data: RowData; copy: RowCopy; action: { kind: TargetAction; label: string; fact_id?: string } | null; more: MoreAction[];
  backflow: { kind: string; auto: boolean; text: string };
}
export type StepState = "未到" | "进行中" | "完成" | "被撤回" | "被退回" | "没有记录";
export interface RailStep { key: string; label: string; state: StepState; at: string | null; note?: string; current: boolean }
export interface Desk {
  round: number; rows: DeskRow[]; past: Array<{ round: number; platform: string; label: string; url: string | null; at: string }>;
  plan_error: string | null; headline: string | null; summary: string | null; refresh_at: string | null;
  cover: { fact_id: string; url: string } | null; script: { final: boolean; label: string };
  handoff?: { generation: number; at: string; session: string | null; fingerprint: string; aroll: string | null } | null;
  rail: { steps: RailStep[]; platforms: string[]; chars: number; wpm: number | null };
}
export type DeskReply = { active: false; card: CardPanelData } | { active: true; card: CardPanelData; desk: Desk };

export async function loadDesk(contentId: string): Promise<{ ok: true; data: DeskReply } | { ok: false; error: string }> {
  try {
    const r = await authedFetch(`/api/board/desk?content_id=${encodeURIComponent(contentId)}`, { credentials: "same-origin" });
    const body = await r.json().catch(() => null) as (DeskReply & { ok?: boolean; error?: string }) | null;
    if (!r.ok || !body || body.ok === false) return { ok: false, error: body?.error ?? (r.status === 403 ? SESSION_EXPIRED : `服务没响应（HTTP ${r.status}）`) };
    return { ok: true, data: body };
  } catch (e) {
    if (e instanceof Error && e.message === SESSION_EXPIRED) return { ok: false, error: SESSION_EXPIRED };
    return { ok: false, error: `连不上 AutoCrew 服务：${e instanceof Error ? e.message : String(e)}` };
  }
}
