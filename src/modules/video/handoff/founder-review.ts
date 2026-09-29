/**
 * 创始人在工作台上的决定：交接信息、选封面、四道门的批准与打回。
 * 只有浏览器会话路由调用；任何 MCP 动作都造不出创始人决定或批准。
 */
import path from "node:path";
import { getContent, type Content } from "../../../storage/local-store.js";
import { isOntologyActive } from "../../../storage/production-store.js";
import { isVideoPlatform } from "../../../storage/stage-guard.js";
import { workbenchDecision, workbenchOverlay } from "../../production/workbench.js";
import { contentFile, resolveContentProject } from "../../../storage/content-project.js";
import { writeJsonAtomicMkdir as writeJsonAtomic } from "../../../storage/json-atomic.js";
import { exportProjectViews, repairProjectViews } from "../../../storage/project-commit.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { resolveProjectFile } from "./paths.js";
import { FINAL_CUT_CANDIDATE, resolveReportedFile } from "./jianying-root.js";
import { finalCutCard } from "./final-cut.js";
import { sha256File, coverPairHash } from "./manifest.js";
import { readProjectJson, type ProjectDecisions } from "./project-evidence.js";
import type { RegisterApprovals } from "./types.js";
import { serializeVideoLine } from "./lock.js";
import { revokeHandoff } from "./revoke.js";
import { COVER_ROLES, normalizeExecution } from "./execution-index.js";
import { scanCoverFolder, withFolderCovers } from "./cover-scan.js";
import { GATES, approvalInvalidReason, approvalTarget, gateStates, gateView, normalizeApprovals, rejectionTarget,
  type CoverSelection, type GateContext, type GateName, type GateRejection, type StoredApprovals } from "./gate-state.js";

const APPROVAL_MESSAGE = "创始人在 AutoCrew 工作台确认本次展示的产物";

/** 产物索引 + 05-cover/ 文件夹里的封面（封面以文件夹为准，见 cover-scan） */
export async function executionWithCovers(content: Content, dataDir: string, generation: number) {
  const execution = normalizeExecution(await readProjectJson<unknown>(content.id, "execution.json", dataDir));
  const root = resolveContentProject(content.id, dataDir)?.project_root;
  return root ? withFolderCovers(execution, await scanCoverFolder(root, generation), generation) : execution;
}

export async function loadGateContext(content: Content, dataDir: string): Promise<GateContext> {
  const handoff = content.video?.handoff;
  const live = handoff && !content.video?.revoked?.includes(handoff.hash) ? { generation: handoff.generation, hash: handoff.hash } : null;
  return {
    handoff: live, draftHash: draftHash(content),
    approvals: normalizeApprovals(await readProjectJson<unknown>(content.id, "approvals.json", dataDir)),
    execution: await executionWithCovers(content, dataDir, live?.generation ?? handoff?.generation ?? 1),
    selection: await readProjectJson<CoverSelection>(content.id, "cover-selection.json", dataDir),
  };
}

export async function verifyStoredApprovals(content: Content, requested: RegisterApprovals, dataDir: string): Promise<void> {
  // 没绑资料库项目的旧稿（v1）在工作台上没有批准入口，自报的凭据核不了：一律不收，先迁进资料库（P6 §14.7 #1）
  if (!resolveContentProject(content.id, dataDir)) throw new Error("approval_mismatch: 这篇没有绑定资料库项目，工作台上没有创始人批准记录可核；先迁进资料库、在工作台批准后再登记");
  const ctx = await loadGateContext(content, dataDir);
  for (const gate of ["final_cut", "covers"] as const) {
    const view = gateView(gate, ctx);
    if (view.status !== "approved" || JSON.stringify(view.approval) !== JSON.stringify(requested[gate])) throw new Error("approval_mismatch: 未找到与当前代次及产物一致的创始人批准记录");
  }
}

