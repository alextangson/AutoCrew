import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getContent } from "../../../storage/local-store.js";
import { contentFile, resolveContentProject } from "../../../storage/content-project.js";
import { writeJsonAtomic } from "../../../storage/json-atomic.js";
import { exportProjectViews } from "../../../storage/project-commit.js";
import { resolveReportedFile, type ReportedLocation } from "./jianying-root.js";
import { sha256File, sha256Text } from "./manifest.js";
import { readProjectJson } from "./project-evidence.js";
import type { HandoffContext } from "./handoff.js";
import { serializeVideoLine } from "./lock.js";
import { COVER_ROLES, mergeArtifacts, normalizeExecution, type StoredExecution } from "./execution-index.js";

export interface ExecutionReport {
  request_id: string; generation: number; binding_revision: number; session_id: string;
  editor_project_id?: string; timeline_id?: string; job_ids?: string[]; process_ids?: number[];
  files: Array<{ path: string; sha256: string; role: string; version?: number; timeline_id?: string }>;
  jianying_draft?: string;
  costs?: Array<{ provider: string; job_id: string; amount: number; unit: string }>;
  result: string; next_action: string; error?: string;
}
const FIELDS = new Set(["request_id", "generation", "binding_revision", "session_id", "editor_project_id", "timeline_id", "job_ids", "process_ids", "files", "costs", "result", "next_action", "error", "jianying_draft"]);
const FILE_FIELDS = new Set(["path", "sha256", "role", "version", "timeline_id"]);
const COVER_ROLE_SET = new Set<string>(Object.values(COVER_ROLES));
function only(value: object, fields: Set<string>): boolean { return Object.keys(value).every(k => fields.has(k)); }
export function validateReport(value: unknown): asserts value is ExecutionReport {
  if (!value || typeof value !== "object" || Array.isArray(value) || !only(value, FIELDS)) throw new Error("report 仅接受执行事实；不允许状态、审批或稿件补丁");
  const r = value as ExecutionReport;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(r.request_id) || !r.session_id?.trim() || !Number.isInteger(r.generation) || !Number.isInteger(r.binding_revision) ||
      typeof r.result !== "string" || typeof r.next_action !== "string" || !Array.isArray(r.files) || JSON.stringify(r).length > 100_000) throw new Error("report 参数不完整或超预算");
  for (const f of r.files) {
    if (!f || typeof f !== "object" || !only(f, FILE_FIELDS) || typeof f.path !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) || typeof f.role !== "string" || !f.role.trim()) throw new Error("report 文件记录不合法");
    if (f.version !== undefined && (!Number.isInteger(f.version) || f.version <= 0)) throw new Error("report 文件 version 必须是正整数");
    if (COVER_ROLE_SET.has(f.role) && f.version === undefined) throw new Error(`report 封面文件缺少 version：${f.role}`);
  }
  if (r.jianying_draft !== undefined && (typeof r.jianying_draft !== "string" || !r.jianying_draft.trim())) throw new Error("jianying_draft 不合法");
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
    const execution = normalizeExecution(await readProjectJson<unknown>(id, "execution.json", ctx.dataDir));
    if (execution && execution.generation === input.generation && (execution.machine !== os.hostname() || execution.session_id !== input.session_id)) throw new Error("execution_owned_by_other: 请先办理执行权转移");
    const gate = await ctx.gate();
    if ("denied" in gate) return gate.denied;
    const files: IndexedFile[] = [];
    for (const file of input.files) {
      const checked = await resolveReportedFile(file.path, binding.project_root, file.role, ctx.dataDir);
      if (!checked.ok) return checked.result;
      files.push(await indexedFile(file, checked.value, binding.project_root, binding.project_id));
    }
    const transport = authenticatedSession ?? content.claim?.session ?? null;
    const record = { ...input, files, machine: os.hostname(), host, transport_session: transport };
    const fingerprint = sha256Text(JSON.stringify({ ...input, files, machine: os.hostname(), host }));
    const file = path.join(binding.project_root, "00-project/notes/execution-reports", `${input.request_id}.json`);
    let previous: { fingerprint: string } | null = null;
    try { previous = JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (previous && previous.fingerprint !== fingerprint) throw new Error("report_request_conflict: 同一请求编号的内容不同");
    const reportedAt = new Date().toISOString();
    if (!previous) await writeJsonAtomic(file, { ...record, fingerprint, recorded_at: reportedAt });
    // Repeating a historical report must not overwrite newer recovery facts.
    if (!previous) await writeJsonAtomic(contentFile(id, ctx.dataDir, "execution.json"), nextExecution(execution, input, files, host, transport, reportedAt));
    await exportProjectViews((await getContent(id, ctx.dataDir))!, binding.project_root);
    return { ok: true, replayed: Boolean(previous), request_id: input.request_id, project_root: binding.project_root, ...gate.grant };
  });
}
type IndexedFile = ExecutionReport["files"][number] & { size: number; mtime_ms: number; external?: "jianying"; project_id?: string };
/** 核字节并记下位置事实；项目外的成片候选存绝对路径并绑定项目（代次由产物索引那一层记） */
async function indexedFile(file: ExecutionReport["files"][number], at: ReportedLocation, projectRoot: string, projectId: string): Promise<IndexedFile> {
  if (await sha256File(at.file) !== file.sha256) throw new Error(`report_file_changed: ${file.role}`);
  const st = await fs.stat(at.file);
  const facts = { size: st.size, mtime_ms: Math.trunc(st.mtimeMs) };
  if (at.external) return { ...file, path: at.file, ...facts, external: "jianying", project_id: projectId };
  return { ...file, path: path.relative(projectRoot, at.file), ...facts };
}
/** 心跳整条替换；产物索引累计追加（旧版本不丢，挪位置只改路径）。 */
function nextExecution(prev: StoredExecution | null, input: ExecutionReport, files: ExecutionReport["files"], host: string, transport: string | null, at: string): StoredExecution {
  const { request_id, session_id, result, next_action, error, files: _f, binding_revision: _b, ...facts } = input;
  return {
    ...facts, schema: 2, session_id, machine: os.hostname(), host, transport_session: transport,
    ...(prev?.jianying_draft && !input.jianying_draft ? { jianying_draft: prev.jianying_draft } : {}),
    heartbeat: { request_id, session_id, result, next_action, ...(error ? { error } : {}), reported_at: at },
    artifacts: mergeArtifacts(prev?.artifacts ?? [], files, input.generation, at),
  };
}
