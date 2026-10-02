/**
 * 工作台（等你拍板 2a，R18）：决定按钮仍能用，但都经「等你拍板」的单一入口（inbox-decide.decide，带代次 CAS）；
 * 界面的只读化在 2a-2。以下为本体 §8 适配的原说明——按本体走的视频稿，工作台上成片 / 封面的批准、打回按钮改写成 §2.4 的创始人决定，
 * 不再要交接代次（handoff generation）。页面沿用原来的形状：这里从制作记录合成「产物索引」与 gate3 / gate4 视图。
 * 二期再把批准搬到卡片面板。
 */
import path from "node:path";
import type { Content } from "../../storage/local-store.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { coverPairHash } from "../video/handoff/manifest.js";
import { COVER_ROLES, type ArtifactEntry, type StoredExecution } from "../video/handoff/execution-index.js";
import { coverBatchHash, type GateView } from "../video/handoff/gate-state.js";
import { readProjectJson, type ProjectDecisions } from "../video/handoff/project-evidence.js";
import { validCoverApproval, validCutApproval } from "./derive.js";
import { decide } from "./inbox-decide.js";
import { reconcileContent } from "./reconcile.js";
import { validCoverGroups, withCoverGroups } from "./cover-groups.js";
import { approvedCoverShas } from "./service.js";
import { hostLabel } from "./host-label.js";

const APPROVED_BY = "创始人在工作台批准（本体决定）";

function artifactOf(f: Fact, round: number): ArtifactEntry {
  const role = f.kind === "cut" ? "final-cut" : f.ratio === "4:3" ? COVER_ROLES["4:3"] : COVER_ROLES["3:4"];
  return { path: f.path!, sha256: f.sha256!, role, generation: round, reported_at: f.at, ...(f.version ? { version: f.version } : {}), ...(f.size ? { size: f.size } : {}), ...(f.mtime_ms ? { mtime_ms: f.mtime_ms } : {}) };
}

/** 本轮已收的成片与封面，做成页面认得的产物索引（成片取最新一版） */
/** 封面只列有效组里的（review-inbox §6.3：作废的组、只做候选的图不再出现） */
export function executionFromFacts(raw: ProductionDoc, body = ""): StoredExecution {
  const doc = withCoverGroups(raw, approvedCoverShas(raw, body));
  const inGroups = new Set(validCoverGroups(doc).flatMap((g) => [...g.slots["3:4"], ...g.slots["4:3"]].map((f) => f.id)));
  const facts = doc.facts.filter((f) => f.round === doc.round && f.state === "accepted" && !f.replaced_at && f.path && !path.isAbsolute(f.path)
    && (f.kind === "cut" || (f.kind === "cover" && inGroups.has(f.id))));
  return {
    schema: 2, generation: doc.round, session_id: "", machine: "", host: "", transport_session: null,
    heartbeat: { request_id: "", session_id: "", result: "", next_action: "", reported_at: "" },
    artifacts: facts.sort((a, b) => a.at.localeCompare(b.at)).map((f) => artifactOf(f, doc.round)),
  };
}

function cutGate(doc: ProductionDoc, content: Content, exec: StoredExecution): GateView {
  const latest = exec.artifacts.filter((a) => a.role === "final-cut").at(-1) ?? null;
  const ok = validCutApproval(doc, content.body);
  const base = { gate: "final_cut" as const, artifact_sha256: latest?.sha256 ?? null, reject_sha256: latest?.sha256 ?? null };
  if (ok && ok.sha256 === latest?.sha256) return { ...base, status: "approved", approval: { artifact_sha256: ok.sha256!, approved_at: ok.at, user_message: APPROVED_BY }, rejection: null };
  const rej = [...doc.decisions].reverse().find((d) => d.round === doc.round && d.type === "cut_reject" && d.sha256 === latest?.sha256);
  if (rej) return { ...base, status: "rejected", approval: null, rejection: { gate: "final_cut", note: rej.note ?? "", artifact_sha256: rej.sha256!, rejected_at: rej.at, generation: doc.round, manifest_hash: "" } };
  return { ...base, status: "pending", approval: null, rejection: null };
}

function coverGate(doc: ProductionDoc, content: Content, exec: StoredExecution): GateView {
  const ok = validCoverApproval(doc, content.body);
  const batch = coverBatchHash(exec.artifacts);
  const pair = ok ? coverPairHash(ok.cover_3x4_sha!, ok.cover_4x3_sha!) : null;
  const base = { gate: "covers" as const, artifact_sha256: pair, reject_sha256: batch };
  if (ok) return { ...base, status: "approved", approval: { artifact_sha256: pair!, approved_at: ok.at, user_message: APPROVED_BY }, rejection: null };
  const rej = [...doc.decisions].reverse().find((d) => d.round === doc.round && d.type === "cover_reject" && d.sha256 === batch);
  if (rej) return { ...base, status: "rejected", approval: null, rejection: { gate: "covers", note: rej.note ?? "", artifact_sha256: batch!, rejected_at: rej.at, generation: doc.round, manifest_hash: "" } };
  return { ...base, status: "pending", approval: null, rejection: null };
}

