/**
 * 四道门的批准 / 打回 / 失效（P6 §13.4-C「批准、打回、失效」，评审 #10）。纯函数，无 IO。
 *
 * - 批准记录的形状保持 RegisterApprovals 那一份（register 逐字比对），绑定信息另存在 bindings；
 * - 打回记录只追加不改写：门、原话、被打回的产物指纹、时间；
 * - 幂等键（门, 产物指纹）；批准失效 = 产物指纹变 / 交接代次变 / 稿件 draft_hash 变。
 */
import { coverPairHash as coverPair, sha256Text as sha } from "./manifest.js";
import type { RegisterApproval } from "./types.js";
import { COVER_ROLES, latestArtifact, type ArtifactEntry, type StoredExecution } from "./execution-index.js";

export const GATES = ["rough_cut", "storyboard", "final_cut", "covers"] as const;
export type GateName = (typeof GATES)[number];
export type GateStatus = "pending" | "approved" | "rejected" | "invalidated";
export interface GateBinding { generation: number; manifest_hash: string; draft_hash: string }
export interface GateRejection { gate: GateName; note: string; artifact_sha256: string; rejected_at: string; generation: number; manifest_hash: string }
export interface StoredApprovals extends Partial<Record<GateName, RegisterApproval>> {
  schema: 2; source: "founder-workbench";
  bindings: Partial<Record<GateName, GateBinding>>;
  rejections: GateRejection[];
}
export type CoverSelection = Partial<Record<keyof typeof COVER_ROLES, { sha256: string; path: string; version?: number; selected_at: string }>>;
export interface GateView {
  gate: GateName; status: GateStatus; artifact_sha256: string | null;
  /** 打回时页面要带的指纹（封面是整批，其余同 artifact_sha256） */
  reject_sha256: string | null;
  approval: RegisterApproval | null; rejection: GateRejection | null; reason?: string;
}
export interface GateContext {
  handoff: { generation: number; hash: string } | null; draftHash: string;
  approvals: StoredApprovals | null; execution: StoredExecution | null; selection: CoverSelection | null;
  /** 看板读时发现成片文件的大小/修改时间和 report 时不一样（导出文件被覆盖过）；登记另核实际字节 */
  finalCutChanged?: boolean;
}
export const FINAL_CUT_CHANGED = "导出文件变了，需要重新通过";


/** 旧形状（顶层 generation/manifest_hash，无 draft 绑定）→ 新形状。旧批准证明不了当时的稿，一律按失效处理。 */
export function normalizeApprovals(raw: unknown): StoredApprovals | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== "founder-workbench") return null;
  if (r.schema === 2) return r as unknown as StoredApprovals;
  const bindings: StoredApprovals["bindings"] = {};
  for (const gate of GATES) if (r[gate]) bindings[gate] = { generation: Number(r.generation), manifest_hash: String(r.manifest_hash ?? ""), draft_hash: "" };
  const out: StoredApprovals = { schema: 2, source: "founder-workbench", bindings, rejections: [] };
  for (const gate of GATES) if (r[gate]) out[gate] = r[gate] as RegisterApproval;
  return out;
}

/**
 * 成片门当前看的是哪一件：本代次最新报到的成片或剪映导出候选（§13.4-F）。
 * 候选可能在项目外（剪映导出目录），索引里记着它绑定的项目与代次；上一代次的候选不算。
 */
export function finalCutArtifact(index: readonly ArtifactEntry[], generation?: number): ArtifactEntry | null {
  const scoped = generation === undefined ? index : index.filter(a => a.generation === generation);
  return latestArtifact(scoped, ["final-cut", "final-cut-candidate"]);
}
/** 封面这一批的指纹：打回针对「当前展示的全部版本」，Codex 交了新一批就回到待批。 */
export function coverBatchHash(index: readonly ArtifactEntry[]): string | null {
  const covers = index.filter(a => a.role === COVER_ROLES["3:4"] || a.role === COVER_ROLES["4:3"]).map(a => `${a.role}:${a.sha256}`).sort();
  return covers.length ? sha(covers.join("\n")) : null;
}
/** 批准比对的指纹：封面是选中那一对，其余是该门最新一件产物。 */
export function approvalTarget(gate: GateName, execution: StoredExecution | null, selection: CoverSelection | null): string | null {
  const index = execution?.artifacts ?? [];
  if (gate === "covers") return selection?.["3:4"] && selection["4:3"] ? coverPair(selection["3:4"].sha256, selection["4:3"].sha256) : null;
  if (gate === "final_cut") return finalCutArtifact(index, execution?.generation)?.sha256 ?? null;
  return latestArtifact(index, [gate])?.sha256 ?? null;
}
/** 打回比对的指纹：封面是整批，其余同批准。 */
export function rejectionTarget(gate: GateName, execution: StoredExecution | null, selection: CoverSelection | null): string | null {
  return gate === "covers" ? coverBatchHash(execution?.artifacts ?? []) : approvalTarget(gate, execution, selection);
}

export function approvalInvalidReason(gate: GateName, ctx: GateContext): string | null {
  const approval = ctx.approvals?.[gate];
  if (!approval) return null;
  const bound = ctx.approvals?.bindings?.[gate];
  if (!ctx.handoff || !bound || bound.generation !== ctx.handoff.generation || bound.manifest_hash !== ctx.handoff.hash) return "交接代次已变化";
  if (bound.draft_hash !== ctx.draftHash) return "稿件已改";
  const changed = approval.artifact_sha256 !== approvalTarget(gate, ctx.execution, ctx.selection) || (gate === "final_cut" && ctx.finalCutChanged);
  if (changed) return gate === "final_cut" ? FINAL_CUT_CHANGED : "产物已变化";
  return "";
}

export function gateView(gate: GateName, ctx: GateContext): GateView {
  const approval = ctx.approvals?.[gate] ?? null;
  const invalid = approvalInvalidReason(gate, ctx);
  const target = rejectionTarget(gate, ctx.execution, ctx.selection);
  const rejection = [...(ctx.approvals?.rejections ?? [])].reverse().find(r => r.gate === gate && r.artifact_sha256 === target && r.manifest_hash === ctx.handoff?.hash) ?? null;
  const artifact = approvalTarget(gate, ctx.execution, ctx.selection);
  const base = { gate, artifact_sha256: artifact, reject_sha256: target };
  if (approval && invalid === "") return { ...base, status: "approved", approval, rejection: null };
  if (rejection) return { ...base, status: "rejected", approval: null, rejection };
  if (approval) return { ...base, status: "invalidated", approval, rejection: null, reason: invalid ?? undefined };
  return { ...base, status: "pending", approval: null, rejection: null };
}
/** 投影给看板和 workflow-state.json：gate1–gate4 */
export function gateStates(ctx: GateContext): Record<string, GateView> {
  return Object.fromEntries(GATES.map((gate, i) => [`gate${i + 1}`, gateView(gate, ctx)]));
}
