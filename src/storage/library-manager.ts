import { initializeProjectLayout } from "./content-project.js";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./json-atomic.js";
import {
  LIBRARY_MARKER, STORAGE_CONFIG, assertLibraryAvailable, canonicalTarget, getMachineDir,
  getLibraryRoot, getConfigDir, resolveDataDir, isWithin, readLibraryLocation, type LibraryLocation, type LibraryManifest,
} from "./storage-roots.js";
import { acquireLibraryLock, WRITER_LOCK } from "./library-lock.js";

export const PENDING_STORAGE = "storage-pending.json";
export const CONFIG_FILES = ["engine.json", "publish.json", "search.json", "cover.json", "video.json"];
const LOCAL_FILES = new Set(["inbox.json", "mcp.json", "server-token", "server.log", "autocrew.pid", "typesafe-key",
  "engine-health.json", STORAGE_CONFIG, PENDING_STORAGE]);
const LOCAL_DIRS = new Set(["tokens", "bridge", "libraries", "cache", "migrations"]);
// Unknown files stay at the source and are reported; a newly added secret can never silently go to NAS.
const DATA_DIRS = new Set(["assets", "brand-intros", "campaigns", "competitors", "contents", "conversations", "covers",
  "editorial-feedback", "exports", "inbox", "learnings", "library", "logs", "memory", "patterns", "pipeline", "pipelines",
  "reports", "research", "sensitive-words", "topics", "video", "workflows", "projects", "imports", ".obsidian"]);
const DATA_FILES = new Set(["STYLE.md", "cover-style.json", "creator-profile.json", "digest-state.json", "editorial-experiments.json",
  "events.jsonl", "hypotheses.jsonl", "outcomes.jsonl", "radar-rejects.json", "radar-sources.json", "recent-actions.json",
  "recent-turns.json", "topic-radar.json", "platform-items.json", "hooks.json"]);

type Operation = "create" | "open" | "migrate";
export interface StorageRequest { action: Operation; target: string }
export interface StoragePlan extends StorageRequest {
  source: string; sourceId: string | null; files: number; bytes: number; retained: string[]; externalReferences: number;
}
interface CopyItem { source: string; relative: string; size: number; config?: boolean }

export async function digestFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
}

async function walk(source: string, relative: string, items: CopyItem[], config = false): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`迁移遇到符号链接，请先确认其归属：${source}`);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(source)).sort()) await walk(path.join(source, name), path.join(relative, name), items, config);
  } else if (stat.isFile()) items.push({ source, relative, size: stat.size, ...(config ? { config } : {}) });
  else throw new Error(`不支持迁移的文件类型：${source}`);
}

async function inventory(): Promise<{ items: CopyItem[]; retained: string[] }> {
  const root = getLibraryRoot();
  const items: CopyItem[] = [], retained: string[] = [];
  if (readLibraryLocation()) {
    for (const name of await fs.readdir(root)) {
      if ([LIBRARY_MARKER, WRITER_LOCK, ".DS_Store"].includes(name)) continue;
      if (["workspaces", "workspaces.json", "shared-assets", "AutoCrew资料库说明.md"].includes(name)) await walk(path.join(root, name), name, items);
      else retained.push(name);
    }
    return { items, retained };
  }
  async function workspace(source: string, id: string): Promise<void> {
    for (const name of await fs.readdir(source)) {
      if (CONFIG_FILES.some((f) => name === f || name.startsWith(`${f}.`))) {
        await walk(path.join(source, name), path.join("workspaces", id, name), items, true);
      } else if (DATA_DIRS.has(name) || DATA_FILES.has(name)) {
        await walk(path.join(source, name), path.join("workspaces", id, name), items);
      } else if (!LOCAL_FILES.has(name) && !LOCAL_DIRS.has(name) && !["workspaces", "workspaces.json", ".DS_Store"].includes(name)) {
        retained.push(path.join(id, name));
      }
    }
  }
  await workspace(root, "default");
  const registry = path.join(root, "workspaces.json");
  if (await exists(registry)) await walk(registry, "workspaces.json", items);
  const workspaces = path.join(root, "workspaces");
  if (await exists(workspaces)) {
    for (const id of await fs.readdir(workspaces)) {
      if (!/^ws-[a-z0-9]+$/.test(id)) { retained.push(`workspaces/${id}`); continue; }
      await workspace(path.join(workspaces, id), id);
    }
  }
  return { items, retained };
}

