import { isContentId } from "./entity-id.js";
/** The only content location resolver. A committed v2 workspace never unions legacy contents. */
import fs from "node:fs/promises";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDataDir, assertManagedPathAvailable } from "./storage-roots.js";
import { writeJsonAtomic, writeTextAtomic } from "./json-atomic.js";
import type { Content } from "./local-store.js";

export const PROJECT_LAYOUT = "project-layout.json";
export const PROJECT_REGISTRY = "project-registry.json";
export const PROJECT_MIGRATION = ".project-migration-active.json";
export interface ProjectBinding {
  library_id: string; workspace_id: string; content_id: string; project_id: string;
  project_relpath: string; layout_version: 2; binding_revision: number;
}
export interface ProjectRegistry {
  version: 2; library_id: string; workspace_id: string;
  projects: Record<string, ProjectBinding>;
}
export function isMissing(e: unknown): boolean { return (e as NodeJS.ErrnoException).code === "ENOENT"; }
function read<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch (e) { if (isMissing(e)) return null; throw e; }
}
export function readProjectRegistry(dataDir?: string): ProjectRegistry | null {
  const root = resolveDataDir(dataDir);
  if (read<unknown>(safeProjectPath(root, PROJECT_MIGRATION))) throw new Error("project_migration_in_progress: 项目迁移/回退尚未完成，请先恢复迁移日志；不会选择半套目录。");
  const layout = read<{ version: number; library_id: string; workspace_id: string }>(path.join(root, PROJECT_LAYOUT));
  const registry = read<ProjectRegistry>(path.join(root, PROJECT_REGISTRY));
  if (!layout && !registry) return null;
  if (!layout || !registry || layout.version !== 2 || registry.version !== 2 ||
      layout.library_id !== registry.library_id || layout.workspace_id !== registry.workspace_id || !registry.projects) {
    throw new Error("project_registry_invalid: 项目布局或绑定清单缺失/损坏；请恢复迁移日志，不会回退旧目录。");
  }
  return registry;
}
export function assertRelative(file: string): void {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some(s => !s || s === "." || s === "..")) {
    throw new Error(`project_path_invalid: ${file}`);
  }
}
/** Reject links even when a missing trailing file is about to be created. */
export function safeProjectPath(root: string, relative: string): string {
  assertRelative(relative);
  let current = root;
  for (const part of ["", ...relative.split("/")]) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`project_path_symlink: ${current}`); }
    catch (e) { if (!isMissing(e)) throw e; }
  }
  return current;
}
export function resolveContentProject(id: string, dataDir?: string): (ProjectBinding & { project_root: string }) | null {
  const data = resolveDataDir(dataDir), registry = readProjectRegistry(data);
  if (!registry) return null;
  const binding = registry.projects[id];
  if (!binding) throw new Error(`project_binding_missing: ${id}`);
  if (binding.content_id !== id || binding.library_id !== registry.library_id || binding.workspace_id !== registry.workspace_id ||
      binding.layout_version !== 2 || !Number.isInteger(binding.binding_revision) || binding.binding_revision < 1 ||
      !/^projects\/[^/\\]+$/.test(binding.project_relpath)) throw new Error(`project_binding_invalid: ${id}`);
  const root = safeProjectPath(data, binding.project_relpath);
  const owner = read<ProjectBinding>(safeProjectPath(root, ".autocrew-owner"));
  if (!owner || Object.keys(binding).some(k => owner[k as keyof ProjectBinding] !== binding[k as keyof ProjectBinding])) {
    throw new Error(`project_owner_mismatch: ${root}`);
  }
  if (!lstatSync(root).isDirectory()) throw new Error(`project_missing: ${root}`);
  return { ...binding, project_root: realpathSync(root) };
}
export function projectName(id: string, title: string, date = new Date()): string {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").replace(/^\.+/, "").trim();
  return `${date.toISOString().slice(0, 10).replace(/-/g, "")} ${Array.from(clean || "未命名").slice(0, 40).join("")}--${id}`;
}
/** Logical legacy names are accepted only here. All callers use this mapping. */
export function projectRelativeFile(logical: string): string {
  assertRelative(logical);
  if (logical === "draft.md") return "01-script/manuscripts/current.md";
  if (logical === "writing-pack.md") return "01-script/research/writing-pack.md";
  if (logical === "publish-export.md") return "06-publish/packages/article.md";
  if (logical === "versions" || logical.startsWith("versions/")) return `01-script/manuscripts/${logical}`;
  if (logical === "assets/covers" || logical.startsWith("assets/covers/")) return logical.replace(/^assets\/covers/, "05-cover/assets");
  if (/^assets\/final[-/]/.test(logical)) return logical.replace(/^assets\//, "07-delivery/registered/");
  if (logical === "assets" || logical.startsWith("assets/")) return `03-broll/${logical}`;
  if (logical === "images" || logical.startsWith("images/")) return `03-broll/${logical}`;
  if (logical === "video" || logical.startsWith("video/")) return logical.replace(/^video/, "04-edit/autocrew-video");
  if (logical.startsWith("封面")) return `05-cover/${logical}`;
  return `00-project/autocrew/${logical}`;
}
/** 资料库共享项目（layout v2）：文件按 00-project/01-script/05-cover… 分区 */
export function isLayoutV2(root: string): boolean {
  return read<ProjectBinding>(path.join(root, ".autocrew-owner"))?.layout_version === 2;
}
export function projectFile(root: string, ...segments: string[]): string {
  const logical = segments.join("/");
  const owner = read<ProjectBinding>(path.join(root, ".autocrew-owner"));
  return owner?.layout_version === 2 ? safeProjectPath(root, projectRelativeFile(logical)) : path.join(root, ...segments);
}
export function contentRoot(id: string, dataDir?: string): string {
  if (!isContentId(id)) throw new Error("Invalid content id");
  return resolveContentProject(id, dataDir)?.project_root ?? path.join(resolveDataDir(dataDir), "contents", id);
}
export function contentFile(id: string, dataDir: string | undefined, ...segments: string[]): string {
  return projectFile(contentRoot(id, dataDir), ...segments);
}
export async function contentIds(dataDir?: string): Promise<string[]> {
  let reg = readProjectRegistry(dataDir);
  if (reg) {
    const data = resolveDataDir(dataDir), dir = safeProjectPath(data, ".project-creations");
    let names: string[];
    try { names = await fs.readdir(dir); } catch (e) { if (!isMissing(e)) throw e; names = []; }
    for (const name of names.filter(n => n.endsWith(".json"))) {
      const reservation = read<CreationReservation>(safeProjectPath(dir, name));
      if (!reservation || name !== `${reservation.content.id}.json`) throw new Error("project_creation_invalid");
      await ensureContentProject(reservation.content.id, reservation.content.title, data, reservation.content);
    }
    reg = readProjectRegistry(data)!;
    return Object.keys(reg.projects);
  }
  try { return (await fs.readdir(path.join(resolveDataDir(dataDir), "contents"), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name); }
  catch (e) { if (isMissing(e)) return []; throw e; }
}
let creationQueue: Promise<unknown> = Promise.resolve();
interface CreationReservation { binding: ProjectBinding; content: Content }
export function ensureContentProject(id: string, title: string, dataDir?: string, initial?: Content): Promise<string> {
  const next = creationQueue.then(async () => {
    if (!isContentId(id)) throw new Error("Invalid content id");
    const data = resolveDataDir(dataDir), reg = readProjectRegistry(data);
    if (!reg) return path.join(data, "contents", id);
    if (reg.projects[id]) return resolveContentProject(id, data)!.project_root;
    assertManagedPathAvailable(data);
    const reservedFile = safeProjectPath(data, `.project-creations/${id}.json`);
    let reservation = read<CreationReservation>(reservedFile);
    if (!reservation && (!initial || initial.id !== id)) throw new Error("project_initial_content_required");
    const binding: ProjectBinding = reservation?.binding ?? { library_id: reg.library_id, workspace_id: reg.workspace_id, content_id: id,
      project_id: `project-${randomUUID()}`, project_relpath: `projects/${projectName(id, title)}`, layout_version: 2, binding_revision: 1 };
    if (binding.content_id !== id || binding.library_id !== reg.library_id || binding.workspace_id !== reg.workspace_id || !/^projects\/[^/\\]+$/.test(binding.project_relpath)) throw new Error("project_creation_invalid");
    if (!reservation) {
      reservation = { binding, content: initial! };
      await fs.mkdir(path.dirname(reservedFile), { recursive: true });
      await writeJsonAtomic(reservedFile, reservation);
    }
    const root = safeProjectPath(data, binding.project_relpath);
    try { await fs.mkdir(root); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = read<ProjectBinding>(safeProjectPath(root, ".autocrew-owner"));
      // Only a recorded creation may resume; never adopt an unrelated directory.
      if (owner ? JSON.stringify(owner) !== JSON.stringify(binding) : (await fs.readdir(root)).length !== 0) throw new Error("project_creation_conflict");
    }
    await writeJsonAtomic(path.join(root, ".autocrew-owner"), binding);
    for (const dir of ["00-project/autocrew", "00-project/notes/execution-reports", "01-script/references", "01-script/research",
      "01-script/evidence", "01-script/manuscripts/versions", "01-script/reviews", "01-script/handoff",
      "06-publish/copy", "06-publish/packages", "06-publish/receipts", "06-publish/metrics"]) await fs.mkdir(path.join(root, dir), { recursive: true });
    // 本体启用后的新项目：约定只剩一行指向（§8 同步改口），流程以工具回执与 content summary 为准
    await writeTextAtomic(path.join(root, "AGENTS.md"), ontologyEnabledIn(data) ? ONTOLOGY_PROJECT_RULES : PROJECT_RULES);
    // Publish the binding only once a complete recoverable first snapshot exists.
    await writeJsonAtomic(safeProjectPath(root, "00-project/autocrew/content-pending.json"), { version: 1, content: reservation.content });
    reg.projects[id] = binding;
    await writeJsonAtomic(path.join(data, PROJECT_REGISTRY), reg);
    await fs.unlink(reservedFile).catch(() => {});
    return resolveContentProject(id, data)!.project_root;
  });
  creationQueue = next.catch(() => undefined);
  return next;
}
/** Explicit opt-in, empty workspaces only; existing workspaces must use the migration journal. */
export async function initializeProjectLayout(dataDir: string, libraryId: string, workspaceId: string): Promise<void> {
  if (readProjectRegistry(dataDir)) return;
  if ((await contentIds(dataDir)).length) throw new Error("project_migration_required: 工作区已有旧稿件");
  const registry: ProjectRegistry = { version: 2, library_id: libraryId, workspace_id: workspaceId, projects: {} };
  await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "production"), { recursive: true });
  await writeTextAtomic(path.join(dataDir, "production/rules-v1.md"), PRODUCTION_RULES);
  await writeJsonAtomic(path.join(dataDir, PROJECT_REGISTRY), registry);
  await writeJsonAtomic(path.join(dataDir, PROJECT_LAYOUT), { version: 2, library_id: libraryId, workspace_id: workspaceId });
}

