/**
 * 创始人在工作台上的决定：交接信息、选封面、四道门的批准与打回。
 * 只有浏览器会话路由调用；任何 MCP 动作都造不出创始人决定或批准。
 */
import path from "node:path";
import { getContent, type Content } from "../../../storage/local-store.js";
import { contentFile, resolveContentProject } from "../../../storage/content-project.js";
import { writeJsonAtomic } from "../../../storage/json-atomic.js";
import { exportProjectViews, repairProjectViews } from "../../../storage/project-commit.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { resolveProjectFile } from "./paths.js";
import { FINAL_CUT_CANDIDATE, resolveReportedFile } from "./jianying-root.js";
import { finalCutCard } from "./final-cut.js";
import { sha256File, coverPairHash } from "./manifest.js";
import { readProjectJson, type ProjectDecisions } from "./project-evidence.js";
import type { RegisterApprovals } from "./types.js";
import { serializeVideoLine } from "./lock.js";
import { COVER_ROLES, normalizeExecution, type CoverRatio } from "./execution-index.js";
import { GATES, approvalInvalidReason, approvalTarget, gateStates, gateView, normalizeApprovals, rejectionTarget,
  type CoverSelection, type GateContext, type GateName, type GateRejection, type StoredApprovals } from "./gate-state.js";

const APPROVAL_MESSAGE = "创始人在 AutoCrew 工作台确认本次展示的产物";

export async function loadGateContext(content: Content, dataDir: string): Promise<GateContext> {
  const handoff = content.video?.handoff;
  const live = handoff && !content.video?.revoked?.includes(handoff.hash) ? { generation: handoff.generation, hash: handoff.hash } : null;
  return {
    handoff: live, draftHash: draftHash(content),
    approvals: normalizeApprovals(await readProjectJson<unknown>(content.id, "approvals.json", dataDir)),
    execution: normalizeExecution(await readProjectJson<unknown>(content.id, "execution.json", dataDir)),
    selection: await readProjectJson<CoverSelection>(content.id, "cover-selection.json", dataDir),
  };
}

export async function verifyStoredApprovals(content: Content, requested: RegisterApprovals, dataDir: string): Promise<void> {
  if (!resolveContentProject(content.id, dataDir)) return; // v1 compatibility only
  const ctx = await loadGateContext(content, dataDir);
  for (const gate of ["final_cut", "covers"] as const) {
    const view = gateView(gate, ctx);
    if (view.status !== "approved" || JSON.stringify(view.approval) !== JSON.stringify(requested[gate])) throw new Error("approval_mismatch: 未找到与当前代次及产物一致的创始人批准记录");
  }
}

export async function founderProjectReview(id: string, dataDir: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return serializeVideoLine(id, async () => {
    const content = await getContent(id, dataDir), binding = resolveContentProject(id, dataDir);
    if (!content || (!binding && !content.video?.handoff)) return { ok: true, enabled: false, status: content?.status ?? null };
    const projectRoot = binding?.project_root ?? content.video!.handoff!.project_root;
    let decision: unknown;
    if (params?.action === "decisions") await saveDecisions(content, dataDir, params);
    else if (params?.action === "approve") decision = await approveGate(content, projectRoot, dataDir, params);
    else if (params?.action === "reject") decision = await rejectGate(content, dataDir, params);
    else if (params?.action === "select_cover") await selectCover(content, dataDir, params);
    else if (params) throw new Error("不支持的审核动作");
    if (params && binding) await exportProjectViews(content, binding.project_root);
    const repaired = binding ? await repairProjectViews(content, binding.project_root) : [];
    const ctx = await loadGateContext(content, dataDir);
    const finalCut = await finalCutCard(ctx.execution, projectRoot, dataDir);
    ctx.finalCutChanged = Boolean(finalCut?.changed);
    return { ok: true, enabled: true, final_cut: finalCut, ...(decision ? { decision } : {}), repaired_views: repaired, project: binding, status: content.status,
      draft_hash: ctx.draftHash, title: content.title, platform: content.platform,
      generation: content.video?.handoff?.generation, handoff: content.video?.handoff, handoff_valid: Boolean(ctx.handoff),
      manifest_hash: content.video?.handoff?.hash, decisions: await readProjectJson(id, "decisions.json", dataDir),
      execution: ctx.execution, cover_selection: ctx.selection, approvals: ctx.approvals, gates: gateStates(ctx) };
  });
}