async function validateTarget(req: StorageRequest): Promise<string> {
  if (!["create", "open", "migrate"].includes(req.action)) throw new Error("请选择新建、打开或迁移资料库");
  const target = canonicalTarget(req.target);
  const source = readLibraryLocation()?.root ?? getMachineDir();
  const machine = canonicalTarget(getMachineDir());
  const program = canonicalTarget(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  if (isWithin(program, target) || isWithin(target, program)) throw new Error("用户资料库必须放在 AutoCrew 程序目录之外");
  if (isWithin(source, target) || isWithin(target, source) || isWithin(machine, target) || isWithin(target, machine)) {
    throw new Error("资料库与现有资料、本机配置目录不能相互包含");
  }
  if (req.action === "open") {
    const manifest = JSON.parse(await fs.readFile(path.join(target, LIBRARY_MARKER), "utf8")) as LibraryManifest;
    assertLibraryAvailable({ ...manifest, root: target });
  } else {
    // An existing NAS account directory can be adopted without touching its other projects.
    for (const name of [LIBRARY_MARKER, "workspaces", "workspaces.json", "shared-assets", "AutoCrew资料库说明.md"]) {
      if (await exists(path.join(target, name))) throw new Error(`目标已有 ${name}，不会覆盖；已有资料库请使用“打开”。`);
    }
  }
  return target;
}

export async function previewStorage(req: StorageRequest): Promise<StoragePlan> {
  const target = await validateTarget(req);
  const { items, retained } = req.action === "migrate" ? await inventory() : { items: [], retained: [] };
  let externalReferences = 0;
  for (const item of items.filter((i) => /[/\\]library[/\\]assets[/\\].+\.json$/.test(i.relative))) {
    const record = JSON.parse(await fs.readFile(item.source, "utf8")) as { id?: string; path?: string };
    if (!record.path) throw new Error(`素材记录缺少路径：${item.relative}`);
    const file = path.isAbsolute(record.path) ? record.path : path.resolve(path.dirname(path.dirname(path.dirname(item.source))), record.path);
    const stat = await fs.stat(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
      throw new Error(`素材库有缺失文件（${record.id ?? item.relative}）：${file}。请先在素材库重新定位，再迁移。`);
    });
    if (!stat.isFile()) throw new Error(`素材引用不是文件：${file}`);
    if (!isWithin(getLibraryRoot(), file)) externalReferences++;
  }
  return { ...req, target, source: readLibraryLocation()?.root ?? getMachineDir(), sourceId: readLibraryLocation()?.id ?? null,
    files: items.filter((i) => !i.config).length, bytes: items.filter((i) => !i.config).reduce((n, i) => n + i.size, 0),
    retained, externalReferences };
}

export async function queueStorage(req: StorageRequest): Promise<StoragePlan> {
  const plan = await previewStorage(req);
  await fs.mkdir(getMachineDir(), { recursive: true });
  await writeJsonAtomic(path.join(getMachineDir(), PENDING_STORAGE), plan);
  return plan;
}

export async function storageStatus(): Promise<Record<string, unknown>> {
  let location: LibraryLocation | null = null, error: string | undefined;
  try { location = readLibraryLocation(); assertLibraryAvailable(location); }
  catch (err) { error = (err as Error).message; }
  let pending: StoragePlan | null = null;
  try { pending = JSON.parse(await fs.readFile(path.join(getMachineDir(), PENDING_STORAGE), "utf8")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") error ??= "待切换配置损坏"; }
  return { mode: location ? "library" : "legacy", root: location?.root ?? getMachineDir(), machineRoot: getMachineDir(),
    connected: !error, ...(error ? { error } : { dataRoot: resolveDataDir(), configRoot: getConfigDir() }), pending };
}

function mapInternalPath(value: string, source: string, target: string, legacy: boolean): string {
  if (value.includes("\n") || !path.isAbsolute(value) || !isWithin(source, value)) return value;
  const relative = path.relative(source, value);
  return path.join(target, ...(legacy && !relative.startsWith(`workspaces${path.sep}`) ? ["workspaces", "default"] : []), relative);
}

/** Rewrites structured absolute paths only; prose, prompts, URLs and original files are untouched. */
function relocate(value: unknown, source: string, target: string, legacy: boolean): unknown {
  if (typeof value === "string") return mapInternalPath(value, source, target, legacy);
  if (Array.isArray(value)) return value.map((v) => relocate(v, source, target, legacy));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v, source, target, legacy)]));
  return value;
}

