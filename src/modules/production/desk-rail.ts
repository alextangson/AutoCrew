/**
 * 稿件页左侧进度栏（发布台 spec「创始人已定」+ 吸收 12）：写稿 → 录制 → 剪辑 → 封面 → 发布 → 数据，每步要证据，不新增存储。
 * 写稿 = 认稿决定；录制 = 原片入库（「原片到」，不说成录制时间）；剪辑 = 成片批准；封面 = 封面批准；
 * 发布 = 首个平台投出；数据 = 首次回流。状态：未到 / 进行中 / 完成 / 被撤回 / 被退回 / 没有记录（后面做了、这步没证据）。纯函数。
 */
import type { Decision, ProductionDoc } from "../../storage/production-types.js";
import { validCoverApproval, validCutApproval } from "./derive.js";

export type StepState = "未到" | "进行中" | "完成" | "被撤回" | "被退回" | "没有记录";
export interface RailStep { key: string; label: string; state: StepState; at: string | null; note?: string; current: boolean }

type Evidence = { state: "完成" | "被撤回" | "被退回"; at: string; note?: string } | null;

const inRound = (doc: ProductionDoc) => doc.decisions.filter((d) => d.round === doc.round);
const last = (ds: Decision[]) => [...ds].sort((a, b) => a.at.localeCompare(b.at)).at(-1);

function scriptEvidence(doc: ProductionDoc): Evidence {
  const d = last(inRound(doc).filter((x) => x.type === "script_approval" || x.type === "script_revoke" || x.type === "script_revise"));
  if (!d) return null;
  if (d.type === "script_approval") return { state: "完成", at: d.at };
  return { state: d.type === "script_revoke" ? "被撤回" : "被退回", at: d.at, ...(d.note ? { note: d.note } : {}) };
}

function arollEvidence(doc: ProductionDoc): Evidence {
  const f = doc.facts.filter((x) => x.round === doc.round && x.kind === "aroll" && x.state === "accepted").sort((a, b) => a.at.localeCompare(b.at))[0];
  return f ? { state: "完成", at: f.at, note: "原片到" } : null;
}

/** 有效批准 = 完成；否则看最近一次是打回还是撤回 */
function approvalEvidence(doc: ProductionDoc, ok: Decision | null, type: "cut_approval" | "cover_approval", reject: "cut_reject" | "cover_reject"): Evidence {
  if (ok) return { state: "完成", at: ok.at };
  const ds = inRound(doc);
  const approvals = new Set(ds.filter((d) => d.type === type).map((d) => d.id));
  const d = last(ds.filter((x) => x.type === reject || (x.type === "approval_revoke" && approvals.has(x.target_id ?? ""))));
  if (!d) return null;
  return { state: d.type === reject ? "被退回" : "被撤回", at: d.at, ...(d.note ? { note: d.note } : {}) };
}

export interface RailInput { doc: ProductionDoc; body: string; firstSubmitAt: string | null; firstDataAt: string | null }

export function railSteps(i: RailInput): RailStep[] {
  const ev: Array<[string, string, Evidence]> = [
    ["script", "写稿", scriptEvidence(i.doc)],
    ["aroll", "录制", arollEvidence(i.doc)],
    ["cut", "剪辑", approvalEvidence(i.doc, validCutApproval(i.doc, i.body), "cut_approval", "cut_reject")],
    ["cover", "封面", approvalEvidence(i.doc, validCoverApproval(i.doc, i.body), "cover_approval", "cover_reject")],
    ["publish", "发布", i.firstSubmitAt ? { state: "完成", at: i.firstSubmitAt } : null],
    ["data", "数据", i.firstDataAt ? { state: "完成", at: i.firstDataAt } : null],
  ];
  const lastDone = ev.map(([, , e]) => e?.state === "完成").lastIndexOf(true);
  let current = -1;
  return ev.map(([key, label, e], idx): RailStep => {
    let state: StepState;
    if (e?.state === "完成") state = "完成";
    else if (idx < lastDone) state = e ? e.state : "没有记录";
    else if (current === -1) { current = idx; state = e ? e.state : "进行中"; }
    else state = "未到";
    return { key, label, state, at: e?.at ?? null, ...(e?.note ? { note: e.note } : {}), current: idx === current };
  });
}