async function saveDecisions(content: Content, dataDir: string, params: Record<string, unknown>): Promise<void> {
  if (params.draft_hash !== draftHash(content)) throw new Error("稿件已更新，请重新确认");
  const { title, cover_text, target_seconds } = params;
  if (!content.platform || typeof title !== "string" || !title.trim() || title !== content.title || typeof cover_text !== "string" || !cover_text.trim() || typeof target_seconds !== "number" || !Number.isFinite(target_seconds) || target_seconds <= 0) throw new Error("请填写当前标题、封面字、平台与目标时长");
  const decisions: ProjectDecisions = { draft_hash: draftHash(content), title, cover_text, platform: content.platform, target_seconds,
    confirmed_at: new Date().toISOString(), source: "founder-workbench" };
  await writeJsonAtomic(contentFile(content.id, dataDir, "decisions.json"), decisions);
}

function liveHandoff(content: Content, manifestHash: unknown) {
  const handoff = content.video?.handoff;
  if (!handoff || handoff.hash !== manifestHash || content.video?.revoked?.includes(handoff.hash)) throw new Error("交接代次已变化");
  return handoff;
}
function gateOf(which: unknown): GateName {
  if (!GATES.includes(which as GateName)) throw new Error("无效的制作闸门");
  return which as GateName;
}
const emptyApprovals = (): StoredApprovals => ({ schema: 2, source: "founder-workbench", bindings: {}, rejections: [] });

/** 成片点击时重算发现字节和页面不一致 = 点击前又导出过一次（§13.4-F 第 3 步） */
const FINAL_CUT_MOVED_ON = "导出文件变了，刷新后再看";

/** 页面展示的文件逐个重算指纹，必须和页面带来的一致。成片可以是剪映导出目录里的候选 */
async function rehash(files: unknown, count: number, projectRoot: string, gate: GateName, dataDir: string): Promise<string[]> {
  if (!Array.isArray(files) || files.length !== count) throw new Error("缺少批准产物");
  const hashes: string[] = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") throw new Error("缺少产物哈希");
    const checked = gate === "final_cut"
      ? await resolveReportedFile(file.path, projectRoot, FINAL_CUT_CANDIDATE, dataDir)
      : await resolveProjectFile(path.join(projectRoot, file.path), projectRoot, gate).then(r => r.ok ? { ok: true as const, value: { file: r.value } } : r);
    if (!checked.ok) throw new Error(String(checked.result.error));
    const sha = await sha256File(checked.value.file);
    if (sha !== file.sha256) throw new Error(gate === "final_cut" ? FINAL_CUT_MOVED_ON : "产物已变化，请刷新后再看");
    hashes.push(sha);
  }
  return hashes;
}

async function approveGate(content: Content, projectRoot: string, dataDir: string, params: Record<string, unknown>) {
  const handoff = liveHandoff(content, params.manifest_hash), gate = gateOf(params.which);
  const hashes = await rehash(params.files, gate === "covers" ? 2 : 1, projectRoot, gate, dataDir);
  const ctx = await loadGateContext(content, dataDir);
  if (gate === "covers") ctx.selection = coverPick(ctx, hashes);
  const target = gate === "covers" ? coverPairHash(hashes[0], hashes[1]) : hashes[0];
  if (approvalTarget(gate, ctx.execution, ctx.selection) !== target) throw new Error(gate === "final_cut" ? FINAL_CUT_MOVED_ON : "产物已变化，请刷新后再看");
  const record = ctx.approvals ?? emptyApprovals();
  // 幂等键（门, 产物指纹）：重复点击返回原记录，不重写时间
  if (record[gate]?.artifact_sha256 === target && approvalInvalidReason(gate, ctx) === "") return record[gate];
  const rejectedFor = rejectionTarget(gate, ctx.execution, ctx.selection);
  if (record.rejections.some(r => r.gate === gate && r.artifact_sha256 === rejectedFor && r.manifest_hash === handoff.hash)) throw new Error("这一版已打回，等新版本再批");
  record[gate] = { artifact_sha256: target, approved_at: new Date().toISOString(), user_message: APPROVAL_MESSAGE };
  record.bindings[gate] = { generation: handoff.generation, manifest_hash: handoff.hash, draft_hash: ctx.draftHash };
  if (gate === "covers") await writeJsonAtomic(contentFile(content.id, dataDir, "cover-selection.json"), ctx.selection);
  await writeJsonAtomic(contentFile(content.id, dataDir, "approvals.json"), record);
  return record[gate];
}