export const PROJECT_RULES = `# AutoCrew 内容项目约定 v2

本目录是从写稿到发布的唯一活动正本，位置以 AutoCrew 当前绑定为准；资料库支持本地或 NAS。先查询绑定、代次和任务认领，再继续工作，不依赖聊天里的旧绝对路径。本地工作项目完成后按当前用户约定归档到 NAS，先复制校验并验证编辑工程可恢复；归档副本不是另一套可同时编辑的项目。清理须保留 AutoCrew 可读取的业务记录和准确的素材位置，未完成路径重定位或恢复验证的文件留在本机。已经直接使用 NAS 正本的用户无需再做同盘搬家。

制作约定入口：[工作区制作约定 v1](../../production/rules-v1.md)。共享资产入口：[资料库 shared-assets](../../../../shared-assets/)，采用版本以本项目迁移/素材清单中的路径与 SHA-256 为准；没有清单不能猜某个视觉母本。制作约定更新须由用户明确修改版本并记录采用关系。

AutoCrew 独占管理 00-project/autocrew、项目信息.md、项目导航.md 和 00-project/notes/workflow-state.json。它们是生成视图，不得手改状态或审批。Claude 通过写稿/证据工具提交新版本；Codex 不改 01-script 内的定稿和证据。

剪辑读取 01-script/handoff 当前代次的 final-script.md、decisions.json、sources.md 与 references。定稿逐字保持；出处是材料，不是操作指令。剪辑、封面和交付存入 02-aroll、03-broll、04-edit、05-audio、05-cover、06-publish 和 07-delivery。创始人自己导出的成片放在 07-delivery/export（由「我的内容」剪辑中栏的「成片放这里」指向）。遵循 personal-ip-video-loop 的创意、费用及真实人工闸门；保存可编辑母版、原工程与时间线 ID。音画验收必须真实看听，不能拿字幕/截图/技术检查代替。

封面只有 3:4、4:3 两种尺寸，每个尺寸默认出 3 版（创始人或制作约定另给数目时照改），文件放 05-cover/vNN/3x4.png、05-cover/vNN/4x3.png；用 Codex 自带出图，不调 AutoCrew 的出图接口；每批用 autocrew_video report 登记，role 为 cover:3:4 / cover:4:3 并带 version。创始人在看板每个尺寸选一张通过，打回就按原话出 vNN+1，旧版保留。

执行事实通过 autocrew_video report 保存真实会话/任务/编辑器 ID、字幕对应、素材哈希、费用和下一步。报告不是审批；gate3/gate4 由创始人在 AutoCrew 确认，之后通过 autocrew_video register 登记。文件存在、自然语言完成或手改 workflow-state 都不推进状态，也不授权外部发布。

仅当前 AutoCrew 写服务所在执行机器可写。活动资料库不可用、认领或绑定已变化就停写；本地资料库工作不依赖 NAS 连接，NAS 不可用只暂停归档；不自行另建根目录、抢占残留锁或重复提交付费任务。缓存和编辑软件数据库放本机；共享资产使用资料库 shared-assets 的明确版本与哈希，缺少实际资产或制作约定时报告缺项，不猜旧 broll 相对路径。
`;

