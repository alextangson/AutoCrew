import os from "node:os";
/** Offline, manifest-driven migration. Planning is read-only; original bytes are never deleted. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { digestFile } from "./library-manager.js";
import { writeJsonAtomic, writeTextAtomic } from "./json-atomic.js";
import { PROJECT_LAYOUT, PROJECT_REGISTRY, PROJECT_MIGRATION, PROJECT_RULES, PRODUCTION_RULES, projectName, projectRelativeFile, isMissing,
  assertRelative, safeProjectPath, type ProjectBinding, type ProjectRegistry } from "./content-project.js";
import { isContentId } from "./entity-id.js";
import { portableProjectRecord } from "./project-record.js";
import { exportProjectViews } from "./project-commit.js";
import { getMachineDir, getConfigDir, LIBRARY_MARKER, isWithin } from "./storage-roots.js";
import { acquireLibraryLock } from "./library-lock.js";
import type { Content } from "./local-store.js";
import { handoffEvidence } from "../modules/video/handoff/project-evidence.js";
import { projectBundle } from "../modules/video/handoff/project-bundle.js";
import { manifestHash } from "../modules/video/handoff/manifest.js";
import { draftHash } from "./draft-hash.js";

export interface MigrationFile { source: string; target: string; bytes: number; sha256: string; action: "copy" | "history" | "local-cache" }
export interface MigrationProject {
  binding: ProjectBinding; source: string; editor_sources: string[]; files: MigrationFile[];
  blockers: string[]; state: Record<string, unknown>; dependencies: Array<{ path: string; exists: boolean }>;
}
export interface ProjectMigrationPlan {
  version: 1; migration_id: string; created_at: string; data_dir: string; library_root: string; library_id: string; workspace_id: string;
  projects: MigrationProject[]; unbound: Array<{ source: string; reason: string; files: MigrationFile[]; workflow: unknown; issues?: string[] }>;
  bytes: number; free_bytes: number; notes: string[];
  production_rules?: { source: string; sha256: string; text: string };
  video_config?: { source: string; sha256: string | null };
}
async function json<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { if (isMissing(e)) return null; throw e; }
}
async function exists(file: string): Promise<boolean> { try { await fs.lstat(file); return true; } catch (e) { if (isMissing(e)) return false; throw e; } }
async function walk(root: string, target: (rel: string) => string, issues: string[], prefix = ""): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error(`project_path_symlink: ${root}`);
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name, source = path.join(root, rel);
    if (entry.isSymbolicLink()) { issues.push(`symlink: ${source}`); continue; }
    if (entry.isDirectory()) { files.push(...await walk(root, target, issues, rel)); continue; }
    if (!entry.isFile()) { issues.push(`unsupported_file: ${source}`); continue; }
    const local = /(^|\/)(99-cache|node_modules|\.venv)\//.test(rel) || /\.(db|sqlite|sqlite3)(-wal|-shm)?$|(?:-wal|-shm)$/.test(rel);
    files.push({ source, target: target(rel), bytes: (await fs.stat(source)).size, sha256: await digestFile(source), action: local ? "local-cache" : "copy" });
  }
  return files;
}
function briefState(c: Content, pack: Record<string, unknown> | null): Record<string, unknown> {
  const { token: _token, ...claim } = c.claim ?? {};
  return { content_id: c.id, status: c.status, versions: c.versions?.map(v => ({ version: v.version, savedAt: v.savedAt })), review: c.review,
    claim, pack_id: pack?.packId, attempt_ids: Object.keys((pack?.attempts as object) ?? {}), repair: pack?.repair, reviewRounds: pack?.reviewRounds,
    ledgerBudget: pack?.ledgerBudget, handoff: c.video?.handoff ? { generation: c.video.handoff.generation, hash: c.video.handoff.hash, project_root: c.video.handoff.project_root } : null,
    registered: c.video?.final ? { register_hash: c.video.final.register_hash, sha256: c.video.final.sha256 } : null,
    publishedAt: c.publishedAt, publishUrl: c.publishUrl };
}
function pathValues(value: unknown): string[] {
  if (typeof value === "string") return path.isAbsolute(value) && !value.includes("\n") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(pathValues);
  return value && typeof value === "object" ? Object.values(value).flatMap(pathValues) : [];
}
function editorTarget(rel: string): string {
  if (rel === ".autocrew-owner" || rel === "AGENTS.md" || rel === "项目导航.md" || rel === "project-manifest.json" || rel === "00-project/notes/workflow-state.json") return `00-project/notes/migration/original-editor/${rel}`;
  if (rel.startsWith("封面/")) return rel.replace(/^封面\//, "05-cover/legacy/");
  if (rel.startsWith("06-publish/") && !/^06-publish\/(copy|packages|receipts|metrics)\//.test(rel)) return `06-publish/packages/legacy/${rel.slice(11)}`;
  if (/^(00-project|01-script|02-aroll|03-broll|04-edit|05-audio|05-cover|06-publish|07-delivery)\//.test(rel)) return rel;
  return `00-project/legacy-unclassified/${rel}`;
}
export async function planProjectMigration(dataDir: string, editorRoots: string[] = []): Promise<ProjectMigrationPlan> {
  if (await exists(path.join(dataDir, PROJECT_MIGRATION)) || await exists(path.join(dataDir, PROJECT_LAYOUT)) || await exists(path.join(dataDir, PROJECT_REGISTRY))) throw new Error("工作区已经有项目布局或待恢复切换，请使用 verify/resume");
  const libraryRoot = path.dirname(path.dirname(dataDir));
  const marker = await json<{ id: string }>(path.join(libraryRoot, LIBRARY_MARKER));
  if (!marker?.id || path.basename(path.dirname(dataDir)) !== "workspaces") throw new Error("迁移需明确的资料库工作区");
  const plan: ProjectMigrationPlan = { version: 1, migration_id: `projects-${randomUUID()}`, created_at: new Date().toISOString(), data_dir: dataDir,
    library_root: libraryRoot, library_id: marker.id, workspace_id: path.basename(dataDir), projects: [], unbound: [], bytes: 0, free_bytes: 0,
    notes: ["apply 需要停止写服务与编辑器保存；持有独占锁。未解决的归属/依赖不得自动猜测。", "逐文件校验不代表外部剪辑软件已打开恢复；该项单独验收。", "旧原件只移入恢复隔离区，不删除。"] };
  const contents = path.join(dataDir, "contents");
  const videoConfig = path.join(getConfigDir(dataDir), "video.json");
  plan.video_config = { source: videoConfig, sha256: await exists(videoConfig) ? await digestFile(videoConfig) : null };
  for (const root of editorRoots) {
    const file = path.join(root, "AGENTS.md");
    if (!plan.production_rules && await exists(file)) plan.production_rules = { source: file, sha256: await digestFile(file), text: await fs.readFile(file, "utf8") };
  }
  for (const name of (await fs.readdir(contents)).sort()) {
    const source = path.join(contents, name);
    if (!(await fs.lstat(source)).isDirectory()) { plan.notes.push(`旧格式文件需人工确认：${source}`); continue; }
    const c = await json<Content>(path.join(source, "meta.json"));
    if (!c || c.id !== name) { const issues: string[] = []; plan.unbound.push({ source, reason: "invalid_content_metadata", files: await walk(source, r => r, issues), workflow: null, issues }); continue; }
    const binding: ProjectBinding = { library_id: marker.id, workspace_id: plan.workspace_id, content_id: c.id, project_id: `project-${randomUUID()}`,
      project_relpath: `projects/${projectName(c.id, c.title, new Date(plan.created_at))}`, layout_version: 2, binding_revision: 1 };
    const blockers: string[] = [], files = await walk(source, projectRelativeFile, blockers);
    if (!c.status || !Array.isArray(c.versions) || typeof c.body !== "string") blockers.push("legacy_metadata_incomplete: 保留原记录；缺失状态或版本需要明确恢复方案，不能自动补状态");
    const pack = await json<Record<string, unknown>>(path.join(source, "writing-pack.json"));
    if (files.some(f => /register-journal|content-pending|\.publish-lock\//.test(f.source))) blockers.push("pending_transaction: 先恢复原事务再预览");
    if (c.video?.handoff && !c.video.final && !(c.video.revoked ?? []).includes(c.video.handoff.hash)) {
      try {
        await handoffEvidence(c, dataDir);
        if (draftHash(c) !== c.video.handoff.draft_hash) throw new Error("当前定稿与有效旧交接不同");
        if (await digestFile(c.video.handoff.aroll_path) !== c.video.handoff.aroll_sha256) throw new Error("A-roll 与旧交接哈希不同");
        const source = c.video.handoff.aroll_path;
        files.push({ source, target: `02-aroll/${c.video.handoff.aroll_sha256}${path.extname(source).toLowerCase()}`, bytes: (await fs.stat(source)).size, sha256: c.video.handoff.aroll_sha256, action: "copy" });
      } catch (e) { blockers.push(`active_handoff_evidence_required: ${String(e)}`); }
    }
    for (const v of c.versions ?? []) {
      const file = files.find(f => f.source === path.join(source, "versions", `v${v.version}.md`));
      if (file && file.sha256 !== createHash("sha256").update(v.body).digest("hex")) blockers.push(`version_export_drift: v${v.version}`);
    }
    const adopted = path.join(dataDir, "research/host-evidence", `${c.id}.json`);
    if (await exists(adopted)) files.push({ source: adopted, target: projectRelativeFile("host-evidence.json"), bytes: (await fs.stat(adopted)).size, sha256: await digestFile(adopted), action: "copy" });
    const dependencies = [];
    for (const file of new Set(pathValues(c).filter(p => !isWithin(source, p)))) dependencies.push({ path: file, exists: await exists(file) });
    for (const dep of dependencies) if (!dep.exists) blockers.push(`missing_dependency: ${dep.path}`);
    plan.projects.push({ binding, source, editor_sources: [], files, blockers, state: briefState(c, pack), dependencies });
  }
  const discovered = new Set<string>();
  for (const root of new Set([path.join(dataDir, "projects"), ...editorRoots])) {
    if (!await exists(root)) { plan.notes.push(`未连接的扫描根：${root}`); continue; }
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(root, entry.name);
      if (discovered.has(source)) continue;
      const owner = await json<{ content_id?: string }>(path.join(source, ".autocrew-owner"));
      const workflow = await json<unknown>(path.join(source, "00-project/notes/workflow-state.json"));
      if (!owner && !workflow && !await exists(path.join(source, "project-manifest.json"))) continue;
      discovered.add(source);
      const p = plan.projects.find(p => p.binding.content_id === owner?.content_id);
      const issues: string[] = [], files = await walk(source, editorTarget, issues);
      if (!p) { plan.unbound.push({ source, reason: "needs_binding: 没有可核验的 content_id，不按标题推断", files, workflow, issues }); continue; }
      p.editor_sources.push(source); p.files.push(...files); p.blockers.push(...issues);
      if (workflow) {
        p.state.editor_recovery = workflow;
        p.blockers.push("editor_recovery_required: 核验原工程/时间线/字幕与人工闸门来源后方可切换");
        for (const file of new Set(pathValues(workflow))) if (!isWithin(source, file)) p.dependencies.push({ path: file, exists: await exists(file) });
      }
    }
  }
  for (const p of plan.projects) {
    const targets = new Map<string, string>();
    for (const f of p.files) {
      const previous = targets.get(f.target);
      if (previous && previous !== f.sha256) p.blockers.push(`target_conflict: ${f.target}`);
      targets.set(f.target, f.sha256);
    }
  }
  plan.bytes = [...plan.projects.flatMap(p => p.files), ...plan.unbound.flatMap(p => p.files)].reduce((n, f) => n + f.bytes, 0);
  const stat = await fs.statfs(dataDir); plan.free_bytes = stat.bavail * stat.bsize;
  return plan;
}

interface MigrationJournal { version: 1; plan: ProjectMigrationPlan; phase: "copying" | "publishing" | "active" | "verified" | "rolling_back" | "rolled_back"; installed?: MigrationFile[]; configBefore?: Record<string, unknown> | null; configAfterHash?: string; rollback_moves?: Array<{ from: string; to: string }> }
function journalFile(plan: ProjectMigrationPlan): string { return path.join(getMachineDir(), "migrations", plan.migration_id, "journal.json"); }
async function saveJournal(j: MigrationJournal): Promise<void> { const file = journalFile(j.plan); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeJsonAtomic(file, j); await fs.chmod(file, 0o600); }
async function validatePlan(plan: ProjectMigrationPlan): Promise<void> {
  if (plan.version !== 1 || !/^projects-[a-f0-9-]+$/.test(plan.migration_id) || !/^(default|ws-[a-z0-9]+)$/.test(plan.workspace_id)) throw new Error("migration_plan_invalid");
  if ((await json<{ id: string }>(safeProjectPath(plan.library_root, LIBRARY_MARKER)))?.id !== plan.library_id) throw new Error("migration_library_changed");
  if (path.resolve(plan.data_dir) !== safeProjectPath(path.resolve(plan.library_root), `workspaces/${plan.workspace_id}`)) throw new Error("migration_workspace_invalid");
  for (const p of plan.projects) {
    if (!isContentId(p.binding.content_id) || !/^projects\/[^/\\]+$/.test(p.binding.project_relpath) || p.binding.library_id !== plan.library_id || p.binding.workspace_id !== plan.workspace_id || p.binding.layout_version !== 2) throw new Error("migration_binding_invalid");
    safeProjectPath(plan.data_dir, p.binding.project_relpath);
    if (p.source !== path.join(plan.data_dir, "contents", p.binding.content_id)) throw new Error("migration_source_invalid");
    for (const f of p.files) assertRelative(f.target);
  }
}
async function clearMigrationMarker(plan: ProjectMigrationPlan): Promise<void> {
  const file = safeProjectPath(plan.data_dir, PROJECT_MIGRATION);
  const marker = await json<{ migration_id: string }>(file);
  if (marker && marker.migration_id !== plan.migration_id) throw new Error("migration_marker_conflict");
  await fs.rm(file, { force: true });
}
async function verifySources(plan: ProjectMigrationPlan): Promise<void> {
  if (plan.production_rules && await digestFile(plan.production_rules.source) !== plan.production_rules.sha256) throw new Error("production_rules_changed: 请重新预览");
  for (const project of plan.projects) {
    for (const source of [project.source, ...project.editor_sources]) {
      const issues: string[] = [];
      const sourceSet = (await walk(source, r => r, issues)).map(f => f.source).sort();
      if (issues.length || JSON.stringify(sourceSet) !== JSON.stringify([...new Set(project.files.filter(f => isWithin(source, f.source)).map(f => f.source))].sort())) throw new Error(`source_inventory_changed: ${source}`);
    }
    for (const file of project.files) if (await digestFile(file.source) !== file.sha256) throw new Error(`source_changed: ${file.source}`);
  }
}
/** Explicit journal is required for resume; no directory-exists guessing. */
export async function applyProjectMigration(plan: ProjectMigrationPlan, resume = false): Promise<MigrationJournal> {
  await validatePlan(plan);
  if (plan.unbound.length || plan.projects.some(p => p.blockers.length)) throw new Error("migration_unresolved: 先解决清单中的归属、进行中交接和工程恢复项");
  if (plan.bytes > plan.free_bytes) throw new Error("migration_space_insufficient");
  const release = acquireLibraryLock(plan.library_root);
  try {
    const existing = await json<MigrationJournal>(journalFile(plan));
    if (existing && !resume) throw new Error("已有迁移日志，请 resume");
    if (existing && JSON.stringify(existing.plan) !== JSON.stringify(plan)) throw new Error("migration_plan_changed");
    const j: MigrationJournal = existing ?? { version: 1, plan, phase: "copying" };
    if (j.phase === "rolled_back") throw new Error("此迁移已回退，请重新生成计划");
    if (j.phase === "rolling_back") throw new Error("迁移正在回退，请重试 rollback 继续恢复");
    if (j.phase === "verified") { await quarantineOriginals(plan); await clearMigrationMarker(plan); return j; }
    if (j.phase === "copying") await verifySources(plan);
    const marker = safeProjectPath(plan.data_dir, PROJECT_MIGRATION);
    const active = await json<{ migration_id: string }>(marker);
    if (active && active.migration_id !== plan.migration_id) throw new Error("migration_marker_conflict");
    await writeJsonAtomic(marker, { migration_id: plan.migration_id });
    const stage = safeProjectPath(plan.data_dir, `.project-migration-${plan.migration_id}`);
    if (j.phase === "copying") {
      await saveJournal(j);
      if (plan.video_config) {
        const config = plan.video_config;
        if ((await exists(config.source) ? await digestFile(config.source) : null) !== config.sha256) throw new Error("video_config_changed");
        j.configBefore = await json<Record<string, unknown>>(config.source);
        await saveJournal(j);
      }
      const reg: ProjectRegistry = { version: 2, library_id: plan.library_id, workspace_id: plan.workspace_id, projects: {} };
      await fs.mkdir(stage, { recursive: true });
      for (const p of plan.projects) reg.projects[p.binding.content_id] = p.binding;
      await writeJsonAtomic(path.join(stage, PROJECT_REGISTRY), reg);
      await writeJsonAtomic(path.join(stage, PROJECT_LAYOUT), { version: 2, library_id: plan.library_id, workspace_id: plan.workspace_id });
      for (const p of plan.projects) {
        const root = safeProjectPath(stage, p.binding.project_relpath);
        await fs.mkdir(root, { recursive: true });
        for (const f of p.files) {
          const dest = f.action === "local-cache" ? safeProjectPath(getMachineDir(), `libraries/${plan.library_id}/workspaces/${plan.workspace_id}/cache/${p.binding.project_id}/${f.target}`) : safeProjectPath(root, f.target);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          if (!await exists(dest)) await fs.copyFile(f.source, dest);
          if (await digestFile(dest) !== f.sha256) throw new Error(`copy_hash_mismatch: ${f.source}`);
        }
        await writeJsonAtomic(path.join(root, ".autocrew-owner"), p.binding);
        for (const dir of ["00-project/autocrew", "00-project/notes/migration", "00-project/notes/execution-reports", "01-script/references", "01-script/research", "01-script/evidence", "01-script/manuscripts/versions", "01-script/reviews", "01-script/handoff", "06-publish/copy", "06-publish/packages", "06-publish/receipts", "06-publish/metrics"]) await fs.mkdir(path.join(root, dir), { recursive: true });
        const content = (await json<Content>(path.join(p.source, "meta.json")))!;
        const mapping = Object.fromEntries(p.files.filter(f => f.action !== "local-cache").map(f => [f.source, `@project/${f.target}`]));
        for (const source of [p.source, ...p.editor_sources]) mapping[source] = "@project/.";
        await writeJsonAtomic(path.join(root, "00-project/notes/migration/relocations.json"), mapping);
        await writeJsonAtomic(path.join(root, "00-project/autocrew/relocations.json"), mapping);
        const old = content.video?.handoff;
        if (old && !content.video?.final && !content.video?.revoked?.includes(old.hash)) {
          await writeJsonAtomic(path.join(root, "00-project/notes/migration/original-handoff-record.json"), old);
          const generation = old.generation + 1;
          const bundle = (await projectBundle(content, { ...old, generation, project_root: root }, stage))!;
          for (const [relative, body] of Object.entries(bundle.files)) { const f = path.join(root, relative); await fs.mkdir(path.dirname(f), { recursive: true }); await writeTextAtomic(f, body); }
          const handoffPath = path.join(root, `01-script/handoff/g${String(generation).padStart(4, "0")}/handoff.md`);
          const record = { ...old, ...bundle.manifest, hash: manifestHash(bundle.manifest), project_root: root, handoff_path: handoffPath, project_handoff_path: handoffPath,
            aroll_path: path.join(root, `02-aroll/${old.aroll_sha256}${path.extname(old.aroll_path).toLowerCase()}`), supersedes: { hash: old.hash, generation: old.generation, reason: "storage-relocation" as const } };
          content.video = { ...content.video, handoff: record, revoked: [...(content.video?.revoked ?? []), old.hash] };
          if (content.claim) content.claim = { ...content.claim, token: `clm-${Date.now()}-${randomUUID()}`, machine: os.hostname(), bindingRevision: p.binding.binding_revision, pendingHandoff: true };
          const approvals = await json<Record<string, unknown>>(path.join(root, "00-project/autocrew/approvals.json"));
          if (approvals?.source === "founder-workbench" && approvals.manifest_hash === old.hash) await writeJsonAtomic(path.join(root, "00-project/autocrew/approvals.json"), { ...approvals, generation, manifest_hash: record.hash });
        }
        // Old immutable records and final-script prose stay byte-for-byte in the recovery copy.
        await exportProjectViews(content, root);
        await writeJsonAtomic(path.join(root, "00-project/autocrew/meta.json"), portableProjectRecord(content, root));
        await writeTextAtomic(path.join(root, "AGENTS.md"), PROJECT_RULES);
        reg.projects[content.id] = p.binding;
      }
      await writeJsonAtomic(path.join(stage, PROJECT_REGISTRY), reg);
      await writeJsonAtomic(path.join(stage, PROJECT_LAYOUT), { version: 2, library_id: plan.library_id, workspace_id: plan.workspace_id });
      await verifySources(plan);
      j.phase = "publishing"; await saveJournal(j);
    }
    if (j.phase === "publishing") {
      await verifySources(plan);
      await fs.mkdir(safeProjectPath(plan.data_dir, "projects"), { recursive: true });
      for (const p of plan.projects) {
        const dest = safeProjectPath(plan.data_dir, p.binding.project_relpath), src = safeProjectPath(stage, p.binding.project_relpath);
        if (await exists(src)) {
          if (await exists(dest)) throw new Error(`project_target_exists: ${dest}`);
          await fs.rename(src, dest);
        } else if (!await exists(dest)) throw new Error("migration_project_missing");
      }
      for (const name of [PROJECT_REGISTRY, PROJECT_LAYOUT]) {
        const src = safeProjectPath(stage, name), dest = safeProjectPath(plan.data_dir, name);
        if (await exists(src)) { if (await exists(dest)) throw new Error(`migration_target_exists: ${name}`); await fs.rename(src, dest); }
      }
      await fs.mkdir(safeProjectPath(plan.data_dir, "production"), { recursive: true });
      await writeTextAtomic(safeProjectPath(plan.data_dir, "production/rules-v1.md"), PRODUCTION_RULES + (plan.production_rules ? `\n## 迁移采用的原制作约定\n\n来源 SHA-256: ${plan.production_rules.sha256}\n\n以下旧路径仅用于追踪来源。受管项目存储、状态和归档以项目 AGENTS.md 为准；素材路径从项目迁移映射读取。\n\n${plan.production_rules.text}` : ""));
      if (plan.video_config && j.configBefore) {
        await writeJsonAtomic(plan.video_config.source, { ...j.configBefore, project_roots: [path.join(plan.data_dir, "projects")] });
        j.configAfterHash = await digestFile(plan.video_config.source);
      }
      j.phase = "active"; await saveJournal(j);
    }
    if (j.phase === "active") {
      await verifyProjectMigration(plan);
      j.installed = await walk(path.join(plan.data_dir, "projects"), r => r, []);
      j.phase = "verified"; await saveJournal(j);
      // One active tree; originals are retained as explicitly inactive recovery material.
      await quarantineOriginals(plan);
      await clearMigrationMarker(plan);
    }
    return j;
  } finally { release(); }
}
async function quarantineOriginals(plan: ProjectMigrationPlan): Promise<void> {
  const recovery = safeProjectPath(plan.data_dir, `.project-recovery/${plan.migration_id}`);
  await fs.mkdir(recovery, { recursive: true });
  const old = path.join(plan.data_dir, "contents");
  if (await exists(old)) {
    if (await exists(path.join(recovery, "contents"))) throw new Error("recovery_target_conflict");
    await fs.rename(old, path.join(recovery, "contents"));
  }
  for (const p of plan.projects) for (const source of p.editor_sources) {
    const dest = safeProjectPath(path.dirname(source), `.autocrew-recovery/${plan.migration_id}/${path.basename(source)}`);
    if (await exists(source)) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (await exists(dest)) throw new Error("editor_recovery_target_conflict");
      await fs.rename(source, dest);
    } else if (!await exists(dest)) throw new Error("editor_original_missing");
  }
}
export async function verifyProjectMigration(plan: ProjectMigrationPlan): Promise<{ ok: true; projects: number; editor_recovery: "not_verified" }> {
  await validatePlan(plan);
  const reg = await json<ProjectRegistry>(safeProjectPath(plan.data_dir, PROJECT_REGISTRY));
  const layout = await json<{ version: number; library_id: string; workspace_id: string }>(safeProjectPath(plan.data_dir, PROJECT_LAYOUT));
  if (reg?.version !== 2 || reg.library_id !== plan.library_id || reg.workspace_id !== plan.workspace_id || layout?.version !== 2 || layout.library_id !== plan.library_id || layout.workspace_id !== plan.workspace_id) throw new Error("migration_layout_mismatch");
  for (const p of plan.projects) {
    if (JSON.stringify(reg?.projects[p.binding.content_id]) !== JSON.stringify(p.binding)) throw new Error("migration_binding_mismatch");
    const root = safeProjectPath(plan.data_dir, p.binding.project_relpath);
    if (JSON.stringify(await json<ProjectBinding>(safeProjectPath(root, ".autocrew-owner"))) !== JSON.stringify(p.binding)) throw new Error("migration_owner_mismatch");
    for (const f of p.files) {
      if (f.target === projectRelativeFile("meta.json") || f.target === projectRelativeFile("draft.md")) continue;
      const file = f.action === "local-cache" ? safeProjectPath(getMachineDir(), `libraries/${plan.library_id}/workspaces/${plan.workspace_id}/cache/${p.binding.project_id}/${f.target}`) : safeProjectPath(root, f.target);
      if (await digestFile(file) !== f.sha256) throw new Error(`migration_verify_failed: ${f.target}`);
    }
    const meta = (await json<Content>(path.join(root, "00-project/autocrew/meta.json")))!;
    const original = (await json<Content>(path.join(p.source, "meta.json"))) ?? (await json<Content>(path.join(plan.data_dir, ".project-recovery", plan.migration_id, "contents", meta.id, "meta.json")));
    if (!original || meta.body !== original.body || JSON.stringify(meta.versions) !== JSON.stringify(original.versions) || meta.status !== original.status) throw new Error("migration_content_mismatch");
  }
  return { ok: true, projects: plan.projects.length, editor_recovery: "not_verified" };
}
export async function rollbackProjectMigration(plan: ProjectMigrationPlan): Promise<void> {
  await validatePlan(plan);
  const release = acquireLibraryLock(plan.library_root);
  try {
    const j = await json<MigrationJournal>(journalFile(plan));
    if (!j || JSON.stringify(j.plan) !== JSON.stringify(plan)) throw new Error("migration_plan_changed");
    if (j.phase === "rolled_back") { await clearMigrationMarker(plan); return; }
    if (!["verified", "rolling_back"].includes(j.phase) || !j.installed) throw new Error("只能回退已校验且没有新提交的迁移；未完成迁移先 resume");
    const recovery = safeProjectPath(plan.data_dir, `.project-recovery/${plan.migration_id}`);
    const projects = safeProjectPath(plan.data_dir, "projects"), migrated = safeProjectPath(recovery, "migrated-projects");
    const issues: string[] = [];
    const current = await walk(await exists(projects) ? projects : migrated, r => r, issues);
    const snapshot = (files: MigrationFile[]) => JSON.stringify(files.map(({ source: _source, ...f }) => f));
    if (issues.length || snapshot(current) !== snapshot(j.installed)) throw new Error("rollback_new_work: 已有新写入，需生成保留新增工作的回退清单");
    if (plan.video_config && j.configAfterHash) {
      const currentHash = await digestFile(plan.video_config.source);
      const beforeHash = createHash("sha256").update(JSON.stringify(j.configBefore, null, 2)).digest("hex");
      if (currentHash !== j.configAfterHash && !(j.phase === "rolling_back" && currentHash === beforeHash)) throw new Error("rollback_new_config: 本机视频配置已更新");
    }
    if (j.phase === "verified") {
      // Complete quarantine if apply was interrupted after marking verification.
      await quarantineOriginals(plan);
      j.rollback_moves = [
        ...[PROJECT_LAYOUT, PROJECT_REGISTRY].map(file => ({ from: safeProjectPath(plan.data_dir, file), to: safeProjectPath(recovery, file) })),
        { from: projects, to: migrated },
        { from: safeProjectPath(recovery, "contents"), to: safeProjectPath(plan.data_dir, "contents") },
        ...plan.projects.flatMap(p => p.editor_sources.map(source => ({ from: safeProjectPath(path.dirname(source), `.autocrew-recovery/${plan.migration_id}/${path.basename(source)}`), to: source }))),
      ];
      j.phase = "rolling_back"; await saveJournal(j);
    }
    const marker = safeProjectPath(plan.data_dir, PROJECT_MIGRATION);
    const active = await json<{ migration_id: string }>(marker);
    if (active && active.migration_id !== plan.migration_id) throw new Error("migration_marker_conflict");
    await writeJsonAtomic(marker, { migration_id: plan.migration_id });
    if (!j.rollback_moves) throw new Error("rollback_journal_invalid");
    for (const { from, to } of j.rollback_moves) {
      safeProjectPath(path.dirname(from), path.basename(from));
      safeProjectPath(path.dirname(to), path.basename(to));
      const sourceExists = await exists(from), destExists = await exists(to);
      if (sourceExists && !destExists) await fs.rename(from, to);
      else if (sourceExists || !destExists) throw new Error(`rollback_path_conflict: ${from}`);
      // Missing source plus existing target is a completed recorded move,
      // including a crash after rename but before the next journal write.
    }
    if (plan.video_config && j.configBefore) await writeJsonAtomic(plan.video_config.source, j.configBefore);
    j.phase = "rolled_back"; await saveJournal(j);
    await clearMigrationMarker(plan);
  } finally { release(); }
}