async function rejectGate(content: Content, dataDir: string, params: Record<string, unknown>): Promise<GateRejection> {
  const handoff = liveHandoff(content, params.manifest_hash), gate = gateOf(params.which);
  const note = typeof params.note === "string" ? params.note.trim() : "";
  if (!note) throw new Error("打回要写原话，告诉剪辑哪里要改");
  const ctx = await loadGateContext(content, dataDir);
  const target = rejectionTarget(gate, ctx.execution, ctx.selection);
  if (!target) throw new Error("还没有可打回的产物");
  if (params.artifact_sha256 !== target) throw new Error("产物已变化，请刷新后再看");
  const record = ctx.approvals ?? emptyApprovals();
  const same = record.rejections.find(r => r.gate === gate && r.artifact_sha256 === target && r.manifest_hash === handoff.hash);
  if (same) return same;
  if (gateView(gate, ctx).status === "approved") throw new Error("这一版已批准；要改请让剪辑出新版本");
  const rejection: GateRejection = { gate, note, artifact_sha256: target, rejected_at: new Date().toISOString(), generation: handoff.generation, manifest_hash: handoff.hash };
  record.rejections = [...record.rejections, rejection];
  await writeJsonAtomic(contentFile(content.id, dataDir, "approvals.json"), record);
  return rejection;
}

/** 批准封面时用到的那一对必须是索引里对应尺寸的封面；批准即把选择定成这一对 */
function coverPick(ctx: GateContext, hashes: string[]): CoverSelection {
  const selection: CoverSelection = { ...(ctx.selection ?? {}) };
  (["3:4", "4:3"] as const).forEach((ratio, i) => {
    const hit = ctx.execution?.artifacts.find(a => a.role === COVER_ROLES[ratio] && a.sha256 === hashes[i]);
    if (!hit) throw new Error(`${ratio} 封面不在产物记录里，请刷新后再选`);
    if (selection[ratio]?.sha256 !== hit.sha256) selection[ratio] = { sha256: hit.sha256, path: hit.path, ...(hit.version ? { version: hit.version } : {}), selected_at: new Date().toISOString() };
  });
  return selection;
}

/** 创始人每个尺寸挑一张；只能挑产物索引里登记过的该尺寸封面。选择单独存，report 改不到。 */
async function selectCover(content: Content, dataDir: string, params: Record<string, unknown>): Promise<void> {
  const ratio = params.ratio as CoverRatio;
  if (!(ratio in COVER_ROLES)) throw new Error("封面尺寸只有 3:4 和 4:3");
  const ctx = await loadGateContext(content, dataDir);
  const picked = ctx.execution?.artifacts.find(a => a.role === COVER_ROLES[ratio] && a.sha256 === params.sha256);
  if (!picked) throw new Error("这一版封面不在产物记录里，请刷新后再选");
  const current = ctx.selection ?? {};
  current[ratio] = { sha256: picked.sha256, path: picked.path, ...(picked.version ? { version: picked.version } : {}), selected_at: new Date().toISOString() };
  await writeJsonAtomic(contentFile(content.id, dataDir, "cover-selection.json"), current);
}