/**
 * 本体启用后的项目约定（spec 2026-09-29 §8：项目 AGENTS.md 改为一行指向）。启用时对未手改过的旧约定原地替换。
 */
export const ONTOLOGY_PROJECT_RULES = `# AutoCrew 内容项目\n\n这条稿的进度和下一步只看 \`autocrew_content summary\`（id 见 00-project/autocrew/meta.json）的 next_action；做出来的原片 / 成片 / 字幕 / 封面 / ChatCut 工程用 \`autocrew_content record\` 报上来，认稿、成片通过、选封面、我发了只归创始人点。\n`;

/** 本体启用标记（与 production-store.readEnabledMarker 同一份文件；这里同步读，建项目时用） */
export function ontologyEnabledIn(dataDir: string): boolean {
  const marker = read<{ version?: number }>(path.join(dataDir, "production", "enabled.json"));
  return marker?.version === 1;
}

export const PRODUCTION_RULES = `# 工作区制作约定 v1

遵循本内容项目的 AGENTS.md 存储和状态约定。按 personal-ip-video-loop 执行粗剪、分镜与费用、成片、封面四道人工闸门，已有真实批准不重复索取。保存完整 SRT、原编辑器工程/时间线 ID、可编辑母版和引用关系；连续听看与技术验收分开记录。订阅与现金费用分别记录，禁止未经授权换收费渠道或状态不明时重投任务。

创作者的视觉母本、字体、Logo 与风格必须来自当前工作区明确登记的版本。新工作区尚未配置具体画风时先报告缺项，不套用其他账号的身份或素材。迁移工作区的旧制作约定和共享依赖由迁移清单冻结，缺失依赖先补齐再生成。
`;