/** Called only with the daemon stopped. Publish the manifest and pointer last. */
export async function applyPendingStorage(onProgress?: (copied: number, total: number) => void): Promise<StoragePlan | null> {
  const pendingFile = path.join(getMachineDir(), PENDING_STORAGE);
  if (!await exists(pendingFile)) return null;
  const pidFile = path.join(getMachineDir(), "autocrew.pid");
  if (await exists(pidFile)) {
    const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("服务进程记录无效，请先检查运行状态");
    let alive = true;
    try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw err; }
    if (alive) throw new Error("请先停止 AutoCrew 服务，再应用资料库迁移");
  }
  const plan = JSON.parse(await fs.readFile(pendingFile, "utf8")) as StoragePlan;
  if (plan.source !== (readLibraryLocation()?.root ?? getMachineDir()) || plan.sourceId !== (readLibraryLocation()?.id ?? null)) throw new Error("源资料库已改变，请重新预览迁移");
  const target = await validateTarget(plan);
  const releaseSource = plan.action === "migrate" ? acquireLibraryLock() : () => {};
  await fs.mkdir(target, { recursive: true });
  let releaseTarget: () => void;
  try { releaseTarget = acquireLibraryLock(target); }
  catch (err) { releaseSource(); throw err; }
  const old = readLibraryLocation();
  const id = plan.action === "open"
    ? (JSON.parse(await fs.readFile(path.join(target, LIBRARY_MARKER), "utf8")) as LibraryManifest).id
    : (plan.action === "migrate" ? old?.id : undefined) ?? `lib-${randomUUID()}`;
  const stage = path.join(target, `.autocrew-migration-${randomUUID()}`);
  const checks: Array<{ file: string; sourceHash: string; storedHash: string; bytes: number }> = [];
  let published = false;
  const sourceChecks: Array<{ file: string; hash: string }> = [];
  try {
    if (plan.action !== "open") {
      await fs.mkdir(stage);
      const transferIdentity = randomUUID();
      const transferMarker = path.join(stage, ".transfer-identity");
      await fs.writeFile(transferMarker, transferIdentity, { flag: "wx" });
      const checkDestination = async () => {
        if (await fs.readFile(transferMarker, "utf8").catch(() => "") !== transferIdentity) throw new Error("迁移目标断开或被替换，停止写入");
      };
      const { items } = plan.action === "migrate" ? await inventory() : { items: [] };
      for (const item of items) {
        await checkDestination();
        const dest = item.config ? path.join(getMachineDir(), "libraries", id, item.relative) : path.join(stage, item.relative);
        if (await exists(dest)) throw new Error(`目标已存在，停止迁移：${item.relative}`);
        await fs.mkdir(path.dirname(dest), { recursive: true, ...(item.config ? { mode: 0o700 } : {}) });
        const before = await digestFile(item.source);
        await fs.copyFile(item.source, dest, fs.constants.COPYFILE_EXCL);
        if (item.config) await fs.chmod(dest, 0o600);
        if (await digestFile(dest) !== before || await digestFile(item.source) !== before) throw new Error(`文件校验失败或源文件仍在变化：${item.relative}`);
        if (!item.config && /\.jsonl?$/.test(dest)) {
          const text = await fs.readFile(dest, "utf8");
          const remap = (s: string): string => {
            const original = JSON.parse(s);
            const mapped = relocate(original, plan.source, target, !old);
            // Relocating a library must not reformat immutable briefs, versions
            // or receipts that contain no affected path. Keep their exact bytes.
            return JSON.stringify(original) === JSON.stringify(mapped) ? s : JSON.stringify(mapped);
          };
          const transformed = dest.endsWith(".jsonl")
            ? text.split("\n").map((line) => line.trim() ? remap(line) : line).join("\n")
            : remap(text);
          if (transformed !== text) await fs.writeFile(dest, transformed);
          // Library asset paths are portable; outside originals are copied into the managed library.
          if (/[/\\]library[/\\]assets[/\\].+\.json$/.test(dest)) {
            const record = JSON.parse(await fs.readFile(dest, "utf8")) as { id: string; path: string; storage?: string };
            if (!/^asset-\d+-[a-z0-9]+$/.test(record.id) || typeof record.path !== "string") throw new Error(`素材记录无效：${item.relative}`);
            const workspaceRoot = path.dirname(path.dirname(path.dirname(dest)));
            const finalWorkspace = path.join(target, path.relative(stage, workspaceRoot));
            if (path.isAbsolute(record.path) && isWithin(finalWorkspace, record.path)) record.path = path.relative(finalWorkspace, record.path);
            else if (path.isAbsolute(record.path)) {
              const assetDest = path.join(workspaceRoot, "library", "media", record.id + path.extname(record.path));
              await fs.mkdir(path.dirname(assetDest), { recursive: true });
              const hash = await digestFile(record.path);
              await fs.copyFile(record.path, assetDest, fs.constants.COPYFILE_EXCL);
              if (await digestFile(assetDest) !== hash || await digestFile(record.path) !== hash) throw new Error("外部素材校验失败");
              checks.push({ file: path.relative(stage, assetDest), sourceHash: hash, storedHash: hash, bytes: (await fs.stat(assetDest)).size });
              record.path = path.relative(workspaceRoot, assetDest);
              record.storage = "managed";
            }
            await writeJsonAtomic(dest, record);
          }
        }
        sourceChecks.push({ file: item.source, hash: before });
        if (!item.config) checks.push({ file: item.relative, sourceHash: before, storedHash: await digestFile(dest), bytes: (await fs.stat(dest)).size });
        onProgress?.(sourceChecks.length, items.length);
      }
      for (const folder of ["topics", ...(plan.action === "create" ? [] : ["contents"]), "library", "research", "reports", "projects"]) await fs.mkdir(path.join(stage, "workspaces", "default", folder), { recursive: true });
      if (plan.action === "create") await initializeProjectLayout(path.join(stage, "workspaces", "default"), id, "default");
      await fs.mkdir(path.join(stage, "shared-assets"), { recursive: true });
      const guide = path.join(stage, "AutoCrew资料库说明.md");
      if (!await exists(guide)) await fs.writeFile(guide, "# AutoCrew 用户资料库\n\nworkspaces/ 每个运营主体独立保存定位、选题、内容、素材、研究、剪辑工程和复盘。shared-assets/ 保存跨主体通用素材。\n\n内容使用稳定编号与原有状态机；多平台稿件继续通过 topicId/siblings 关联。活动资料库可放本地或 NAS；完成项目的 NAS 归档按当前用户约定执行，复制、恢复验证和清理分别记录。密钥、登录态、服务日志和连接配置保留在本机。\n\n请通过 AutoCrew 导入素材，避免直接改动内容编号或元数据。已有年份归档目录保持原样。\n");
      // A background writer outside the daemon must not turn the copy into a mixed snapshot.
      if (plan.action === "migrate") {
        const fresh = (await inventory()).items.map((i) => i.source).sort();
        if (JSON.stringify(fresh) !== JSON.stringify(sourceChecks.map((i) => i.file).sort())) throw new Error("迁移期间源目录文件清单发生变化");
        for (const entry of sourceChecks) if (await digestFile(entry.file) !== entry.hash) throw new Error(`迁移期间源文件发生变化：${entry.file}`);
      }
      await checkDestination();
      await fs.unlink(transferMarker);
      // The target can contain unrelated yearly archives, but none of these names may collide.
      for (const name of await fs.readdir(stage)) if (await exists(path.join(target, name))) throw new Error(`迁移期间目标出现同名文件：${name}`);
      for (const name of await fs.readdir(stage)) await fs.rename(path.join(stage, name), path.join(target, name));
      await writeJsonAtomic(path.join(target, LIBRARY_MARKER), { version: 1, id, createdAt: new Date().toISOString() } satisfies LibraryManifest);
      published = true;
    }
    const location: LibraryLocation = { version: 1, id, root: target };
    assertLibraryAvailable(location);
    const reportDir = path.join(getMachineDir(), "migrations");
    await fs.mkdir(reportDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path.join(reportDir, `${Date.now()}.json`), { ...plan, libraryId: id, completedAt: new Date().toISOString(), checks, previousLocation: old });
    await writeJsonAtomic(path.join(getMachineDir(), STORAGE_CONFIG), location);
    await fs.rm(pendingFile);
    return plan;
  } catch (err) {
    throw new Error(`资料库切换未完成，原位置仍保留。${published ? "目标已复制完成，可核查后选择打开。" : `中间文件保留在 ${stage} 供恢复。`} ${(err as Error).message}`);
  } finally {
    await fs.rmdir(stage).catch(() => {});
    releaseTarget(); releaseSource();
  }
}