export async function founderProjectReview(id: string, dataDir: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  // 撤回自己排队（全局交接锁 + 这条视频线），不能套在下面的 serializeVideoLine 里，否则自锁
  // 本体（spec 2026-09-29 §8 适配）：按本体走的视频稿，成片 / 封面的批准与打回写成创始人决定，不要交接代次；
  // 撤回交接也关了——往回拖改走「撤销批准 / 重开文稿」
  const current = await getContent(id, dataDir);
  if (current && isVideoPlatform(current.platform) && await isOntologyActive(dataDir, id)) {
    if (params?.action === "revoke") return { ok: false, code: "entry_closed", error: "本体已启用：没有交接可撤。要回到写稿，在卡片上点「重开文稿」；要撤某个批准，在卡片上点「撤销批准」" };
    return ontologyReview(current, dataDir, params);
  }
  if (params?.action === "revoke") return founderRevoke(id, dataDir, params);
  return serializeVideoLine(id, async () => {
    const content = await getContent(id, dataDir), binding = resolveContentProject(id, dataDir);
    if (!content || (!binding && !content.video?.handoff)) return { ok: true, enabled: false, status: content?.status ?? null };
    const projectRoot = binding?.project_root ?? content.video!.handoff!.project_root;
    let decision: unknown;
    if (params?.action === "decisions") await saveDecisions(content, dataDir, params);
    else if (params?.action === "approve") decision = await approveGate(content, projectRoot, dataDir, params);
    else if (params?.action === "reject") decision = await rejectGate(content, dataDir, params);
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

/**
 * 创始人撤回交接（看板「撤回交接」）：浏览器会话本身就是创始人权限，不过认领门；
 * host 不是交接方，revoke 走「认领释放」分支——同 Codex 撤回，重新交接时另发令牌。
 */
async function founderRevoke(id: string, dataDir: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  // 必须带创始人确认时看到的代次：确认框开着期间别处撤了又重交，旧确认不许作废新一代
  const manifestHash = typeof params.manifest_hash === "string" && params.manifest_hash ? params.manifest_hash : null;
  if (!manifestHash) return { ok: false, code: "invalid_params", error: "撤回要带交接代次（manifest_hash），刷新看板再撤" };
  const result = await revokeHandoff({ contentId: id, host: FOUNDER_HOST, manifestHash }, { dataDir, gate: async () => ({ grant: {} }) });
  return { ...result };
}
const FOUNDER_HOST = "founder-workbench";

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

/** 本体下的工作台：决定走 workbenchDecision，页面形状照旧（产物索引 / gate3 / gate4 来自制作记录） */
async function ontologyReview(content: Content, dataDir: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const binding = resolveContentProject(content.id, dataDir);
  let decision: unknown;
  if (params?.action === "decisions") await saveDecisions(content, dataDir, params);
  else if (params?.action === "approve" || params?.action === "reject") {
    const r = await workbenchDecision(content, dataDir, params);
    if (!r.ok) throw new Error(String(r.error ?? "没记上"));
    decision = r.decision;
  } else if (params) throw new Error("不支持的审核动作");
  const fresh = (await getContent(content.id, dataDir)) ?? content;
  const legacy = await loadGateContext(fresh, dataDir);
  const overlay = await workbenchOverlay(fresh, dataDir, legacy.draftHash ?? "");
  const projectRoot = binding?.project_root ?? "";
  return { ok: true, enabled: true, ontology: true, final_cut: projectRoot ? await finalCutCard(overlay.execution, projectRoot, dataDir) : null, ...(decision ? { decision } : {}),
    project: binding, status: fresh.status, draft_hash: legacy.draftHash, title: fresh.title, platform: fresh.platform,
    generation: overlay.handoff.generation, handoff: overlay.handoff, handoff_valid: true, manifest_hash: overlay.handoff.hash,
    decisions: await readProjectJson(content.id, "decisions.json", dataDir), execution: overlay.execution, cover_selection: overlay.selection,
    approvals: null, gates: { ...gateStates(legacy), ...overlay.gates } };
}