/** 页面读的覆盖项：交接视为有效（本体下不需要交接）、产物索引与 gate3 / gate4 来自制作记录 */
/** 页面「交接详情」要的形状：本体下没有交接，取本轮收下的原片（没有就空串）与它的时间 */
export interface OntologyHandoff { generation: number; hash: string; at: string; aroll_path: string; draft_hash: string }

function handoffOf(doc: ProductionDoc, draftHash: string): OntologyHandoff {
  const aroll = doc.facts.filter((f) => f.kind === "aroll" && f.state === "accepted" && !f.replaced_at).at(-1);
  return { generation: doc.round, hash: `ontology-r${doc.round}`, at: aroll?.at ?? "", aroll_path: aroll?.path ?? "", draft_hash: draftHash };
}

/** 谁在剪（review-inbox §10）：本轮最近报成片 / 封面的 agent，按 by.host 显示真实名字，没有就「agent」 */
export function editorLabel(doc: ProductionDoc): string {
  const f = doc.facts.filter((x) => x.round === doc.round && (x.kind === "cut" || x.kind === "cover" || x.kind === "chatcut_project") && x.by?.host && x.by.host !== "founder")
    .sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  return hostLabel(f?.by?.host);
}

export async function workbenchOverlay(content: Content, dataDir: string, draftHash = ""): Promise<{ execution: StoredExecution; gates: Record<string, GateView>; handoff: OntologyHandoff; selection: unknown; editor_label: string }> {
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const execution = executionFromFacts(doc, content.body);
  const ok = validCoverApproval(doc, content.body);
  const find = (sha?: string) => execution.artifacts.find((a) => a.sha256 === sha);
  const selection = ok ? { "3:4": { sha256: ok.cover_3x4_sha, path: find(ok.cover_3x4_sha)?.path, selected_at: ok.at }, "4:3": { sha256: ok.cover_4x3_sha, path: find(ok.cover_4x3_sha)?.path, selected_at: ok.at } } : null;
  return { execution, gates: { gate3: cutGate(doc, content, execution), gate4: coverGate(doc, content, execution) }, handoff: handoffOf(doc, draftHash), selection, editor_label: editorLabel(doc) };
}

type Files = Array<{ path?: unknown; sha256?: unknown }>;

function factFor(doc: ProductionDoc, kind: Fact["kind"], sha: unknown): Fact | undefined {
  return doc.facts.find((f) => f.round === doc.round && f.kind === kind && f.sha256 === sha && f.state !== "rejected");
}

/** 工作台按钮 → 创始人决定。页面带来的文件指纹就是决定的指纹 */
export async function workbenchDecision(content: Content, dataDir: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await reconcileContent(content.id, dataDir);
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const files = (Array.isArray(params.files) ? params.files : []) as Files;
  const which = params.which;
  if (params.action === "approve" && which === "final_cut") {
    const f = factFor(doc, "cut", files[0]?.sha256);
    if (!f) return { ok: false, error: "这版成片还没收进制作记录（刷新后再看）" };
    if (f.state !== "accepted") return { ok: false, error: "这版成片还是候选：先在卡片上确认它是这条的成片" };
    return decide(content.id, "approve_cut", { fact_id: f.id, sha256: f.sha256 }, dataDir);
  }
  if (params.action === "approve" && which === "covers") {
    const a = factFor(doc, "cover", files[0]?.sha256), b = factFor(doc, "cover", files[1]?.sha256);
    const text = (await readProjectJson<ProjectDecisions>(content.id, "decisions.json", dataDir).catch(() => null))?.cover_text ?? "";
    return decide(content.id, "pick_cover", { cover_3x4_fact_id: a?.id, cover_3x4_sha: a?.sha256, cover_4x3_fact_id: b?.id, cover_4x3_sha: b?.sha256, cover_text: params.cover_text ?? text }, dataDir);
  }
  if (params.action === "reject" && which === "final_cut") {
    const f = factFor(doc, "cut", params.artifact_sha256);
    return decide(content.id, "reject_cut", { fact_id: f?.id, sha256: params.artifact_sha256, note: params.note }, dataDir);
  }
  if (params.action === "reject" && which === "covers") {
    // 整批打回：把当时展示的全部封面 sha 记上，含在里面的已选封面随之失效
    const artifacts = executionFromFacts(doc, content.body).artifacts;
    // 只打回页面上真看到的那一批（Codex 审 seg3 P2）：批次指纹对不上 = 页面过期，不许否决后来新出的封面
    if (params.artifact_sha256 !== coverBatchHash(artifacts)) return { ok: false, error: "封面这一批已经变了（有新出的），刷新后再看再打回" };
    const shas = artifacts.filter((a) => a.role !== "final-cut").map((a) => a.sha256);
    return decide(content.id, "reject_cover", { sha256: params.artifact_sha256, cover_shas: shas, note: params.note }, dataDir);
  }
  return { ok: false, error: "这一步在本体下没有对应的决定（粗剪 / 分镜门照旧走交接）" };
}
