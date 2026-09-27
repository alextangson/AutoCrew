import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getContent, type Content } from "../../../storage/local-store.js";
import { contentFile, resolveContentProject } from "../../../storage/content-project.js";
import { writeJsonAtomic } from "../../../storage/json-atomic.js";
import { exportProjectViews, repairProjectViews } from "../../../storage/project-commit.js";
import { draftHash } from "../../../storage/draft-hash.js";
import { resolveProjectFile } from "./paths.js";
import { sha256File, sha256Text, coverPairHash } from "./manifest.js";
import { readProjectJson, type ProjectDecisions } from "./project-evidence.js";
import type { HandoffContext } from "./handoff.js";
import type { RegisterApprovals } from "./types.js";
import { serializeVideoLine } from "./lock.js";

export interface ExecutionReport {
  request_id: string; generation: number; binding_revision: number; session_id: string;
  editor_project_id?: string; timeline_id?: string; job_ids?: string[]; process_ids?: number[];
  files: Array<{ path: string; sha256: string; role: string; timeline_id?: string }>;
  costs?: Array<{ provider: string; job_id: string; amount: number; unit: string }>;
  result: string; next_action: string; error?: string;
}
const FIELDS = new Set(["request_id", "generation", "binding_revision", "session_id", "editor_project_id", "timeline_id", "job_ids", "process_ids", "files", "costs", "result", "next_action", "error"]);
function only(value: object, fields: Set<string>): boolean { return Object.keys(value).every(k => fields.has(k)); }
export function validateReport(value: unknown): asserts value is ExecutionReport {
  if (!value || typeof value !== "object" || Array.isArray(value) || !only(value, FIELDS)) throw new Error("report 仅接受执行事实；不允许状态、审批或稿件补丁");
  const r = value as ExecutionReport;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(r.request_id) || !r.session_id?.trim() || !Number.isInteger(r.generation) || !Number.isInteger(r.binding_revision) ||
      typeof r.result !== "string" || typeof r.next_action !== "string" || !Array.isArray(r.files) || JSON.stringify(r).length > 100_000) throw new Error("report 参数不完整或超预算");
  for (const f of r.files) if (!only(f, new Set(["path", "sha256", "role", "timeline_id"])) || typeof f.path !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) || typeof f.role !== "string") throw new Error("report 文件记录不合法");
  if (r.costs && (!Array.isArray(r.costs) || r.costs.some(c => !only(c, new Set(["provider", "job_id", "amount", "unit"])) || !Number.isFinite(c.amount) || c.amount < 0 || typeof c.provider !== "string" || typeof c.job_id !== "string" || typeof c.unit !== "string"))) throw new Error("report 费用记录不合法");
  if (r.job_ids && (!Array.isArray(r.job_ids) || r.job_ids.some(j => typeof j !== "string"))) throw new Error("job_ids 不合法");
  if (r.process_ids && (!Array.isArray(r.process_ids) || r.process_ids.some(j => !Number.isInteger(j) || j <= 0))) throw new Error("process_ids 不合法");
}
export async function reportExecution(id: string, input: unknown, ctx: HandoffContext, host: string, authenticatedSession?: string): Promise<Record<string, unknown>> {
  validateReport(input);
  return serializeVideoLine(id, async () => {
    const content = await getContent(id, ctx.dataDir), binding = resolveContentProject(id, ctx.dataDir);
    if (!content || !binding) throw new Error("需要已绑定的共享内容项目");
    if (input.binding_revision !== binding.binding_revision) throw new Error("project_relocated: 请读取当前绑定");
    const handoff = content.video?.handoff;
    if (!handoff || input.generation !== handoff.generation || content.video?.revoked?.includes(handoff.hash)) throw new Error("stale_handoff");
    const execution = await readProjectJson<{ machine: string; session_id: string; generation: number }>(id, "execution.json", ctx.dataDir);
    if (execution && execution.generation === input.generation && (execution.machine !== os.hostname() || execution.session_id !== input.session_id)) throw new Error("execution_owned_by_other: 请先办理执行权转移");
    const gate = await ctx.gate();
    if ("denied" in gate) return gate.denied;
    const files = [];
    for (const file of input.files) {
      const checked = await resolveProjectFile(path.isAbsolute(file.path) ? file.path : path.join(binding.project_root, file.path), binding.project_root, file.role);
      if (!checked.ok) return checked.result;
      if (await sha256File(checked.value) !== file.sha256) throw new Error(`report_file_changed: ${file.role}`);
      files.push({ ...file, path: path.relative(binding.project_root, checked.value) });
    }
    const record = { ...input, files, machine: os.hostname(), host, transport_session: authenticatedSession ?? content.claim?.session ?? null };
    const fingerprint = sha256Text(JSON.stringify({ ...input, files, machine: os.hostname(), host }));
    const file = path.join(binding.project_root, "00-project/notes/execution-reports", `${input.request_id}.json`);
    let previous: { fingerprint: string } | null = null;
    try { previous = JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (previous && previous.fingerprint !== fingerprint) throw new Error("report_request_conflict: 同一请求编号的内容不同");
    if (!previous) await writeJsonAtomic(file, { ...record, fingerprint, recorded_at: new Date().toISOString() });
    // Repeating a historical report must not overwrite newer recovery facts.
    if (!previous) await writeJsonAtomic(contentFile(id, ctx.dataDir, "execution.json"), record);
    await exportProjectViews((await getContent(id, ctx.dataDir))!, binding.project_root);
    return { ok: true, replayed: Boolean(previous), request_id: input.request_id, project_root: binding.project_root, ...gate.grant };
  });
}
export interface StoredApprovals {
  generation: number; manifest_hash: string; final_cut?: RegisterApprovals["final_cut"]; covers?: RegisterApprovals["covers"];
  rough_cut?: RegisterApprovals["final_cut"]; storyboard?: RegisterApprovals["final_cut"];
  source: "founder-workbench";
}
export async function verifyStoredApprovals(content: Content, requested: RegisterApprovals, dataDir: string): Promise<void> {
  if (!resolveContentProject(content.id, dataDir)) return; // v1 compatibility only
  const stored = await readProjectJson<StoredApprovals>(content.id, "approvals.json", dataDir);
  if (!stored || stored.source !== "founder-workbench" || stored.generation !== content.video?.handoff?.generation || stored.manifest_hash !== content.video?.handoff?.hash ||
      JSON.stringify(stored.final_cut) !== JSON.stringify(requested.final_cut) || JSON.stringify(stored.covers) !== JSON.stringify(requested.covers)) throw new Error("approval_mismatch: 未找到与当前代次及产物一致的创始人批准记录");
}
/** Only the browser-session route calls this; no MCP action can create founder decisions/approvals. */
export async function founderProjectReview(id: string, dataDir: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return serializeVideoLine(id, async () => {
    const content = await getContent(id, dataDir), binding = resolveContentProject(id, dataDir);
    if (!content || (!binding && !content.video?.handoff)) return { ok: true, enabled: false };
    const projectRoot = binding?.project_root ?? content.video!.handoff!.project_root;
    if (params?.action === "decisions") {
      if (params.draft_hash !== draftHash(content)) throw new Error("稿件已更新，请重新确认");
      const { title, cover_text, target_seconds } = params;
      if (!content.platform || typeof title !== "string" || !title.trim() || title !== content.title || typeof cover_text !== "string" || !cover_text.trim() || typeof target_seconds !== "number" || !Number.isFinite(target_seconds) || target_seconds <= 0) throw new Error("请填写当前标题、封面字、平台与目标时长");
      const decisions: ProjectDecisions = { draft_hash: draftHash(content), title, cover_text, platform: content.platform, target_seconds,
        confirmed_at: new Date().toISOString(), source: "founder-workbench" };
      await writeJsonAtomic(contentFile(id, dataDir, "decisions.json"), decisions);
    } else if (params?.action === "approve") {
      const handoff = content.video?.handoff;
      if (!handoff || handoff.hash !== params.manifest_hash || content.video?.revoked?.includes(handoff.hash)) throw new Error("交接代次已变化");
      const which = params.which;
      if (which !== "final_cut" && which !== "covers" && which !== "rough_cut" && which !== "storyboard") throw new Error("无效的制作闸门");
      const files = params.files;
      if (!Array.isArray(files) || files.length !== (which === "covers" ? 2 : 1)) throw new Error("缺少批准产物");
      const hashes: string[] = [];
      for (const file of files) {
        if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") throw new Error("缺少产物哈希");
        const checked = await resolveProjectFile(path.join(projectRoot, file.path), projectRoot, which);
        if (!checked.ok) throw new Error(String(checked.result.error));
        const sha = await sha256File(checked.value);
        if (sha !== file.sha256) throw new Error("产物已变化，请重新审阅");
        hashes.push(sha);
      }
      const existing = await readProjectJson<StoredApprovals>(id, "approvals.json", dataDir);
      const record: StoredApprovals = existing?.manifest_hash === handoff.hash ? existing : { generation: handoff.generation, manifest_hash: handoff.hash, source: "founder-workbench" };
      record[which] = { artifact_sha256: which === "covers" ? coverPairHash(hashes[0], hashes[1]) : hashes[0], approved_at: new Date().toISOString(), user_message: "创始人在 AutoCrew 工作台确认本次展示的产物" };
      await writeJsonAtomic(contentFile(id, dataDir, "approvals.json"), record);
      if (binding) await exportProjectViews(content, binding.project_root);
    } else if (params) throw new Error("不支持的审核动作");
    const repaired = binding ? await repairProjectViews(content, binding.project_root) : [];
    return { ok: true, enabled: true, repaired_views: repaired, project: binding, draft_hash: draftHash(content), title: content.title, platform: content.platform,
      generation: content.video?.handoff?.generation, handoff: content.video?.handoff,
      manifest_hash: content.video?.handoff?.hash, decisions: await readProjectJson(id, "decisions.json", dataDir),
      execution: await readProjectJson(id, "execution.json", dataDir), approvals: await readProjectJson(id, "approvals.json", dataDir) };
  });
}
